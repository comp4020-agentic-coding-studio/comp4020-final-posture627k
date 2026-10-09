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
    });
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
        match = s.ok ? s.body : null;
        if (!s.ok) message = s.body.error || "Could not load the match";
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
    var parts = [e.type.replace(/_/g, " ")];
    ["actor", "target", "seat", "cardType", "cardsDrawn", "winningTeam", "responseType"].forEach(function (k) {
      if (e[k] !== undefined) parts.push(k === "actor" || k === "target" || k === "seat" ? k + " " + e[k] : String(e[k]));
    });
    return parts.join(" · ");
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
      return el("div", { class: "seat" + (p.seat === match.activeSeat && !done ? " active" : "") + (p.seat === match.viewerSeat ? " me" : "") + (p.eliminated ? " out" : "") }, [
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
      el("div", { class: "hand", id: "hand" }, ((me && me.hand) || []).map(function (c) { return el("div", { class: "card" }, [CARD_NAMES[c.type] || c.type]); })),
      el("p", { class: "muted" }, ["Playing cards arrives in the next update."]),
    ]));
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
