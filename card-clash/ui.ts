// Card Clash browser UI (D5A): one self-contained server-rendered page with
// inline CSS and vanilla JS — no build step and no separate asset files, so
// it ships in the existing Docker image with the rest of card-clash/. All
// decisions stay server-authoritative: the page only calls the existing
// /api/card-clash routes with the caller's own cookie and renders what the
// server returns. Untrusted strings are only ever written via textContent.

const CSS = `
:root{--bg:#0b1220;--panel:#141e30;--border:#263249;--text:#e7ecf3;--muted:#93a1b8;--accent:#22c55e;--accent-text:#052e16;--danger:#ef4444;--card:#f8fafc;--card-text:#111827;--back:#27405f;--focus:#7dd3fc}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:960px;margin:0 auto;padding:16px}
h1{margin:0 0 12px}h2{margin:0 0 8px;font-size:1.1rem}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button,select,input{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:#1b2842;color:var(--text)}
button{cursor:pointer}button.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent);font-weight:600}
button:disabled{opacity:.5;cursor:not-allowed}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.muted{color:var(--muted)}.error{color:var(--danger)}
.seats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.seat{border:1px solid var(--border);border-radius:10px;padding:10px;background:#101a2c}
.seat.active{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.seat.me{background:#15233b}.seat.out{opacity:.5}
.badge{display:inline-block;padding:0 8px;border-radius:99px;border:1px solid var(--border);font-size:.8rem;margin-left:4px}
.hand{display:flex;flex-wrap:wrap;gap:8px}
.card{background:var(--card);color:var(--card-text);border-radius:8px;padding:10px 12px;min-width:86px;text-align:center;font-weight:600}
.back{display:inline-block;width:28px;height:40px;border-radius:5px;background:var(--back);border:1px solid #3d577a;margin-right:3px}
.seat.responding{border-color:#f59e0b;box-shadow:0 0 0 1px #f59e0b}
button[aria-pressed=true]{outline:2px solid var(--accent)}
.card button{background:transparent;color:inherit;border:0;padding:0;font-weight:600}
.log{max-height:220px;overflow:auto;margin:0;padding-left:20px}
.countdown{font-size:1.4rem;font-weight:700}
@media (max-width:600px){main{padding:10px}.seats{grid-template-columns:1fr 1fr}}
`;

const SCRIPT = `
(function () {
  var CARD_NAMES = { attack: "Attack", dodge: "Dodge", heal: "Heal", seize: "Seize", disarm: "Disarm", insight: "Insight", war_cry: "War Cry", arrow_volley: "Arrow Volley" };
  var SEATS = { "1v1": 2, "1v2": 3, "2v2": 4 };
  var root = document.getElementById("app");
  var code = new URLSearchParams(location.search).get("room");
  var room = null, match = null, es = null, esCode = null;
  var busy = false, targeting = null, selected = {};
  var message = "", deadlineTimer = null, deadlineRefetch = null, requestSeq = 0;

  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === "class") n.className = props[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), props[k]);
      else if (k === "disabled") n.disabled = !!props[k];
      else n.setAttribute(k, props[k]);
    }
    (kids || []).forEach(function (c) { n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function teamFor(mode, seat) {
    if (mode === "2v2") return seat === 1 || seat === 4 ? "A" : "B";
    return seat === 1 ? "A" : "B";
  }
  function api(method, path, body) {
    var init = { method: method, headers: {}, credentials: "same-origin" };
    if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
    }, function () { return { ok: false, status: 0, body: { error: "network_error" } }; });
  }
  function base() { return "/api/card-clash/rooms/" + encodeURIComponent(code); }

  function setCode(c) {
    code = c;
    history.replaceState(null, "", "/card-clash?room=" + encodeURIComponent(c));
  }

  function refresh() {
    if (!code) { render(); return Promise.resolve(); }
    var seq = ++requestSeq;
    return api("GET", base()).then(function (r) {
      if (seq !== requestSeq) return;
      if (!r.ok) { room = null; match = null; message = r.body.error || "Room not found"; render(); return; }
      room = r.body;
      if (room.viewerSeat !== null) connect();
      if (room.status === "waiting") { match = null; render(); return; }
      if (room.viewerSeat === null) { match = null; message = "This room has already started."; render(); return; }
      return api("GET", base() + "/state").then(function (s) {
        if (seq !== requestSeq) return;
        if (s.ok && match && match.matchId === s.body.matchId && s.body.version < match.version) return; // never go backwards
        var changed = !match || !s.ok || s.body.version !== match.version;
        match = s.ok ? s.body : null;
        if (changed) { targeting = null; selected = {}; }
        if (!s.ok) message = s.body.error === "network_error" ? "Connection problem — will refresh when reconnected." : (s.body.error || "Could not load the match");
        render();
      });
    });
  }

  function connect() {
    if (es && esCode === code) return;
    if (es) es.close();
    esCode = code;
    es = new EventSource(base() + "/events");
    es.addEventListener("ready", refresh);
    es.addEventListener("invalidate", refresh);
  }

  function act(path, body) {
    message = "";
    return api("POST", base() + path, body).then(function (r) {
      if (!r.ok) message = r.body.error || "Request failed";
      return refresh();
    });
  }

  function newRequestId() {
    var c = window.crypto;
    if (c && c.randomUUID) return c.randomUUID();
    return "r-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }

  // One state-changing request at a time, each with a fresh requestId for a
  // genuinely NEW action and the latest authoritative version. A failed or
  // uncertain request is never retried automatically.
  function send(type, extra) {
    if (busy || !match) return;
    busy = true;
    message = "";
    var body = { type: type, requestId: newRequestId(), expectedVersion: match.version };
    for (var k in (extra || {})) body[k] = extra[k];
    render();
    return api("POST", base() + "/actions", body).then(function (r) {
      if (!r.ok) {
        var e = r.body.error;
        if (e === "stale_version" || e === "deadline_expired") message = "The action window has passed — the board was refreshed. Choose again.";
        else if (e === "network_error") message = "Connection problem — the action may not have been applied. The board will refresh.";
        else if (e === "transition_rejected") message = "That move is not allowed: " + String(r.body.detail || "illegal action").replace(/_/g, " ") + ".";
        else message = (e || "Request failed").replace(/_/g, " ");
      }
      targeting = null; selected = {};
      busy = false;
      return refresh();
    });
  }

  function count(hand, type) { return hand.filter(function (c) { return c.type === type; }).length; }
  function btn(id, label, onclick, disabled) {
    return el("button", { id: "act-" + id, disabled: busy || disabled, onclick: onclick }, [label]);
  }
  function others(me) { return match.players.filter(function (p) { return p.seat !== me.seat && !p.eliminated; }); }

  function controls(me) {
    var done = match.matchResult.status === "complete";
    var kids = [];
    var hand = me.hand || [];
    var pending = match.pending;
    if (done) return [el("p", { class: "muted" }, ["The match is over."])];
    if (me.eliminated) return [el("p", { class: "muted", id: "spectating" }, ["You are eliminated — spectating."])];

    function waiting(text) { return el("p", { class: "muted", id: "waiting" }, [text]); }

    if (pending && pending.kind === "attack_response") {
      if (pending.target !== me.seat) return [waiting("Seat " + pending.target + " must respond to the Attack from seat " + pending.attacker + ".")];
      kids.push(el("p", null, ["Seat " + pending.attacker + " attacked you. Play Dodge or take 1 damage."]));
      kids.push(btn("respond_dodge", "Dodge", function () { send("respond_dodge"); }, count(hand, "dodge") === 0));
      kids.push(btn("decline_attack_response", "Decline (take damage)", function () { send("decline_attack_response"); }));
      return [el("div", { class: "row" }, kids)];
    }
    if (pending && pending.kind === "group_response") {
      var ctx = pending.context, who = ctx.queue[0];
      var card = ctx.cardType === "war_cry" ? "War Cry" : "Arrow Volley";
      if (who !== me.seat) return [waiting("Seat " + who + " must respond to " + card + " from seat " + ctx.actor + ".")];
      var need = ctx.requiredResponseType;
      kids.push(el("p", null, [card + " from seat " + ctx.actor + ": play " + (need === "attack" ? "an Attack" : "a Dodge") + " or take 1 damage."]));
      kids.push(btn(need === "attack" ? "respond_group_attack" : "respond_group_dodge", need === "attack" ? "Play Attack" : "Play Dodge",
        function () { send(need === "attack" ? "respond_group_attack" : "respond_group_dodge"); }, count(hand, need) === 0));
      kids.push(btn("decline_group_response", "Decline (take damage)", function () { send("decline_group_response"); }));
      return [el("div", { class: "row" }, kids)];
    }
    if (pending && pending.kind === "dying_rescue") {
      var rescuer = pending.queue[0];
      if (rescuer !== me.seat) return [waiting("Seat " + pending.dyingSeat + " is dying. Waiting on seat " + rescuer + " to rescue.")];
      kids.push(el("p", { id: "rescue-note" }, ["Seat " + pending.dyingSeat + " is dying" + (pending.dyingSeat === me.seat ? " (you)" : "") + ". Play Heal to save them?"]));
      kids.push(btn("rescue_heal", "Heal", function () { send("rescue_heal"); }, count(hand, "heal") === 0));
      kids.push(btn("decline_rescue", "Decline", function () { send("decline_rescue"); }));
      return [el("div", { class: "row" }, kids)];
    }
    if (match.activeSeat !== me.seat) return [waiting("Waiting for seat " + match.activeSeat + " to play.")];

    if (match.turnPhase === "discard") {
      var excess = hand.length - me.hp;
      var ids = Object.keys(selected).filter(function (k) { return selected[k]; });
      kids.push(el("p", { id: "discard-note" }, ["DISCARD: choose " + Math.max(0, excess) + " card(s) to discard (hand limit = HP " + me.hp + ")."]));
      kids.push(btn("discard_cards", "Discard selected (" + ids.length + ")", function () { send("discard_cards", { cardIds: ids }); }, ids.length === 0));
      return [el("div", { class: "row" }, kids)];
    }

    var limit = match.mode === "1v2" && me.seat === 1 ? 2 : 1;
    var living = others(me);
    if (targeting) {
      var pool = living.filter(function (p) { return targeting === "play_attack" || p.handSize > 0; });
      kids.push(el("p", null, ["Choose a target for " + targeting.replace("play_", "").replace(/_/g, " ") + ":"]));
      pool.forEach(function (p) {
        kids.push(el("button", { id: "target-" + p.seat, disabled: busy, onclick: function () { var t = targeting; send(t, { targetSeat: p.seat }); } }, ["Seat " + p.seat + " (Team " + p.team + ")"]));
      });
      if (pool.length === 0) kids.push(el("span", { class: "muted" }, ["No valid targets."]));
      kids.push(el("button", { id: "cancel-target", onclick: function () { targeting = null; render(); } }, ["Cancel"]));
      return [el("div", { class: "row" }, kids)];
    }
    var t = function (type) { return function () { targeting = type; render(); }; };
    kids.push(btn("play_attack", "Attack", t("play_attack"), count(hand, "attack") === 0 || match.normalAttacksUsedThisTurn >= limit || living.length === 0));
    kids.push(btn("play_heal", "Heal (self)", function () { send("play_heal"); }, count(hand, "heal") === 0 || me.hp >= me.maxHp));
    kids.push(btn("play_seize", "Seize", t("play_seize"), count(hand, "seize") === 0 || !living.some(function (p) { return p.handSize > 0; })));
    kids.push(btn("play_disarm", "Disarm", t("play_disarm"), count(hand, "disarm") === 0 || !living.some(function (p) { return p.handSize > 0; })));
    kids.push(btn("play_war_cry", "War Cry", function () { send("play_war_cry"); }, count(hand, "war_cry") === 0));
    kids.push(btn("play_arrow_volley", "Arrow Volley", function () { send("play_arrow_volley"); }, count(hand, "arrow_volley") === 0));
    kids.push(btn("play_insight", "Insight (draw 2)", function () { send("play_insight"); }, count(hand, "insight") === 0));
    kids.push(btn("end_turn", "End Turn", function () { send("end_turn"); }));
    return [el("p", { class: "muted" }, ["Your turn (MAIN). Dodge is only played in response."]), el("div", { class: "row" }, kids)];
  }

  function lobbyEntry() {
    var mode = el("select", { id: "mode", "aria-label": "Game mode" }, ["1v1", "1v2", "2v2"].map(function (m) { return el("option", { value: m }, [m]); }));
    var input = el("input", { id: "room-code", placeholder: "Room code", "aria-label": "Room code", maxlength: "16" });
    return el("div", { class: "panel" }, [
      el("h2", null, ["Create a room"]),
      el("div", { class: "row" }, [mode, el("button", { class: "primary", id: "create", onclick: function () {
        api("POST", "/api/card-clash/rooms", { mode: mode.value }).then(function (r) {
          if (!r.ok) { message = r.body.error || "Could not create room"; render(); return; }
          message = ""; setCode(r.body.code); refresh();
        });
      } }, ["Create Room"])]),
      el("h2", { style: "margin-top:14px" }, ["Join a room"]),
      el("div", { class: "row" }, [input, el("button", { id: "join", onclick: function () {
        var c = input.value.trim().toUpperCase();
        if (!c) return;
        setCode(c);
        api("POST", base() + "/join", {}).then(function (r) {
          if (!r.ok) message = r.body.error || "Could not join";
          else message = "";
          refresh();
        });
      } }, ["Join Room"])]),
    ]);
  }

  function lobbyRoom() {
    var need = SEATS[room.mode];
    var taken = {};
    room.seats.forEach(function (s) { taken[s.seatNumber] = s; });
    var kids = [];
    for (var n = 1; n <= need; n++) {
      var s = taken[n];
      kids.push(el("div", { class: "seat" + (room.viewerSeat === n ? " me" : "") }, [
        el("strong", null, ["Seat " + n]),
        el("span", { class: "badge" }, ["Team " + teamFor(room.mode, n)]),
        n === 1 ? el("span", { class: "badge" }, ["Host"]) : "",
        el("div", { class: "muted" }, [s ? (s.ready ? "Ready" : "Not ready") : "Empty"]),
        room.viewerSeat === n ? el("div", null, ["(you)"]) : "",
      ]));
    }
    var link = location.origin + "/card-clash?room=" + encodeURIComponent(room.code);
    var mySeat = taken[room.viewerSeat];
    var allReady = room.seats.length === need && room.seats.every(function (s) { return s.ready; });
    var controls = [];
    if (room.viewerSeat === null) {
      controls.push(el("button", { class: "primary", id: "join-here", onclick: function () { act("/join", {}); } }, ["Join this room"]));
    } else {
      controls.push(el("button", { id: "ready", onclick: function () { act("/ready", { ready: !(mySeat && mySeat.ready) }); } }, [mySeat && mySeat.ready ? "Not ready" : "Ready"]));
      if (room.viewerSeat === 1) {
        controls.push(el("button", { class: "primary", id: "start", disabled: !allReady, onclick: function () { act("/start", {}); } }, ["Start Game"]));
      }
    }
    return el("div", { class: "panel" }, [
      el("h2", null, ["Room " + room.code + " (" + room.mode + ")"]),
      el("div", { class: "seats" }, kids),
      el("div", { class: "row", style: "margin-top:10px" }, [
        el("input", { id: "invite", readonly: "readonly", value: link, "aria-label": "Invite link", size: "36" }),
        el("button", { id: "copy", onclick: function () {
          if (navigator.clipboard) navigator.clipboard.writeText(link).then(function () { message = "Invite link copied."; render(); });
          else { document.getElementById("invite").select(); message = "Press Ctrl+C to copy."; render(); }
        } }, ["Copy Invite Link"]),
      ].concat(controls)),
    ]);
  }

  function describeEvent(e) {
    var S = function (n) { return "Seat " + n; };
    switch (e.type) {
      case "attack_played": return S(e.actor) + " attacked " + S(e.target);
      case "dodge_played": return S(e.actor) + " played Dodge";
      case "attack_response_declined": return S(e.actor) + " took the hit";
      case "heal_played": return S(e.actor) + " healed " + (e.target === e.actor ? "themself" : S(e.target));
      case "rescue_declined": return S(e.actor) + " declined to rescue";
      case "eliminated": return S(e.seat) + " was eliminated";
      case "match_complete": return "Team " + e.winningTeam + " wins";
      case "seize_played": return S(e.actor) + " seized a card from " + S(e.target);
      case "disarm_played": return S(e.actor) + " disarmed " + S(e.target);
      case "disarm_card_revealed": return S(e.target) + " lost a " + (CARD_NAMES[e.cardType] || e.cardType);
      case "insight_played": return S(e.actor) + " played Insight (drew " + e.cardsDrawn + ")";
      case "group_card_played": return S(e.actor) + " played " + (CARD_NAMES[e.cardType] || e.cardType);
      case "group_response_played": return S(e.actor) + " responded with " + e.responseType;
      case "group_response_declined": return S(e.actor) + " took the damage";
    }
    return e.type.replace(/_/g, " ");
  }
  function phaseText() {
    if (match.matchResult.status === "complete") return "Finished";
    if (match.pending) return "Response: " + match.pending.kind.replace(/_/g, " ");
    return match.turnPhase === "discard" ? "DISCARD" : "MAIN";
  }

  function board() {
    var out = [];
    var done = match.matchResult.status === "complete";
    var deadline = match.deadline;
    out.push(el("div", { class: "panel" }, [
      el("h2", null, ["Room " + room.code + " · " + match.mode]),
      el("div", { class: "row" }, [
        el("span", null, ["Phase: "]), el("strong", { id: "phase" }, [phaseText()]),
        el("span", null, ["Active seat: "]), el("strong", { id: "active" }, [String(match.activeSeat)]),
        done ? el("strong", { id: "winner" }, ["Winner: Team " + match.matchResult.winningTeam]) : "",
      ]),
      !done && deadline ? el("div", null, [el("span", { class: "muted" }, ["Waiting on seat " + deadline.responderSeat + " — "]), el("span", { class: "countdown", id: "countdown", "data-expires": String(deadline.expiresAt) }, [""])]) : "",
      !done && !deadline ? el("div", { class: "muted" }, ["No timer running."]) : "",
    ]));
    var seats = el("div", { class: "seats" }, match.players.map(function (p) {
      var backs = [];
      if (p.seat !== match.viewerSeat) for (var i = 0; i < p.handSize; i++) backs.push(el("span", { class: "back", "aria-hidden": "true" }, []));
      var responding = !done && match.deadline && match.deadline.responderSeat === p.seat && match.pending;
      return el("div", { class: "seat" + (responding ? " responding" : "") + (p.seat === match.activeSeat && !done ? " active" : "") + (p.seat === match.viewerSeat ? " me" : "") + (p.eliminated ? " out" : "") }, [
        el("strong", null, ["Seat " + p.seat]),
        el("span", { class: "badge" }, ["Team " + p.team]),
        p.seat === match.viewerSeat ? el("span", { class: "badge" }, ["you"]) : "",
        el("div", null, ["HP " + p.hp + "/" + p.maxHp + (p.eliminated ? " (eliminated)" : "")]),
        el("div", null, ["Cards: " + p.handSize]),
        el("div", null, backs),
      ]);
    }));
    out.push(el("div", { class: "panel" }, [el("h2", null, ["Players"]), seats]));
    var me = match.players.filter(function (p) { return p.seat === match.viewerSeat; })[0];
    out.push(el("div", { class: "panel" }, [
      el("h2", null, ["Your hand"]),
      el("div", { class: "hand", id: "hand" }, ((me && me.hand) || []).map(function (c) {
        var inDiscard = match.turnPhase === "discard" && !match.pending && me.seat === match.activeSeat && !done;
        if (!inDiscard) return el("div", { class: "card" }, [CARD_NAMES[c.type] || c.type]);
        return el("div", { class: "card" }, [el("button", { id: "card-" + c.id, "aria-pressed": selected[c.id] ? "true" : "false", disabled: busy, onclick: function () { selected[c.id] = !selected[c.id]; render(); } }, [CARD_NAMES[c.type] || c.type])]);
      })),
    ]));
    out.push(el("div", { class: "panel", id: "controls" }, [el("h2", null, ["Actions"])].concat(me ? controls(me) : [])));
    out.push(el("div", { class: "panel" }, [el("h2", null, ["Discard pile"]),
      el("div", { class: "muted", id: "discards" }, [match.discardPile.length + " card(s). Latest: " + match.discardPile.slice(-8).map(function (c) { return CARD_NAMES[c.type] || c.type; }).join(", ")])]));
    out.push(el("div", { class: "panel" }, [
      el("h2", null, ["Events"]),
      el("ol", { class: "log", id: "log" }, match.publicLog.slice(-30).map(function (e) { return el("li", null, [describeEvent(e)]); })),
    ]));
    return out;
  }

  function tickCountdown() {
    var c = document.getElementById("countdown");
    if (!c) return;
    var ms = Math.max(0, Number(c.getAttribute("data-expires")) - Date.now());
    c.textContent = (ms / 1000).toFixed(1) + "s";
  }

  function render() {
    clearInterval(deadlineTimer);
    clearTimeout(deadlineRefetch);
    root.textContent = "";
    root.appendChild(el("h1", null, ["Card Clash"]));
    if (message) root.appendChild(el("p", { class: "error", role: "alert", id: "message" }, [message]));
    if (!room) root.appendChild(lobbyEntry());
    else if (match) board().forEach(function (n) { root.appendChild(n); });
    else root.appendChild(lobbyRoom());
    if (match && match.deadline && match.matchResult.status !== "complete") {
      tickCountdown();
      deadlineTimer = setInterval(tickCountdown, 250);
      // One refetch just after expiry: the server applies the timeout (and
      // normally pushes an SSE invalidation first); this is not polling.
      deadlineRefetch = setTimeout(refresh, Math.max(0, match.deadline.expiresAt - Date.now()) + 750);
    }
  }

  window.__cardClash = { refresh: refresh };
  refresh();
})();
`;

export function renderCardClashPage(): string {
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Card Clash</title>
<style>${CSS}</style>
</head>
<body>
<main><div id="app"></div></main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
