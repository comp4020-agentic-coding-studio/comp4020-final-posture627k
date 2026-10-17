// Card Clash browser UI: one self-contained server-rendered page with
// inline CSS and vanilla JS — no build step, no separate stylesheet. All
// decisions stay server-authoritative: the page only calls the existing
// /api/card-clash routes with the caller's own cookie and renders what the
// server returns. Untrusted strings are only ever written via textContent
// (SVG attributes are only ever set from constants in this file).
//
// Art direction, "The Knight's War Table": an original medieval tournament
// hall. Three depth layers —
//   1. Hall: the original castle-hall painting (served by the allowlisted
//      /card-clash/environment/castle-hall route), fixed behind the lobby.
//   2. Table: the original war-table painting, shown at its own aspect
//      ratio with cover scaling so live overlays (phase/timer on the painted compass, pile
//      counts on the painted decks, opponents on the far rim) stay pinned
//      to the painted features. The fan sits in the viewport foreground.
//   3. Cards and play feedback: painted WebP illustrations (served by the
//      allowlisted /card-clash/art/:type route in server.ts) inside layered
//      brass/parchment frames; drop targets light up only while dragging.
//
// Interaction: cards are the primary input. A playable hand card is a real
// <button> (click/tap/keyboard) and a Pointer Events drag source; dropping it on a
// seat or the table submits the same payload as the compact fallback
// buttons. Every path calls the single send() — no new action semantics.

const CSS = `
:root{
  --ink:#2c2016;--ink-soft:#5b4834;
  --ivory:#f4e7c8;--parch:#ead7aa;--parch-deep:#d9bd86;--parch-edge:#b8955a;
  --oak:#5a3a22;--oak-dark:#3a2414;--oak-deep:#24160b;--oak-light:#7a5233;
  --brass:#b08a44;--brass-hi:#e2c47e;--brass-lo:#7d5f2a;
  --stone:#2a2420;--stone-hi:#3b332c;
  --red:#9a2f36;--red-hi:#c2454c;--red-lo:#5e1a1f;
  --blue:#355d7d;--blue-hi:#5385ab;--blue-lo:#1e3549;
  --green:#3f6a43;--green-hi:#5d9161;
  --urgent:#d1453c;
  --focus:#ffd479;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
  --sans:"Trebuchet MS","Segoe UI",system-ui,sans-serif;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{color:var(--ivory);font:15px/1.45 var(--sans);background:var(--oak-deep);overflow:hidden}
main{display:block;height:100vh;height:100dvh;position:relative}
button,select,input{font:inherit}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none !important;transition:none !important}}

/* ===== Layer 1: the hall =================================================== */
/* The painting is a real <img> with object-fit:cover, so it is never
   stretched; object-position keeps the central arch in frame on any aspect. */
.hall{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;background:#1d150f}
.hall img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 40%;user-select:none;-webkit-user-drag:none}
/* Readability veil: darkens the edges and floor, leaves the arch luminous. */
.hall::after{content:"";position:absolute;inset:0;
  background:radial-gradient(ellipse 70% 60% at 50% 32%, transparent 35%, rgba(12,7,3,.45) 100%),linear-gradient(180deg,rgba(12,7,3,.15),transparent 30%,rgba(12,7,3,.35) 75%,rgba(12,7,3,.6))}
body.in-battle .hall{display:none}
body.in-battle{overflow:hidden}
body.in-battle .error{position:fixed;z-index:20;left:50%;top:34px;transform:translateX(-50%);width:max-content;max-width:90vw}

#app{position:relative;z-index:1;height:100%;display:flex;flex-direction:column}

/* ===== Shared controls ===================================================== */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;
  padding:9px 16px;border-radius:5px;border:1px solid var(--oak);font-weight:600;
  background:linear-gradient(180deg,#f6ead0,#e0c895);color:var(--ink);
  box-shadow:0 2px 0 var(--oak-dark),inset 0 1px 0 rgba(255,255,255,.6);transition:transform .12s,box-shadow .12s,filter .12s}
.btn:hover:not(:disabled){filter:brightness(1.05);transform:translateY(-1px)}
.btn:active:not(:disabled){transform:translateY(1px);box-shadow:0 1px 0 var(--oak-dark)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.primary{background:linear-gradient(180deg,#c2454c,#8a262d);color:#fff4df;border-color:#5e1a1f;text-shadow:0 1px 0 rgba(0,0,0,.35);box-shadow:0 2px 0 #3e1014,inset 0 1px 0 rgba(255,255,255,.25)}
.btn.gold{background:linear-gradient(180deg,#e9cd86,#b08a44);color:var(--oak-deep);border-color:var(--brass-lo)}
.btn.ghost{background:rgba(244,231,200,.08);color:var(--ivory);border-color:rgba(226,196,126,.4);box-shadow:none}
.btn.small{padding:6px 11px;font-size:.82rem}
.btn.big{padding:13px 26px;font-size:1.05rem;letter-spacing:.02em}
.field{padding:10px 12px;border-radius:5px;border:1px solid var(--parch-edge);background:#fbf3df;color:var(--ink);box-shadow:inset 0 2px 3px rgba(60,40,20,.18)}
.error{margin:10px auto 0;max-width:720px;padding:9px 14px;border-radius:5px;color:#fff1e0;background:linear-gradient(180deg,#9a2f36,#6e1f25);border:1px solid #c2454c;box-shadow:0 4px 12px rgba(0,0,0,.4);text-align:center}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* Parchment plaque: the one reusable "mounted document" surface. */
.plaque{position:relative;color:var(--ink);border-radius:8px;
  background:
    radial-gradient(ellipse at 30% 20%, rgba(255,255,255,.35), transparent 60%),
    linear-gradient(180deg,var(--ivory),var(--parch-deep));
  border:1px solid var(--brass-lo);
  box-shadow:0 0 0 4px var(--oak),0 0 0 5px var(--brass-lo),0 14px 30px rgba(0,0,0,.55),inset 0 0 22px rgba(120,80,30,.22)}
.plaque::before,.plaque::after{content:"";position:absolute;width:18px;height:18px;border:3px solid var(--brass);pointer-events:none}
.plaque::before{top:7px;left:7px;border-right:0;border-bottom:0}
.plaque::after{bottom:7px;right:7px;border-left:0;border-top:0}
.plaque h2{margin:0 0 4px;font:700 1.35rem/1.15 var(--serif);color:var(--oak-dark);letter-spacing:.01em}
.plaque .lede{margin:0 0 14px;color:var(--ink-soft);font-size:.92rem}

/* Team identity: always colour AND text. */
.team-tag{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:3px;font-size:.72rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#fff4df}
.team-tag.a{background:var(--red);box-shadow:inset 0 0 0 1px var(--red-hi)}
.team-tag.b{background:var(--blue);box-shadow:inset 0 0 0 1px var(--blue-hi)}
.tag{display:inline-block;padding:1px 8px;border-radius:3px;font-size:.72rem;font-weight:700;letter-spacing:.03em;background:rgba(43,30,16,.1);color:var(--ink);box-shadow:inset 0 0 0 1px rgba(43,30,16,.35)}
.tag.host{background:linear-gradient(180deg,var(--brass-hi),var(--brass));color:var(--oak-deep);box-shadow:inset 0 0 0 1px var(--brass-lo)}
.tag.you{background:var(--green);color:#f1ffe9;box-shadow:inset 0 0 0 1px var(--green-hi)}
.tag.turn{background:linear-gradient(180deg,#ffe39a,#e2b04d);color:var(--oak-deep);box-shadow:0 0 10px rgba(255,210,110,.7)}
.tag.wait{background:var(--red-hi);color:#fff;animation:pulse 1.4s ease-in-out infinite}
.tag.out{background:#2a1c18;color:#e7b2a8}
.tag.ready{background:var(--green);color:#f1ffe9}
.tag.notready{background:rgba(43,30,16,.12);color:var(--ink-soft)}
.tag.empty{background:transparent;color:var(--ink-soft);box-shadow:inset 0 0 0 1px dashed;border:1px dashed var(--ink-soft)}
@keyframes pulse{50%{box-shadow:0 0 0 4px rgba(194,69,76,.25)}}

/* ===== Lobby: tournament entrance ========================================= */
.entrance{flex:1;overflow-y:auto;padding:28px 20px 34px;display:flex;flex-direction:column;align-items:center}
/* Plaques flank the painted central arch instead of covering it. */
.entrance > .gate{margin:auto 0}
.entrance > .council{margin:auto 0}
.gate{width:100%;max-width:1180px;display:flex;flex-direction:column;align-items:center}
.crest-hero{position:relative;display:flex;flex-direction:column;align-items:center;text-align:center;margin-bottom:22px}
.crest-hero .crest{width:118px;height:136px;filter:drop-shadow(0 8px 14px rgba(0,0,0,.6))}
.crest-hero{padding:14px 34px 16px;border-radius:50%/40%;background:radial-gradient(ellipse at 50% 50%,rgba(20,12,6,.55),transparent 70%)}
.title{margin:8px 0 0;font:700 clamp(2.6rem,5.4vw,4.4rem)/1 var(--serif);letter-spacing:.04em;
  color:#f3d690;text-shadow:0 2px 0 #6b4a1c,0 4px 0 #3a2410,0 10px 22px rgba(0,0,0,.65)}
.title-rule{display:flex;align-items:center;gap:12px;margin:12px 0 6px;color:var(--brass-hi);font:italic 1.05rem var(--serif)}
.title-rule::before,.title-rule::after{content:"";width:90px;height:1px;background:linear-gradient(90deg,transparent,var(--brass-hi),transparent)}
.subtitle{margin:0;max-width:640px;padding:6px 16px;border-radius:8px;color:#f6e9cc;font-size:.95rem;background:rgba(20,12,6,.62);text-shadow:0 1px 2px rgba(0,0,0,.9)}
.title-rule{text-shadow:0 1px 3px rgba(0,0,0,.95)}
.entry-grid{width:100%;display:grid;grid-template-columns:minmax(0,520px) minmax(0,400px);justify-content:space-between;gap:34px;align-items:end}
.entry{padding:22px 24px 20px;background:linear-gradient(180deg,rgba(248,236,206,.93),rgba(226,202,150,.9));backdrop-filter:blur(2px)}
.modes{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:4px 0 18px}
.mode{position:relative;display:flex;flex-direction:column;align-items:center;text-align:center;gap:2px;cursor:pointer;
  padding:14px 10px 12px;border-radius:7px;border:2px solid transparent;color:var(--ink);
  background:linear-gradient(180deg,rgba(255,255,255,.45),rgba(255,255,255,.1));box-shadow:inset 0 0 0 1px rgba(90,58,34,.35);transition:transform .14s,box-shadow .14s,border-color .14s}
.mode:hover{transform:translateY(-2px)}
.mode input{position:absolute;opacity:0;pointer-events:none}
.mode .mode-emblem{width:52px;height:58px;margin-bottom:4px}
.mode .mode-text{display:flex;flex-direction:column;align-items:center;gap:2px}
.mode .mode-name{font:700 1.15rem var(--serif);color:var(--oak-dark)}
.mode .mode-count{font-size:.74rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--red)}
.mode .mode-desc{font-size:.78rem;color:var(--ink-soft);line-height:1.3}
.mode.on{border-color:var(--red);background:linear-gradient(180deg,#fff7e2,#f1dcab);box-shadow:0 6px 14px rgba(90,40,20,.25),inset 0 0 0 1px var(--brass)}
.mode.on::after{content:"Chosen";position:absolute;top:-10px;right:8px;padding:1px 8px;border-radius:3px;font-size:.66rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;background:var(--red);color:#fff4df}
.mode:has(input:focus-visible){outline:3px solid var(--focus);outline-offset:2px}
.entry-actions{display:flex;justify-content:center}
.join-row{display:flex;gap:10px;margin-top:6px}
.join-row .field{flex:1;min-width:0;font:700 1.1rem var(--sans);letter-spacing:.14em;text-transform:uppercase}
.how{margin-top:20px;padding-top:16px;border-top:1px solid rgba(90,58,34,.3)}
.how h3{margin:0 0 8px;font:700 .78rem var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--red)}
.how ol{margin:0;padding-left:20px;color:var(--ink-soft);font-size:.86rem}
.how li{margin:3px 0}

/* ===== Room assembly: the war council ===================================== */
.council{width:100%;max-width:1120px}
.council-head{display:flex;align-items:center;justify-content:center;gap:18px;margin-bottom:34px;text-align:center}
.council-head .crest{width:58px;height:66px;filter:drop-shadow(0 4px 8px rgba(0,0,0,.6))}
.council-head .crest{width:74px;height:86px}
.council-head h1{margin:0;font:700 2.4rem var(--serif);color:#f3d690;text-shadow:0 3px 0 #3a2410,0 8px 16px rgba(0,0,0,.6)}
.council-head .room-meta{display:inline-block;margin-top:4px;padding:2px 12px;border-radius:6px;color:#f6e9cc;font-size:.92rem;background:rgba(20,12,6,.62)}
.council-head{padding:10px 28px;border-radius:50%/45%;background:radial-gradient(ellipse at 50% 50%,rgba(20,12,6,.6),transparent 72%)}
.room-code{font:700 1rem var(--sans);letter-spacing:.18em;color:var(--brass-hi)}
.banners{display:flex;justify-content:center;gap:26px;flex-wrap:wrap;margin-bottom:34px}
.banner-seat{position:relative;width:210px;padding:24px 14px 54px;text-align:center;color:#fff4df;
  clip-path:polygon(0 0,100% 0,100% 86%,50% 100%,0 86%);
  box-shadow:inset 0 0 0 2px rgba(255,255,255,.12);filter:drop-shadow(0 10px 14px rgba(0,0,0,.5))}
.banner-seat.a{background:linear-gradient(180deg,var(--red-hi),var(--red) 40%,var(--red-lo))}
.banner-seat.b{background:linear-gradient(180deg,var(--blue-hi),var(--blue) 40%,var(--blue-lo))}
.banner-seat.vacant{filter:drop-shadow(0 10px 14px rgba(0,0,0,.5)) saturate(.35) brightness(.7)}
.banner-seat.me{outline:3px solid var(--brass-hi);outline-offset:-6px}
.banner-pole{position:absolute;top:-10px;left:-8px;right:-8px;height:10px;border-radius:5px;background:linear-gradient(180deg,var(--brass-hi),var(--brass-lo));box-shadow:0 2px 3px rgba(0,0,0,.5)}
.banner-wrap{position:relative;padding-top:10px}
.banner-seat .bcrest{width:60px;height:70px;margin:0 auto 8px;display:block;filter:drop-shadow(0 3px 3px rgba(0,0,0,.4))}
.banner-seat .bseat{font:700 1.45rem var(--serif);display:block;color:#fff4df;text-shadow:0 2px 2px rgba(0,0,0,.45)}
.banner-seat .btags{display:flex;flex-wrap:wrap;justify-content:center;gap:4px;margin:6px 0 10px}
.banner-seat .btags .tag{background:rgba(0,0,0,.25);color:#fff4df;box-shadow:inset 0 0 0 1px rgba(255,255,255,.3)}
.banner-seat .btags .tag.host{background:linear-gradient(180deg,var(--brass-hi),var(--brass));color:var(--oak-deep)}
.banner-seat .btags .tag.you{background:var(--green)}
.seal{display:inline-flex;align-items:center;justify-content:center;min-width:96px;padding:5px 10px;border-radius:999px;font-size:.78rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.seal.ready{background:radial-gradient(circle at 40% 35%,#79b47c,#2f5a33);color:#effde9;box-shadow:0 0 0 2px #1d3a20,0 3px 6px rgba(0,0,0,.4)}
.seal.notready{background:rgba(0,0,0,.28);color:#f2dcc0;box-shadow:inset 0 0 0 1px rgba(255,255,255,.3)}
.seal.empty{background:transparent;color:#e7d6b8;border:1px dashed rgba(255,255,255,.45)}
.dispatch{max-width:820px;margin:0 auto;padding:20px 24px;background:linear-gradient(180deg,rgba(248,236,206,.93),rgba(226,202,150,.9));display:grid;grid-template-columns:1fr auto;gap:16px;align-items:center}
.dispatch .invite-label{font:700 .74rem var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--red);margin-bottom:6px}
.dispatch .invite-line{display:flex;gap:8px}
.dispatch .invite-line .field{flex:1;min-width:0;font-size:.85rem}
.dispatch .council-actions{display:flex;flex-direction:column;gap:8px;align-items:stretch;min-width:170px}
.dispatch .hint{grid-column:1/-1;margin:0;font-size:.82rem;color:var(--ink-soft)}

/* ===== Battle: a single cover-scaled painting with shared coordinates ===== */
.battle{position:relative;flex:1;min-height:0;width:100%;isolation:isolate;overflow:hidden}
.topbar{position:absolute;z-index:8;inset:0 0 auto;display:flex;align-items:center;gap:10px;padding:8px 16px;color:#f2dfb8;font-size:.82rem;background:linear-gradient(rgba(20,12,6,.82),transparent)}
.topbar .crest{width:22px;height:25px}
.topbar strong{font:700 1rem var(--serif);color:#f3d690}
.topbar .room-code{font-size:.82rem}
.topbar .mode-pill{margin-left:auto;padding:2px 10px;border-radius:99px;background:rgba(0,0,0,.55);color:var(--brass-hi);font-weight:700;letter-spacing:.04em}

/* Far rim: opponent stations stand on the painted table's far edge. */
.far{position:absolute;z-index:3;left:18%;right:18%;top:max(7%,calc(var(--crop-y,0px) + 40px));display:flex;justify-content:center;align-items:flex-end;gap:24px}
.far .seat:not(.banner-seat){width:220px}

/* Opponent knight: a painted figure standing just behind its own nameplate,
   one per living opponent station (P2). Decorative only — pointer-events
   stays none throughout so the nameplate underneath keeps handling clicks
   and card drops exactly as before; the figure never gains its own hit
   target. Pose reflects only public, already-known state (whose turn it
   is, who must respond, who is eliminated) — never anything hidden. */
.knight-stand{position:relative;display:flex;flex-direction:column;align-items:center}
.knight-stand .knight-fig{height:clamp(80px,14dvh,172px);width:auto;max-width:168px;object-fit:contain;object-position:bottom center;
  pointer-events:none;user-select:none;-webkit-user-drag:none;margin-bottom:-20px;position:relative;z-index:1;
  filter:drop-shadow(0 10px 10px rgba(0,0,0,.65));transition:filter .2s}
.knight-stand .seat{position:relative;z-index:2}
.knight-stand.out .knight-fig{filter:grayscale(.85) brightness(.75) drop-shadow(0 8px 8px rgba(0,0,0,.6))}

/* Player station */
.seat:not(.banner-seat){position:relative;width:250px;color:var(--ink);border-radius:8px;
  background:linear-gradient(180deg,var(--ivory),var(--parch));
  box-shadow:0 0 0 3px var(--oak),0 0 0 4px var(--brass-lo),0 10px 22px rgba(0,0,0,.55);transition:box-shadow .15s,opacity .15s,transform .15s}
.seat-crown{display:flex;align-items:center;gap:8px;padding:6px 10px 6px 8px;border-radius:7px 7px 0 0;color:#fff4df}
.seat.team-a .seat-crown{background:linear-gradient(180deg,var(--red-hi),var(--red))}
.seat.team-b .seat-crown{background:linear-gradient(180deg,var(--blue-hi),var(--blue))}
.seat-crown .screst{width:22px;height:26px;flex:0 0 auto}
.seat-crown .sname{font:700 1.02rem var(--serif);text-shadow:0 1px 0 rgba(0,0,0,.35)}
.seat-crown .team-tag{margin-left:auto;background:rgba(0,0,0,.28);box-shadow:inset 0 0 0 1px rgba(255,255,255,.35)}
.seat-mid{display:flex;align-items:center;gap:10px;padding:8px 10px 4px}
.hp{flex:1}
.hp-label{display:flex;justify-content:space-between;font-size:.74rem;font-weight:700;color:var(--ink-soft);letter-spacing:.03em}
.hp-label b{color:var(--ink);font-size:.95rem}
.hp-track{position:relative;height:12px;margin-top:2px;border-radius:3px;background:#5a3e26;box-shadow:inset 0 2px 3px rgba(0,0,0,.55),0 0 0 1px var(--brass-lo);overflow:hidden}
.hp-fill{height:100%;background:linear-gradient(180deg,#e0646a,#9a2f36 60%,#6e1f25);box-shadow:inset 0 1px 0 rgba(255,255,255,.35)}
.hp-pips{position:absolute;inset:0;display:flex}
.hp-pips i{flex:1;border-right:1px solid rgba(0,0,0,.35)}
.hp-pips i:last-child{border-right:0}
.hand-shield{position:relative;flex:0 0 auto;width:40px;height:46px;display:flex;align-items:center;justify-content:center}
.hand-shield svg{position:absolute;inset:0;width:100%;height:100%}
.hand-shield b{position:relative;font:700 1.05rem var(--serif);color:#fff4df;text-shadow:0 1px 1px rgba(0,0,0,.6);margin-top:-3px}
.seat-tags{display:flex;flex-wrap:wrap;gap:4px;padding:2px 10px 8px;min-height:24px}
.seat .backs{display:flex;justify-content:center;padding:0 10px 9px;margin-top:-2px}
.back{width:20px;height:28px;margin:0 -4px;border-radius:3px;
  background:radial-gradient(circle at 50% 50%,var(--brass-hi) 0 3px,transparent 4px),repeating-linear-gradient(45deg,rgba(226,196,126,.22) 0 2px,transparent 2px 6px),linear-gradient(160deg,#3a2414,#1f130a);
  box-shadow:0 0 0 1px var(--brass),0 2px 3px rgba(0,0,0,.45)}
.seat.active{box-shadow:0 0 0 3px var(--brass-hi),0 0 0 5px rgba(255,214,120,.35),0 0 28px rgba(255,200,100,.55),0 10px 22px rgba(0,0,0,.55)}
.seat.responding{box-shadow:0 0 0 3px var(--urgent),0 0 0 6px rgba(209,69,60,.3),0 0 26px rgba(209,69,60,.5),0 10px 22px rgba(0,0,0,.55)}
.seat.out{filter:grayscale(.85) brightness(.82)}
.seat.won .seat-crown{background:linear-gradient(180deg,#ffe39a,#c99a3c);color:var(--oak-deep)}
.seat.compact .backs{display:none}
body[data-drag] .far .seat{opacity:.35}
body[data-drag] .far .seat.drop-ok{opacity:1;cursor:copy;transform:translateY(4px) scale(1.03)}
.far .seat.pick{cursor:pointer;transform:translateY(4px);box-shadow:0 0 0 3px var(--brass-hi),0 10px 24px rgba(0,0,0,.55)}
.far .seat.pick::after{content:"Tap to target";position:absolute;left:50%;bottom:-14px;transform:translateX(-50%);padding:2px 10px;border-radius:99px;font-size:.7rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--oak-deep);background:var(--brass-hi);white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.5)}
body[data-drag] .far .seat.drop-ok::after{content:"Drop to target";position:absolute;left:50%;bottom:-14px;transform:translateX(-50%);padding:2px 10px;border-radius:99px;font-size:.7rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--oak-deep);background:var(--brass-hi);white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.5)}
.seat.drop-ready{box-shadow:0 0 0 3px #ffe39a,0 0 0 7px rgba(255,227,154,.45),0 0 34px rgba(255,210,110,.8),0 10px 22px rgba(0,0,0,.55) !important}

/* ===== The war table (layer 2) ============================================ */
/* layoutBattleScene uses the same uniform scale for the image and its overlays.
   Cover may crop the scene's edges; it never distorts or adds an outer stage. */
.stage-wrap{position:absolute;inset:0;z-index:1;overflow:hidden}
.stage{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:100%;aspect-ratio:1672/941;color:var(--ink);container-type:inline-size}
.table-art{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;user-select:none;-webkit-user-drag:none}
.stage > .centerpiece{position:absolute;z-index:2;left:51%;top:44%;transform:translate(-50%,-50%)}
.stage > .chronicle{position:absolute;z-index:2;left:66%;top:37%;width:18%;align-self:auto}
.stage > .zone,.stage > .victory{position:absolute;z-index:4;left:50%;top:53.5%;transform:translate(-50%,-50%);max-width:70%;white-space:normal}
.stage > .zone.has-actions{top:54%;width:max-content;max-width:58%}
@media (min-height:481px) and (min-width:761px){
  .stage:has(> .zone.has-actions) > .centerpiece{top:42%}
}
/* Laptop: put the phase indicator beside the decision area, keeping both
   clear of the opponent station and the inspected-card ceiling. */
@media (min-width:761px) and (max-width:1450px) and (min-height:481px){
  .stage > .centerpiece{left:30%}
  .stage:has(> .zone.has-actions) > .centerpiece{left:20%}
}
.stage > .victory{top:62%}

.stage > .pile-group{display:contents}
/* Pile counts sit beneath the painted decks; the painted decks ARE the piles,
   so the procedural draw stack is hidden here (it returns on mobile). */
.stage .pile{position:absolute;z-index:2;top:54%;transform:translateX(-50%)}
.stage .pile.draw{left:14.4%}
.stage .pile.discard{left:87.2%}
.stage .pile .pile-stack.draw{display:none}
.stage .pile .pile-stack.discard{position:absolute;left:50%;bottom:calc(100% + 4px);transform:translateX(-50%) rotate(4deg);width:4.2cqw;height:5.9cqw;min-width:44px;min-height:62px}
.stage .pile .pile-stack.discard.empty{display:none}
.stage .pile .pile-stack.discard i:not(.top){display:none}
.stage .pile-label{padding:3px 10px 4px;border-radius:6px;color:#f3e3c0;background:rgba(28,17,8,.78);box-shadow:0 0 0 1px var(--brass-lo),0 4px 10px rgba(0,0,0,.45)}
.stage .pile-label b{color:#ffe9b8}
.pile-group{display:flex;gap:22px;justify-content:center;align-items:flex-end}
.pile{display:flex;flex-direction:column;align-items:center;gap:6px}
.pile-stack{position:relative;width:58px;height:80px}
.pile-stack i{position:absolute;inset:0;border-radius:5px;box-shadow:0 0 0 1px var(--brass),0 3px 5px rgba(0,0,0,.35)}
.pile-stack.draw i{background:radial-gradient(circle at 50% 50%,var(--brass-hi) 0 5px,transparent 6px),repeating-linear-gradient(45deg,rgba(226,196,126,.2) 0 2px,transparent 2px 7px),linear-gradient(160deg,#3a2414,#1f130a)}
.pile-stack i:nth-child(1){transform:translate(-3px,4px) rotate(-5deg)}
.pile-stack i:nth-child(2){transform:translate(2px,2px) rotate(3deg)}
.pile-stack i:nth-child(3){transform:rotate(-1deg)}
.pile-stack.discard i{background:linear-gradient(165deg,#f6ead0,#d8bd88)}
.pile-stack.discard.empty i{background:transparent;box-shadow:inset 0 0 0 2px rgba(90,58,34,.35)}
.pile-stack.discard i.top{overflow:hidden;background:#2a1b10}
.pile-stack.discard i.top img{width:100%;height:100%;object-fit:cover;opacity:.92}
.pile-label{text-align:center;font-size:.7rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-soft);line-height:1.2}
.pile-label b{display:block;font:700 1.15rem var(--serif);color:var(--oak-dark);letter-spacing:0}
.centerpiece{position:relative;display:grid;grid-template-columns:auto auto;align-items:center;gap:6px 14px;text-align:center}
.centerpiece .medallion{grid-column:1;grid-row:1/3}
.centerpiece .phase-banner,.centerpiece .turn-line{grid-column:2}
.phase-banner{position:relative;padding:7px 30px 9px;color:#fff4df;font:700 1.05rem var(--serif);letter-spacing:.06em;text-transform:uppercase;
  background:linear-gradient(180deg,var(--red-hi),var(--red) 55%,var(--red-lo));
  clip-path:polygon(0 0,100% 0,94% 50%,100% 100%,0 100%,6% 50%);filter:drop-shadow(0 4px 4px rgba(0,0,0,.35))}
.phase-banner.p-response{background:linear-gradient(180deg,#e0784a,#b0442a 55%,#6e2614)}
.phase-banner.p-discard{background:linear-gradient(180deg,var(--blue-hi),var(--blue) 55%,var(--blue-lo))}
.phase-banner.p-done{background:linear-gradient(180deg,#ffe39a,#c99a3c 55%,#7d5f2a);color:var(--oak-deep)}
.turn-line{padding:2px 12px;border-radius:99px;font:600 .95rem var(--serif);color:var(--oak-dark);background:rgba(250,236,200,.72)}
.turn-line b{color:var(--red)}
.medallion{position:relative;width:96px;height:96px;border-radius:50%;flex:0 0 auto;
  background:radial-gradient(circle at 38% 32%,#5a3c22,#1e130a 70%);
  box-shadow:0 0 0 3px var(--brass),0 0 0 6px var(--oak-dark),0 0 0 7px var(--brass-lo),0 8px 16px rgba(0,0,0,.5),inset 0 0 14px rgba(0,0,0,.7)}
.medallion svg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}
.medallion .countdown{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 1.35rem var(--sans);font-variant-numeric:tabular-nums;color:#ffe9b8;text-shadow:0 1px 2px rgba(0,0,0,.8)}
.medallion .countdown.danger{color:#ffb0a6}
.medallion.urgent{animation:urgent 1s ease-in-out infinite}
@keyframes urgent{50%{box-shadow:0 0 0 3px var(--urgent),0 0 0 6px var(--oak-dark),0 0 0 7px var(--brass-lo),0 0 26px rgba(209,69,60,.8),inset 0 0 14px rgba(0,0,0,.7)}}
.medallion.idle .countdown{font-size:.8rem;letter-spacing:.06em;text-transform:uppercase;color:#d9c49b}
.chronicle{align-self:stretch;display:flex;flex-direction:column;justify-content:center;gap:6px}
.chronicle h3{margin:0;font:700 .7rem var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--red);text-shadow:0 0 6px rgba(255,240,205,.9)}
.chronicle ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.chronicle li{padding:5px 10px;border-radius:3px;font-size:.84rem;color:var(--ink);background:rgba(255,250,235,.55);border-left:3px solid var(--brass)}
.chronicle li:first-child{background:rgba(255,250,235,.9);border-left-color:var(--red);font-weight:600;animation:arrive .35s ease-out}
.chronicle li:not(:first-child){opacity:.72}
@keyframes arrive{from{transform:translateX(8px);opacity:0}}
.zone{display:flex;align-items:center;gap:12px;padding:8px 22px;border-radius:999px;
  color:var(--oak-dark);background:rgba(255,248,226,.78);box-shadow:inset 0 0 0 1px rgba(125,95,42,.45);transition:background .15s,box-shadow .15s,transform .15s}
.zone .zone-head{display:flex;align-items:center;gap:12px}
.zone .zone-icon{width:26px;height:30px;flex:0 0 auto}
.zone .zone-title{font:700 .9rem var(--serif)}
.zone .zone-hint{font-size:.78rem;color:var(--ink-soft)}
.zone.z-response,.zone.z-rescue{background:rgba(255,226,214,.75);box-shadow:inset 0 0 0 2px var(--urgent),0 0 18px rgba(209,69,60,.35)}
/* P5: a pending response/rescue carries its own decision buttons
   (centerResponseActions) — the pill shape only fits an icon+text row, so
   a zone with buttons switches to a rounded card stacked vertically. */
.zone.has-actions{flex-direction:column;align-items:stretch;gap:8px;border-radius:16px;padding:12px 22px 16px;min-width:280px;white-space:normal}
.zone.has-actions .zone-head{justify-content:center;text-align:center}
.zone-actions{display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center}
.zone-actions .ctl-row{justify-content:center}
.zone .btn.ghost{color:var(--oak-dark);border-color:var(--brass-lo);background:rgba(255,250,235,.6)}
.zone-actions .ctl-note{margin:0;text-align:center;color:var(--oak-dark)}
body[data-drag] .zone{background:rgba(255,236,180,.85);box-shadow:inset 0 0 0 2px var(--brass),0 0 22px rgba(255,200,100,.5)}
body[data-drag] .zone.zone-active{background:#fff2c8;box-shadow:inset 0 0 0 3px var(--red),0 0 30px rgba(255,190,90,.8)}
.victory{display:flex;flex-direction:column;align-items:center;gap:2px;padding:14px 46px 20px;color:var(--oak-deep);text-align:center;
  background:linear-gradient(180deg,#ffe9a8,#d6a948 60%,#8a6427);clip-path:polygon(0 0,100% 0,100% 80%,50% 100%,0 80%);filter:drop-shadow(0 8px 10px rgba(0,0,0,.45))}
.victory .vt{font:700 1.7rem var(--serif);letter-spacing:.05em}
.victory .vs{font-size:.82rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase}

/* ===== Foreground: one fan, independently anchored HUD and controls ===== */
/* Side widgets follow the measured fan, above the forearms. Portrait keeps
   its functional bottom row; the painted battlefield stays full-screen. */
.hand-dock{position:absolute;inset:0;z-index:6;pointer-events:none}
.self-hud{position:absolute;z-index:40;left:clamp(12px,calc(var(--fan-left,25vw) - 184px),calc(100% - 182px));top:var(--side-y,76%);transform:translateY(-50%);pointer-events:auto;display:flex;flex-direction:column;gap:5px;width:170px}
.mini-controls{position:absolute;z-index:40;left:clamp(12px,calc(var(--fan-right,75vw) + 14px),calc(100% - 212px));top:var(--side-y,76%);transform:translateY(-50%);pointer-events:auto;display:flex;flex-direction:column;align-items:flex-end;gap:4px;width:200px;max-height:min(25dvh,150px);overflow-y:auto;scrollbar-width:thin;overscroll-behavior:contain}
.fan-dock{position:absolute;left:50%;bottom:clamp(0px,calc(20dvh - 128px),80px);transform:translateX(-50%);width:calc(100% - 430px);max-width:960px;pointer-events:none}

.prompt{padding:5px 9px;border-radius:5px;font-size:.74rem;line-height:1.3;color:#f2e2bf;background:rgba(20,13,9,.72);box-shadow:inset 0 0 0 1px rgba(226,196,126,.25)}
.prompt b{color:#ffe1a0}
.prompt.you{background:linear-gradient(180deg,rgba(126,35,42,.88),rgba(66,18,22,.9));box-shadow:inset 0 0 0 1px var(--red-hi),0 0 16px rgba(194,69,76,.3)}
/* Compact HUD seat card: the same seatPanel() markup as the full table
   stations, shrunk to a single slim strip (crest+name+team on one line,
   a thin HP bar + hand-count badge on the next, tags last) instead of a
   scaled-down copy of the big card — only font sizes/paddings change. */
.seat.compact{width:100%;max-width:184px}
.seat.compact .seat-crown{padding:3px 7px 3px 6px}
.seat.compact .seat-crown .screst{width:15px;height:18px}
.seat.compact .seat-crown .sname{font-size:.82rem}
.seat.compact .seat-crown .team-tag{font-size:.6rem;padding:0 5px}
.seat.compact .seat-mid{padding:4px 7px 2px;gap:6px}
.seat.compact .hp-label{font-size:.62rem}
.seat.compact .hp-label b{font-size:.78rem}
.seat.compact .hp-track{height:7px;margin-top:1px}
.seat.compact .hand-shield{width:24px;height:28px}
.seat.compact .hand-shield b{font-size:.74rem}
.seat.compact .seat-tags{padding:1px 7px 4px;min-height:0;gap:3px}
.seat.compact .tag{font-size:.6rem;padding:0 5px}
/* Measured, rotated card bounds determine the fan, independent of phase/UI copy. */
.hand{position:relative;width:var(--hand-stage-w,100%);max-width:100%;height:var(--hand-stage-h,220px);margin:0 auto;overflow:visible;pointer-events:none}
.hand > .card{pointer-events:auto}
.hand.laying-out > .card{transition:none !important}
.hand-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#f2dfb8;font-style:italic;pointer-events:none}

#controls{margin-top:2px;width:100%;min-width:0}
.mini-controls > *{max-width:100%}
.ctl-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px}
.ctl-row + .ctl-row{margin-top:4px}
.ctl-label{font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#bfa77c;margin-right:2px}
.ctl-note{margin:0 0 4px;color:#f2e2bf;font-size:.8rem;text-align:right;text-shadow:0 1px 3px rgba(0,0,0,.85)}
.ctl-note.muted{color:#cdb68c}
.ctl-group.response .ctl-note,.ctl-group.rescue .ctl-note{color:#ffd7cc}
details.fallback{margin-top:4px}
details.fallback summary{cursor:pointer;width:auto;max-width:100%;margin-left:auto;font-size:.76rem;color:#bfa77c;letter-spacing:.03em}
details.fallback summary:hover{color:var(--brass-hi)}
details.fallback[open] summary{margin-bottom:6px}
.hand-hint{pointer-events:none;align-self:flex-end;margin-bottom:4px;font-size:.7rem;color:#e7d6b8;text-shadow:0 1px 3px rgba(0,0,0,.9)}
/* Small text backplates, not a shared bottom panel. Centre-stage notes retain
   dark ink on parchment; only the floating HUD's helpers need this contrast. */
.mini-controls .ctl-note,.mini-controls .ctl-label,.hand-hint,details.fallback summary{box-sizing:border-box;color:#fff1ce;background:rgba(20,13,9,.76);border-radius:4px;padding:3px 6px;text-shadow:0 1px 2px #000}
.mini-controls details.fallback summary:hover{color:#fff9e9;background:rgba(20,13,9,.9)}
/* Native-proportion forearms cradle the lower outer cards. Their contact
   points follow rotated card geometry, independently of the fan's total width.
   Card faces paint above the palms, so titles, art and actions stay unobscured. */
.grip-hand{position:absolute;width:var(--grip-width,180px);height:auto;z-index:-1;pointer-events:none;user-select:none;-webkit-user-drag:none;filter:drop-shadow(0 -3px 5px rgba(0,0,0,.35))}
.grip-left{left:var(--grip-left,0px);top:var(--grip-left-top,0px);transform-origin:74% 40%;transform:rotate(var(--grip-lean,25deg))}
.grip-right{left:var(--grip-right,100px);top:var(--grip-right-top,0px);transform-origin:26% 34%;transform:rotate(calc(-1 * var(--grip-lean,25deg)))}
.hand.is-empty .grip-hand{display:none}

/* Combat VFX stinger (P4): a short-lived sprite anchored at whichever seat
   station (or, for match_complete, the centerpiece) a confirmed publicLog
   event names — never a client-fabricated guess. Its host (.seat,
   .centerpiece) is already position:relative/absolute in every layout this
   is used in, so this just overlays that box. The JS timer that clears
   combatFx (150-650ms, see fxFor/detectCombatFx) is the only thing that
   removes it; the animation itself is purely decorative timing within
   that window. prefers-reduced-motion:reduce (global rule above) already
   kills the animation — detectCombatFx also checks it directly so a
   reduced-motion viewer never spends a render on this at all. */
@keyframes vfx-flash{0%{opacity:0;transform:translate(-50%,-50%) scale(.75)}18%{opacity:1;transform:translate(-50%,-50%) scale(1.05)}70%{opacity:1}100%{opacity:0;transform:translate(-50%,-50%) scale(1.18)}}
.vfx-flash{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:70%;max-width:220px;height:auto;
  z-index:5;pointer-events:none;user-select:none;-webkit-user-drag:none;
  animation:vfx-flash .6s ease-out both;filter:drop-shadow(0 6px 14px rgba(0,0,0,.6))}

/* ===== The card (layer 3) ================================================= */
/* In a fanned hand (.hand > .card), position/rotation come from --fx/--fy/
   --fr (left/bottom/rotate, set in JS); --fz keeps left-to-right stacking
   order so a card fanned rightward overlaps the one to its left correctly,
   bumped further by state (playable/selected/dragging) below. Outside a
   fanned hand (the opponent hand-count display has none of these cards —
   N/A) the rule is simply inert. */
.card{--w:clamp(116px,16.5dvh,172px);position:relative;flex:0 0 var(--w);width:var(--w);aspect-ratio:5/7;border-radius:11px;
  transition:transform .16s ease,filter .16s ease;transform-origin:50% 100%}
.hand > .card{position:absolute;left:var(--fx,0);bottom:var(--fy,0);z-index:var(--fz,0);
  transform:rotate(var(--fr,0deg));flex:0 0 auto}
.hand > .card:focus-within{z-index:40}
@media (hover:hover) and (pointer:fine){.hand > .card:hover{z-index:40}}
.hand > .card.selected{z-index:41}
.hand > .card.targeting{z-index:42}
.card .rim{position:absolute;inset:0;border-radius:11px;pointer-events:none;
  background:linear-gradient(145deg,#f2d89a 0%,#b08a44 22%,#6f5225 50%,#b08a44 78%,#e8cb88 100%);
  box-shadow:0 6px 14px rgba(0,0,0,.55),0 1px 0 rgba(255,255,255,.3) inset,0 -2px 0 rgba(0,0,0,.35) inset}
.card .rim::before{content:"";position:absolute;inset:3px;border-radius:8px;background:var(--oak-dark);box-shadow:inset 0 0 0 1px rgba(0,0,0,.5)}
.card .corner{position:absolute;width:20px;height:20px;z-index:3;pointer-events:none}
.card .corner svg{width:100%;height:100%;display:block}
.card .corner.tl{top:0;left:0}
.card .corner.tr{top:0;right:0;transform:scaleX(-1)}
.card .corner.bl{bottom:0;left:0;transform:scaleY(-1)}
.card .corner.br{bottom:0;right:0;transform:scale(-1)}
.card > button{all:unset;box-sizing:border-box;position:absolute;inset:6px;z-index:1;border-radius:7px;overflow:hidden;cursor:pointer;
  display:flex;flex-direction:column;background:linear-gradient(180deg,#f5e8c8,#e3cb96)}
.card > button:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
.card .plate{position:relative;z-index:2;display:flex;align-items:center;justify-content:center;gap:4px;margin:4px 6px 0;padding:3px 6px 4px;border-radius:4px;
  background:linear-gradient(180deg,#fbf2da,#e1c68e);box-shadow:0 0 0 1px var(--brass-lo),0 2px 3px rgba(0,0,0,.35),inset 0 1px 0 #fff}
.card .plate .glyph{width:14px;height:14px;flex:0 0 auto}
.card .card-name{min-width:0;width:100%;font:700 .86rem/1.05 var(--serif);color:var(--oak-deep);text-align:center;letter-spacing:.01em;
  white-space:normal;word-break:normal;overflow-wrap:break-word;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;max-height:2.15em}
.card .card-art{position:relative;flex:0 0 44%;margin:4px 6px 0;border-radius:3px;overflow:hidden;background:#2a1b10;
  box-shadow:0 0 0 1px var(--brass-lo),0 0 0 2px rgba(255,255,255,.35),inset 0 0 0 1px rgba(0,0,0,.4)}
.card .card-art-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;user-select:none;-webkit-user-drag:none}
.card .card-art::after{content:"";position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 12px rgba(0,0,0,.55);background:linear-gradient(180deg,transparent 70%,rgba(0,0,0,.35))}
.card .ribbon{position:relative;z-index:2;align-self:center;margin:-9px 0 0;padding:2px 14px 3px;font:700 .62rem var(--sans);letter-spacing:.08em;text-transform:uppercase;color:#fff4df;
  clip-path:polygon(0 0,100% 0,92% 50%,100% 100%,0 100%,8% 50%);filter:drop-shadow(0 1px 1px rgba(0,0,0,.5))}
.card .card-effect{flex:1;min-height:0;overflow:hidden;display:flex;align-items:center;justify-content:center;text-align:center;margin:2px 7px 2px;font:500 .68rem/1.13 var(--serif);color:var(--ink)}
.card .card-status{position:relative;z-index:2;margin:0 6px 5px;padding:2px 4px;border-radius:3px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:700 .58rem var(--sans);letter-spacing:.05em;text-transform:uppercase;color:var(--ink-soft);background:rgba(90,58,34,.1)}
.card-attack .ribbon{background:linear-gradient(180deg,var(--red-hi),var(--red-lo))}
.card-dodge .ribbon{background:linear-gradient(180deg,var(--blue-hi),var(--blue-lo))}
.card-heal .ribbon{background:linear-gradient(180deg,#e9cd86,#9a7432);color:var(--oak-deep)}
.card-seize .ribbon{background:linear-gradient(180deg,#a88246,#5f4419)}
.card-disarm .ribbon{background:linear-gradient(180deg,#5c565c,#28242a)}
.card-insight .ribbon{background:linear-gradient(180deg,#36557a,#16233a)}
.card-war_cry .ribbon{background:linear-gradient(180deg,#c2454c,#7d5f2a)}
.card-arrow_volley .ribbon{background:linear-gradient(180deg,var(--green-hi),#2a4a2e)}

.card.playable .rim{background:linear-gradient(145deg,#fff0bf 0%,#e2c47e 22%,#9c7838 50%,#e2c47e 78%,#fff0bf 100%);
  box-shadow:0 12px 20px rgba(0,0,0,.6),0 0 0 2px rgba(255,226,150,.55),0 0 22px rgba(255,205,110,.55)}
.card.playable .card-status{background:linear-gradient(180deg,#5d9161,#3f6a43);color:#f1ffe9}

.card.playable{cursor:grab}
/* Resting cards share geometry regardless of availability. Inspecting a card
   raises it above its neighbours and hands, with an upright readable face. */
.hand > .card:focus-within{transform:rotate(var(--fr,0deg)) translateY(-20px) scale(1.04)}
@media (hover:hover) and (pointer:fine){.hand > .card:hover{transform:rotate(var(--fr,0deg)) translateY(-20px) scale(1.04)}}

.card.drag-source{opacity:.35}
.card.drag-ghost{position:fixed;top:0;left:0;z-index:999;pointer-events:none;will-change:transform;transition:none;opacity:1}
.drag-ghost *{pointer-events:none !important}
.card.drag-ghost.returning{transition:transform .18s ease}
.card.unavailable > button{cursor:default}
.card.unavailable .card-art-img{filter:saturate(.45) brightness(.8)}
.card.unavailable .card-effect,.card.unavailable .card-name{opacity:.75}
.card.unavailable .card-status{color:var(--ink-soft);background:rgba(43,30,16,.12)}
.card.targeting .rim{background:linear-gradient(145deg,#ffd0c8,#c2454c 30%,#6e1f25 55%,#c2454c 80%,#ffd0c8);box-shadow:0 12px 20px rgba(0,0,0,.6),0 0 24px rgba(209,69,60,.7)}

.card.selected .rim{background:linear-gradient(145deg,#ffd0c8,#c2454c 30%,#6e1f25 55%,#c2454c 80%,#ffd0c8);box-shadow:0 12px 20px rgba(0,0,0,.6),0 0 0 3px #ffb0a6,0 0 22px rgba(209,69,60,.7)}
.card.selected .card-status{background:var(--red);color:#fff4df}
.card.discardable:not(.selected) .card-status{background:rgba(53,93,125,.18);color:var(--blue-lo)}
.hand > .card:is(:hover,:focus-within,.selected,.targeting) .card-art{flex-basis:34%}
.hand > .card.selected,.hand > .card.targeting{transform:translateY(var(--inspect-lift,-44px)) rotate(0deg) scale(1.06)}
.card.selected .card-status::before{content:"✓ "}
button[aria-pressed=true]{outline:none}

/* ===== Responsive ========================================================= */
@media (max-width:980px){
  .entry-grid{grid-template-columns:1fr;max-width:620px;margin:0 auto}
  .fan-dock{width:calc(100% - 300px)}
  .self-hud{width:130px;left:clamp(10px,calc(var(--fan-left,25vw) - 144px),calc(100% - 140px))}
  .mini-controls{width:140px;left:clamp(10px,calc(var(--fan-right,75vw) + 14px),calc(100% - 150px))}
  .hand-hint{display:none}
}
@media (max-width:760px){
  body:not(.in-battle){overflow:auto}
  body:not(.in-battle) main{height:auto;min-height:100dvh}
  body:not(.in-battle) #app{min-height:100dvh}
  .modes{grid-template-columns:1fr}
  .mode{flex-direction:row;text-align:left;gap:12px;padding:10px 12px}
  .mode .mode-emblem{width:38px;height:44px;margin:0}
  .mode .mode-text{align-items:flex-start}
  .entrance{padding:18px 12px 24px}
  .crest-hero .crest{width:84px;height:96px}
  .dispatch{grid-template-columns:1fr}
  .banner-seat{width:150px;padding:16px 10px 40px}
  .banners{gap:14px}
  .entry-grid > *,.gate{min-width:0;max-width:100%}
  .plaque{box-sizing:border-box}
}
/* Short landscape: keep decision UI above the fan; use compact public stations. */
@media (max-height:540px) and (orientation:landscape){
  .topbar{padding:3px 10px;font-size:.7rem;gap:6px}
  .topbar .crest{width:16px;height:19px}
  .topbar strong{font-size:.85rem}
  .topbar .room-code{font-size:.7rem}
  .far{top:calc(var(--crop-y,0px) + 28px);left:22%;right:22%;gap:12px}
  .far .seat:not(.banner-seat){width:138px}
  .knight-stand .knight-fig{height:50px;margin-bottom:-8px}
  .far .seat-crown{padding:2px 6px;gap:4px}
  .far .seat-crown .screst{width:14px;height:16px}
  .far .seat-crown .sname{font-size:.76rem}
  .far .team-tag{font-size:.55rem;padding:0 4px}
  .far .seat-mid{padding:3px 6px;gap:5px}
  .far .hp-label{font-size:.58rem}
  .far .hp-label b{font-size:.7rem}
  .far .hp-track{height:6px}
  .far .hand-shield{width:22px;height:24px}
  .far .hand-shield b{font-size:.65rem}
  .far .backs,.far .seat-tags{display:none}
  .stage > .centerpiece{left:21%;top:47%;gap:3px 7px}
  .phase-banner{font-size:.72rem;padding:4px 12px}
  .turn-line{font-size:.68rem;padding:1px 6px}
  .medallion{width:50px;height:50px}
  .medallion .countdown{font-size:.82rem}
  .stage > .zone,.stage > .zone.has-actions{left:62%;top:39.5%;max-width:45%;min-width:0;padding:4px 8px;gap:3px}
  .stage > .zone.has-actions{top:42%;flex-direction:row;gap:8px}
  .battle:has(.card.targeting) .stage > .zone.z-cast{top:42%}
  .battle:has(.card.targeting) .zone.z-cast .zone-hint{display:none}
  .zone.has-actions .zone-head,.zone.has-actions .zone-actions{flex:1;min-width:0}
  .zone .zone-title{font-size:.78rem;line-height:1.1}
  .zone .zone-hint{font-size:.65rem;line-height:1.1}
  .zone .zone-icon{width:20px;height:22px}
  .zone .zone-head{gap:7px}
  .zone-actions{gap:4px}
  .zone-actions .ctl-note{font-size:.65rem;line-height:1.15;margin:0}
  .zone-actions .btn{padding:5px 9px;font-size:.7rem}
  .stage > .chronicle{left:77%;top:27%;width:20%}
  .chronicle h3{font-size:.6rem}
  .chronicle li{font-size:.65rem;padding:3px 6px}
  .chronicle li:not(:first-child){display:none}
  .stage .pile{top:53%}
  .stage .pile-label{font-size:.55rem;padding:2px 5px}
  .stage .pile-label b{font-size:.8rem}
  .fan-dock{width:calc(100% - 300px);max-width:620px}
  .card{--w:90px}
  .self-hud{width:125px;left:clamp(10px,calc(var(--fan-left,25vw) - 149px),calc(100% - 135px))}
  .mini-controls{width:140px;left:clamp(10px,calc(var(--fan-right,75vw) + 24px),calc(100% - 150px));max-height:84px}
  .self-hud .prompt,.self-hud .tag.host,.self-hud .tag.you,.self-hud .responding .tag.turn{display:none}
  .self-hud .seat-crown{gap:4px}
  .self-hud .sname,.self-hud .team-tag{white-space:nowrap}
  .prompt{font-size:.6rem;padding:3px 6px}
  .ctl-note{font-size:.65rem}
  .mini-controls .btn.small{font-size:.72rem;padding:5px 8px}
  details.fallback summary{font-size:.6rem}
  .hand-hint{display:none}
  .card .plate{margin:3px 3px 0;padding:2px}
  .card .plate .glyph{display:none}
  .card .card-name{font-size:.68rem}
  .card .card-art{flex-basis:43%;margin:3px 4px 0}
  .hand > .card:is(:hover,:focus-within,.selected,.targeting) .card-art{flex-basis:26%}
  .card .ribbon{font-size:.48rem;padding:1px}
  .card .card-effect{font-size:.55rem;margin:2px 4px}
  .card .card-status{font-size:.45rem;padding:1px;margin:0 3px 3px}
}
/* Portrait prioritises actionable state. The same fan gets the full width;
   HUD/controls occupy a separate small row below it, never squeeze it. */
@media (orientation:portrait) and (max-width:760px){
  .topbar{padding:7px 10px;gap:6px;font-size:.7rem}
  .topbar strong{font-size:.85rem}
  .topbar .room-code{font-size:.65rem;letter-spacing:.05em}
  .topbar .mode-pill{font-size:.65rem;padding:2px 5px}
  .stage-wrap{position:absolute;inset:0;container-type:normal}
  .stage{left:0;top:0;transform:none;width:100% !important;height:100% !important;aspect-ratio:auto;container-type:inline-size}
  .table-art{object-fit:cover;object-position:50% 45%}
  .far{left:10px;right:10px;top:48px;gap:9px}
  .knight-stand{flex:1;min-width:0;max-width:210px}
  .knight-stand .knight-fig{height:72px;margin-bottom:-10px;max-width:100%}
  .far .seat:not(.banner-seat){width:100%;min-width:0}
  .far .seat-crown{gap:3px;padding:4px;flex-wrap:wrap}
  .far .seat-crown .screst{width:15px;height:18px}
  .far .seat-crown .sname{font-size:.78rem}
  .far .team-tag{font-size:.55rem;padding:0 4px}
  .far .seat-mid{padding:5px;gap:4px}
  .far .hand-shield{width:26px;height:30px}
  .far .hp-label{font-size:.6rem}
  .far .hp-label b{font-size:.75rem}
  .far .hp-track{height:7px}
  .far .backs{display:none}
  .far .seat-tags{padding:1px 4px 5px;gap:2px}
  .far .tag{font-size:.53rem;padding:0 4px}
  .stage > .centerpiece{left:50%;top:31%;width:max-content;max-width:94%;gap:5px 10px}
  .medallion{width:60px;height:60px}
  .medallion .countdown{font-size:.95rem}
  .phase-banner{font-size:.78rem;padding:5px 15px}
  .turn-line{font-size:.73rem}
  .stage > .zone,.stage > .zone.has-actions{left:50%;top:47%;width:calc(100% - 28px);max-width:none;min-width:0;padding:10px 12px;gap:6px}
  .stage > .zone.has-actions{top:42%;transform:translateX(-50%)}
  .self-hud .prompt,.self-hud .tag.host,.self-hud .tag.you,.self-hud .responding .tag.turn{display:none}
  .self-hud .seat-crown{gap:4px}
  .self-hud .sname,.self-hud .team-tag{white-space:nowrap}
  .zone .zone-title{font-size:.85rem}
  .zone .zone-hint{font-size:.7rem}
  .zone-actions .ctl-note{font-size:.73rem}
  .stage > .chronicle{left:auto;right:12px;top:36%;width:calc(100% - 180px)}
  .chronicle li{font-size:.68rem;padding:3px 6px}
  .chronicle li:not(:first-child){display:none}
  .chronicle h3{font-size:.6rem}
  .stage .pile{top:36%;transform:none}
  .stage .pile.draw{left:12px}
  .stage .pile.discard{left:88px}
  .stage .pile-label{font-size:.52rem;padding:3px 5px}
  .stage .pile-label b{font-size:.85rem}
  .stage .pile .pile-stack.discard{display:none}
  .fan-dock{width:calc(100% - 20px);bottom:135px}
  .card{--w:114px}
  .card .plate{margin:3px 3px 0;padding:3px 2px 3px 3px;align-items:flex-start;justify-content:flex-start;min-height:28px}
  .card .plate .glyph{display:none}
  .card .card-name{font-size:.63rem;text-align:left;width:34px;max-height:none;display:block;overflow:visible}
  .card:is(:hover,:focus-within,.selected,.targeting) .card-name{width:100%;text-align:center;font-size:.76rem}
  .card .card-art{flex-basis:43%;margin:3px 4px 0}
  .card .card-effect{font-size:.6rem;margin:2px 4px}
  .card .ribbon{font-size:.52rem;padding:1px}
  .card .card-status{font-size:.48rem;margin:0 3px 3px;padding:1px}
  .grip-hand{z-index:35;transform:none}
  .self-hud{width:124px;left:68px;top:auto;bottom:12px;transform:none}
  .mini-controls{width:120px;left:auto;right:72px;top:auto;bottom:12px;transform:none;max-height:84px}
  .mini-controls .ctl-note{font-size:.64rem;line-height:1.25}
  .hand-hint{display:none}
  .ctl-note{font-size:.7rem}
  details.fallback summary{font-size:.65rem}
}

`;

const SCRIPT = `
(function () {
  var NS = "http://www.w3.org/2000/svg";
  function s(tag, attrs, kids) {
    var n = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  function svg(viewBox, kids, cls) {
    var a = { viewBox: viewBox, "aria-hidden": "true", focusable: "false" };
    if (cls) a["class"] = cls;
    return s("svg", a, kids);
  }

  // ---- Original vector art (plain shapes; no external or copied assets) --
  // Shield-shaped crest with crossed swords: the Card Clash device.
  function crest(cls) {
    return svg("0 0 120 138", [
      s("defs", null, [
        s("linearGradient", { id: "cg-gold", x1: "0", y1: "0", x2: "0", y2: "1" }, [s("stop", { offset: "0", "stop-color": "#f6dc98" }), s("stop", { offset: "1", "stop-color": "#8f6a2c" })]),
        s("linearGradient", { id: "cg-field", x1: "0", y1: "0", x2: "1", y2: "1" }, [s("stop", { offset: "0", "stop-color": "#b4373e" }), s("stop", { offset: ".5", "stop-color": "#7a2027" }), s("stop", { offset: ".5", "stop-color": "#3b6588" }), s("stop", { offset: "1", "stop-color": "#1e3549" })]),
      ]),
      s("path", { d: "M60 4 L110 18 L110 64 C110 98 88 120 60 134 C32 120 10 98 10 64 L10 18 Z", fill: "url(#cg-gold)" }),
      s("path", { d: "M60 13 L101 25 L101 64 C101 93 83 112 60 124 C37 112 19 93 19 64 L19 25 Z", fill: "url(#cg-field)" }),
      s("path", { d: "M60 13 L101 25 L101 64 C101 93 83 112 60 124 C37 112 19 93 19 64 L19 25 Z", fill: "none", stroke: "#2a1608", "stroke-width": "2", opacity: ".5" }),
      s("g", { stroke: "#2a1608", "stroke-width": "1.2" }, [
        s("path", { d: "M34 98 L82 36 L86 32 L84 38 L38 102 Z", fill: "#e9edf1" }),
        s("path", { d: "M86 98 L38 36 L34 32 L36 38 L82 102 Z", fill: "#dfe4e9" }),
        s("rect", { x: "26", y: "92", width: "24", height: "6", rx: "2", fill: "url(#cg-gold)", transform: "rotate(-52 38 95)" }),
        s("rect", { x: "70", y: "92", width: "24", height: "6", rx: "2", fill: "url(#cg-gold)", transform: "rotate(52 82 95)" }),
      ]),
      s("circle", { cx: "60", cy: "64", r: "11", fill: "url(#cg-gold)", stroke: "#2a1608", "stroke-width": "1.5" }),
      s("path", { d: "M60 57 L62.4 62 L68 62.6 L63.8 66.2 L65 71.6 L60 68.8 L55 71.6 L56.2 66.2 L52 62.6 L57.6 62 Z", fill: "#7a2027" }),
    ], cls);
  }
  // Small house shield (team colour comes from the station CSS).
  function houseShield(team) {
    var fill = team === "A" ? "#9a2f36" : "#355d7d";
    var mark = team === "A"
      ? s("path", { d: "M12 7 L14 12 L19 12 L15 15 L16.5 20 L12 17 L7.5 20 L9 15 L5 12 L10 12 Z", fill: "#f6dc98" })
      : s("path", { d: "M6 9 L18 9 L12 21 Z", fill: "#f6dc98" });
    return svg("0 0 24 28", [
      s("path", { d: "M12 1 L23 4 L23 13 C23 20 18 24.5 12 27 C6 24.5 1 20 1 13 L1 4 Z", fill: "#e2c47e" }),
      s("path", { d: "M12 3 L21 5.5 L21 13 C21 19 17 22.6 12 25 C7 22.6 3 19 3 13 L3 5.5 Z", fill: fill }),
      mark,
    ]);
  }
  function shieldBadge() {
    return svg("0 0 40 46", [
      s("path", { d: "M20 1 L39 6 L39 22 C39 34 31 41 20 45 C9 41 1 34 1 22 L1 6 Z", fill: "#7d5f2a" }),
      s("path", { d: "M20 4 L36 8.5 L36 22 C36 32 29 38 20 41.5 C11 38 4 32 4 22 L4 8.5 Z", fill: "#3a2414" }),
      s("path", { d: "M20 4 L36 8.5 L36 22 C36 32 29 38 20 41.5", fill: "none", stroke: "#e2c47e", "stroke-width": "1", opacity: ".6" }),
    ]);
  }
  function cardCorner() {
    return svg("0 0 20 20", [
      s("path", { d: "M1 1 H16 Q11 3 9 6 Q6 4 4 6 Q6 8 4 10 Q2 12 1 16 Z", fill: "#e2c47e", stroke: "#5c4420", "stroke-width": ".8" }),
      s("circle", { cx: "5", cy: "5", r: "1.6", fill: "#7a2027" }),
    ]);
  }
  function modeEmblem(kind) {
    var kids = [s("path", { d: "M26 2 L50 9 L50 30 C50 46 40 55 26 61 C12 55 2 46 2 30 L2 9 Z", fill: "#e2c47e" })];
    if (kind === "1v1") {
      kids.push(s("path", { d: "M26 6 L46 12 L46 30 C46 44 37 52 26 57 Z", fill: "#355d7d" }));
      kids.push(s("path", { d: "M26 6 L6 12 L6 30 C6 44 15 52 26 57 Z", fill: "#9a2f36" }));
      kids.push(s("path", { d: "M14 44 L38 16 M38 44 L14 16", stroke: "#f4f6f8", "stroke-width": "3.5", "stroke-linecap": "round" }));
    } else if (kind === "1v2") {
      kids.push(s("path", { d: "M26 6 L46 12 L46 30 C46 44 37 52 26 57 C15 52 6 44 6 30 L6 12 Z", fill: "#355d7d" }));
      kids.push(s("path", { d: "M14 48 V26 H18 V20 H22 V26 H30 V20 H34 V26 H38 V48 Z", fill: "#9a2f36", stroke: "#2a1608", "stroke-width": "1" }));
      kids.push(s("path", { d: "M23 48 V40 Q26 36 29 40 V48 Z", fill: "#2a1608" }));
    } else {
      kids.push(s("path", { d: "M26 6 L46 12 L46 30 L26 30 Z", fill: "#9a2f36" }));
      kids.push(s("path", { d: "M26 6 L6 12 L6 30 L26 30 Z", fill: "#355d7d" }));
      kids.push(s("path", { d: "M6 30 L26 30 L26 57 C15 52 6 44 6 30 Z", fill: "#9a2f36" }));
      kids.push(s("path", { d: "M46 30 L26 30 L26 57 C37 52 46 44 46 30 Z", fill: "#355d7d" }));
    }
    return svg("0 0 52 63", kids, "mode-emblem");
  }
  function cardGlyph(type) {
    var p = {
      attack: "M12 1 L14 15 L12 17 L10 15 Z M6 15 H18 V17 H6 Z M11 17 H13 V22 H11 Z",
      dodge: "M12 1 L21 4 V11 C21 17 17 21 12 23 C7 21 3 17 3 11 V4 Z",
      heal: "M6 3 H18 C18 10 15 12 12 12 C9 12 6 10 6 3 Z M11 12 H13 V18 H11 Z M8 18 H16 V21 H8 Z",
      seize: "M5 12 C5 7 8 6 10 6 H17 C19 6 20 8 18 9 C20 10 20 12 18 12 C20 13 19 16 17 16 H10 C7 16 5 15 5 12 Z M5 13 V21 H12 V16 Z",
      disarm: "M11 1 L13 8 L11 10 Z M13 12 L14 17 L12 18 Z M6 18 H18 V20 H6 Z",
      insight: "M1 12 Q12 2 23 12 Q12 22 1 12 Z M12 8 A4 4 0 1 0 12.01 8 Z",
      war_cry: "M3 20 Q2 9 13 5 Q20 2 22 6 Q23 9 19 10 Q11 12 7 20 Z",
      arrow_volley: "M3 21 L15 6 M8 22 L20 7 M13 23 L22 12 M15 6 L11 7 L14 10 Z M20 7 L16 8 L19 11 Z",
    }[type] || "M4 4 H20 V20 H4 Z";
    var stroke = type === "arrow_volley";
    return svg("0 0 24 24", [s("path", stroke ? { d: p, fill: "none", stroke: "#5c3a1c", "stroke-width": "2", "stroke-linecap": "round" } : { d: p, fill: "#5c3a1c" })], "glyph");
  }
  function timerRing() {
    return svg("0 0 96 96", [
      s("circle", { cx: "48", cy: "48", r: "40", fill: "none", stroke: "rgba(226,196,126,.18)", "stroke-width": "6" }),
      s("circle", { id: "countdown-ring", cx: "48", cy: "48", r: "40", fill: "none", stroke: "#e2c47e", "stroke-width": "6", "stroke-linecap": "round", "stroke-dasharray": "251.3", "stroke-dashoffset": "0" }),
    ]);
  }

  // ---- Static card data ---------------------------------------------------
  var CARD_INFO = {
    attack: { name: "Attack", category: "Strike", effect: "Strike a foe. They must Dodge or lose 1 HP." },
    dodge: { name: "Dodge", category: "Defence", effect: "Response: turn aside an Attack or Arrow Volley." },
    heal: { name: "Heal", category: "Blessing", effect: "Restore 1 HP to yourself, or save a dying knight." },
    seize: { name: "Seize", category: "Ploy", effect: "Take a random card from a target's hand." },
    disarm: { name: "Disarm", category: "Ploy", effect: "A target discards a random card, revealed to all." },
    insight: { name: "Insight", category: "Counsel", effect: "Draw 2 extra cards." },
    war_cry: { name: "War Cry", category: "Command", effect: "All others play an Attack or lose 1 HP." },
    arrow_volley: { name: "Arrow Volley", category: "Command", effect: "All others play a Dodge or lose 1 HP." },
  };
  var CARD_NAMES = {};
  for (var key in CARD_INFO) CARD_NAMES[key] = CARD_INFO[key].name;
  var ART = function (type) { return CARD_INFO[type] ? "/card-clash/art/" + type : null; };
  // Hand-tuned crops so each painting keeps its subject in frame.
  var ART_POS = { attack: "50% 35%", dodge: "45% 30%", heal: "45% 30%", seize: "45% 45%", disarm: "40% 35%", insight: "35% 40%", war_cry: "50% 45%", arrow_volley: "50% 55%" };
  var SEAT_TARGETED = { attack: "play_attack", seize: "play_seize", disarm: "play_disarm" };
  var SEATS = { "1v1": 2, "1v2": 3, "2v2": 4 };
  var MODES = [
    { v: "1v1", name: "Duel", count: "2 knights", desc: "One against one. Pure skill, no allies." },
    { v: "1v2", name: "Siege", count: "3 knights", desc: "The host holds the keep (5 HP) against two." },
    { v: "2v2", name: "Alliance", count: "4 knights", desc: "Two houses, two knights each." },
  ];

  var root = document.getElementById("app");
  var code = new URLSearchParams(location.search).get("room");
  var room = null, match = null, es = null, esCode = null;
  var busy = false, targeting = null, selected = {}, chosenMode = "1v1";
  var message = "", deadlineTimer = null, deadlineRefetch = null, requestSeq = 0;
  // Type of the card being dragged (never a card id — cards of a type are
  // fungible to the engine). Mirrored to body[data-drag] purely for CSS.
  var dragType = null;
  // P5: the single in-flight pointer-driven card drag, or null. Replaces
  // native HTML5 drag-and-drop (dragstart/dragover/drop) with pointer
  // events so the drag feels smooth (a floating ghost that tracks the
  // pointer via rAF-batched translate3d) and works the same on touch and
  // mouse. dragType/setDrag/body[data-drag] stay exactly as before — they
  // remain the single shared "what type is being dragged" signal nearly
  // all the drop-target CSS already keys off; this just changes how that
  // signal gets set and how a drop is resolved.
  var pointerDrag = null; // { type, pointerId, sourceEl, startX, startY, startLeft, startTop, lastX, lastY, committed, ghostEl, hoverTarget, rafId }
  var suppressNextClick = false, renderAfterDrag = false;
  // A bounded knight/FX flash from newly confirmed public events only.
  // Foreground hand geometry and assets remain unchanged.
  var combatFx = null; // { ms, knight: {seat: pose}, vfx: [name, anchor] } | null
  var combatFxTimer = null;
  var lastFxMatchId = null, lastFxLogLen = 0;

  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) for (var k in props) {
      if (props[k] === undefined || props[k] === null) continue;
      if (k === "class") n.className = props[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), props[k]);
      else if (k === "disabled") n.disabled = !!props[k];
      else n.setAttribute(k, props[k]);
    }
    (kids || []).forEach(function (c) { if (c === "" || c === null || c === undefined) return; n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
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
  function setCode(c) { code = c; history.replaceState(null, "", "/card-clash?room=" + encodeURIComponent(c)); }

  function refresh(forceRender) {
    if (!code) { render(); return Promise.resolve(); }
    var seq = ++requestSeq;
    return api("GET", base()).then(function (r) {
      if (seq !== requestSeq) return;
      if (!r.ok) { room = null; match = null; message = r.body.error || "Room not found"; render(); return; }
      room = r.body;
      if (room.viewerSeat !== null) connect();
      if (room.status === "waiting") { match = null; render(); return; }
      if (room.viewerSeat === null) { match = null; message = "This room has already started."; render(); return; }
      return api("GET", base() + "/state").then(function (st) {
        if (seq !== requestSeq) return;
        if (st.ok && match && match.matchId === st.body.matchId && st.body.version < match.version) return; // never go backwards
        var changed = !match || !st.ok || st.body.version !== match.version;
        if (st.ok) detectCombatFx(st.body);
        match = st.ok ? st.body : null;
        if (changed) { targeting = null; selected = {}; }
        if (!st.ok) message = st.body.error === "network_error" ? "Connection problem — will refresh when reconnected." : (st.body.error || "Could not load the match");
        if (changed || forceRender === true || !document.getElementById("hand")) render();
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

  // One state-changing request at a time, each with a fresh requestId and
  // the latest authoritative version; never retried automatically. Every
  // input path (button, card click, card drop) calls this one function.
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
      return refresh(true);
    });
  }

  function count(hand, type) { return hand.filter(function (c) { return c.type === type; }).length; }
  function btn(id, label, onclick, disabled, cls) {
    return el("button", { id: "act-" + id, class: "btn " + (cls || ""), disabled: busy || disabled, onclick: onclick }, [label]);
  }
  function others(me) { return match.players.filter(function (p) { return p.seat !== me.seat && !p.eliminated; }); }
  function viewer() { return match.players.filter(function (p) { return p.seat === match.viewerSeat; })[0]; }

  // Single source of truth for "is this card type playable right now" —
  // drives both the card's look and the fallback buttons' disabled state.
  function computeAvailability(me) {
    var avail = {};
    var hand = me.hand || [];
    if (match.matchResult.status === "complete" || me.eliminated) return avail;
    var pending = match.pending;
    if (pending && pending.kind === "attack_response") {
      if (pending.target === me.seat && count(hand, "dodge") > 0) avail.dodge = true;
      return avail;
    }
    if (pending && pending.kind === "group_response") {
      if (pending.context.queue[0] === me.seat && count(hand, pending.context.requiredResponseType) > 0) avail[pending.context.requiredResponseType] = true;
      return avail;
    }
    if (pending && pending.kind === "dying_rescue") {
      if (pending.queue[0] === me.seat && count(hand, "heal") > 0) avail.heal = true;
      return avail;
    }
    if (match.activeSeat !== me.seat || match.turnPhase === "discard") return avail;
    var limit = match.mode === "1v2" && me.seat === 1 ? 2 : 1;
    var living = others(me);
    if (count(hand, "attack") > 0 && match.normalAttacksUsedThisTurn < limit && living.length > 0) avail.attack = true;
    if (count(hand, "heal") > 0 && me.hp < me.maxHp) avail.heal = true;
    if (count(hand, "seize") > 0 && living.some(function (p) { return p.handSize > 0; })) avail.seize = true;
    if (count(hand, "disarm") > 0 && living.some(function (p) { return p.handSize > 0; })) avail.disarm = true;
    if (count(hand, "war_cry") > 0) avail.war_cry = true;
    if (count(hand, "arrow_volley") > 0) avail.arrow_volley = true;
    if (count(hand, "insight") > 0) avail.insight = true;
    return avail;
  }

  // What playing a card of this type does right now: "target" enters the
  // existing targeting flow, "direct" sends the action, null = inert.
  function actionForCardType(me, type) {
    var pending = match.pending;
    if (match.matchResult.status === "complete" || me.eliminated) return null;
    if (pending && pending.kind === "attack_response") return pending.target === me.seat && type === "dodge" ? { kind: "direct", action: "respond_dodge" } : null;
    if (pending && pending.kind === "group_response") {
      var need = pending.context.requiredResponseType;
      if (pending.context.queue[0] !== me.seat || type !== need) return null;
      return { kind: "direct", action: need === "attack" ? "respond_group_attack" : "respond_group_dodge" };
    }
    if (pending && pending.kind === "dying_rescue") return pending.queue[0] === me.seat && type === "heal" ? { kind: "direct", action: "rescue_heal" } : null;
    if (match.activeSeat !== me.seat || match.turnPhase === "discard") return null;
    if (SEAT_TARGETED[type]) return { kind: "target", action: SEAT_TARGETED[type] };
    if (type === "heal") return { kind: "direct", action: "play_heal" };
    if (type === "war_cry") return { kind: "direct", action: "play_war_cry" };
    if (type === "arrow_volley") return { kind: "direct", action: "play_arrow_volley" };
    if (type === "insight") return { kind: "direct", action: "play_insight" };
    return null;
  }

  function setDrag(type) {
    dragType = type;
    if (type) document.body.setAttribute("data-drag", type);
    else document.body.removeAttribute("data-drag");
  }

  // ---- Pointer-driven card drag (P5) ---------------------------------------
  // Replaces native HTML5 drag-and-drop with pointerdown/move/up so dragging
  // feels like a real card-game action: a floating ghost that tracks the
  // pointer via rAF-batched translate3d, valid targets highlighting as the
  // ghost passes over them, an eased return if the drop is cancelled, and
  // the actual play submitted only on a valid drop. A small movement
  // threshold before "committing" to a drag means a plain tap/click still
  // falls through to the card's own onclick untouched — this function only
  // ever runs for cards that are already playable (same gating as before).
  function stripIds(node) {
    if (node.nodeType === 1) {
      if (node.hasAttribute("id")) node.removeAttribute("id");
      node.removeAttribute("tabindex");
    }
    for (var i = 0; i < node.childNodes.length; i++) stripIds(node.childNodes[i]);
  }

  function startCardDrag(e, type) {
    if (busy || pointerDrag || e.button !== 0 || e.isPrimary === false) return;
    var sourceEl = e.currentTarget.closest(".card");
    if (!sourceEl) return;
    var rect = sourceEl.getBoundingClientRect();
    pointerDrag = {
      version: match.version, type: type, pointerId: e.pointerId, sourceEl: sourceEl, handleEl: e.currentTarget,
      startX: e.clientX, startY: e.clientY,
      startLeft: rect.left + (rect.width - sourceEl.offsetWidth) / 2, startTop: rect.top + (rect.height - sourceEl.offsetHeight) / 2,
      width: sourceEl.offsetWidth, height: sourceEl.offsetHeight,
      lastX: e.clientX, lastY: e.clientY,
      committed: false, ghostEl: null, hoverTarget: null, rafId: null,
      threshold: e.pointerType === "mouse" ? 6 : 10,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* capture not required */ }
    e.currentTarget.addEventListener("pointermove", onCardPointerMove);
    e.currentTarget.addEventListener("pointerup", onCardPointerUp);
    e.currentTarget.addEventListener("pointercancel", onCardPointerCancel);
    e.currentTarget.addEventListener("lostpointercapture", onCardPointerCancel);
  }

  function onCardPointerMove(e) {
    if (!pointerDrag || pointerDrag.returning || e.pointerId !== pointerDrag.pointerId) return;
    pointerDrag.lastX = e.clientX;
    pointerDrag.lastY = e.clientY;
    if (!pointerDrag.committed) {
      var dx = pointerDrag.lastX - pointerDrag.startX, dy = pointerDrag.lastY - pointerDrag.startY;
      if (Math.sqrt(dx * dx + dy * dy) <= pointerDrag.threshold) return;
      commitCardDrag();
    }
    e.preventDefault();
    scheduleGhostUpdate();
  }

  function commitCardDrag() {
    pointerDrag.committed = true;
    setDrag(pointerDrag.type);
    pointerDrag.sourceEl.classList.add("drag-source");
    var ghost = pointerDrag.sourceEl.cloneNode(true);
    stripIds(ghost);
    ghost.className = pointerDrag.sourceEl.className + " drag-ghost";
    ghost.style.position = "fixed";
    ghost.style.margin = "0";
    ghost.style.left = pointerDrag.startLeft + "px";
    ghost.style.top = pointerDrag.startTop + "px";
    ghost.style.width = pointerDrag.width + "px";
    ghost.style.height = pointerDrag.height + "px";
    document.body.appendChild(ghost);
    pointerDrag.ghostEl = ghost;
    iterateDropTargets(true);
  }

  function scheduleGhostUpdate() {
    if (!pointerDrag || pointerDrag.rafId) return;
    pointerDrag.rafId = requestAnimationFrame(function () {
      if (pointerDrag) pointerDrag.rafId = null;
      applyGhostTransform();
    });
  }

  function applyGhostTransform() {
    if (!pointerDrag || pointerDrag.returning || !pointerDrag.ghostEl) return;
    var dx = pointerDrag.lastX - pointerDrag.startX, dy = pointerDrag.lastY - pointerDrag.startY;
    pointerDrag.ghostEl.style.transform = "translate3d(" + dx.toFixed(1) + "px," + dy.toFixed(1) + "px,0) rotate(-4deg) scale(1.06)";
    updateHoverTarget(resolveDropTarget(pointerDrag.lastX, pointerDrag.lastY));
  }

  // pointer-events:none on the entire ghost subtree excludes it from hit-testing.
  function resolveDropTarget(x, y) {
    if (!pointerDrag) return null;
    var hit = document.elementFromPoint(x, y);

    var dropEl = hit && hit.closest ? hit.closest("[data-drop]") : null;
    if (!dropEl) return null;
    var types = (dropEl.getAttribute("data-drop") || "").split(" ").filter(Boolean);
    return types.indexOf(pointerDrag.type) !== -1 ? dropEl : null;
  }

  function updateHoverTarget(target) {
    if (!pointerDrag || pointerDrag.hoverTarget === target) return;
    if (pointerDrag.hoverTarget) pointerDrag.hoverTarget.classList.remove("drop-ready", "zone-active");
    if (target) target.classList.add(target.hasAttribute("data-zone") ? "zone-active" : "drop-ready");
    pointerDrag.hoverTarget = target;
  }

  // Toggles .drop-ok on every drop-eligible element at drag-commit time,
  // when the dragged type is actually known. (Incidental fix: the old
  // native-DnD code computed this class at RENDER time from dragType, but
  // dragType was only ever set inside dragstart — after the last render —
  // so eligible-seat highlighting never actually activated during a real
  // drag; only the blanket body[data-drag] dimming did. Doing it
  // imperatively here fixes that as a side effect of the rework.)
  function iterateDropTargets(on) {
    var els = document.querySelectorAll("[data-drop]");
    for (var i = 0; i < els.length; i++) {
      var types = (els[i].getAttribute("data-drop") || "").split(" ").filter(Boolean);
      els[i].classList.toggle("drop-ok", !!(on && pointerDrag && types.indexOf(pointerDrag.type) !== -1));
    }
  }

  function endCardDragListeners() {
    var handle = pointerDrag && pointerDrag.handleEl;
    if (!handle) return;
    handle.removeEventListener("pointermove", onCardPointerMove);
    handle.removeEventListener("pointerup", onCardPointerUp);
    handle.removeEventListener("pointercancel", onCardPointerCancel);
    handle.removeEventListener("lostpointercapture", onCardPointerCancel);
    try { handle.releasePointerCapture(pointerDrag.pointerId); } catch (err) { /* already released */ }
  }

  function onCardPointerUp(e) {
    if (!pointerDrag || e.pointerId !== pointerDrag.pointerId) return;
    var drag = pointerDrag;
    endCardDragListeners();
    if (!drag.committed) { pointerDrag = null; return; } // plain tap: let the native click fire
    var target = resolveDropTarget(e.clientX, e.clientY);
    suppressNextClick = true;
    if (target) {
      var me = viewer();
      var action = me && actionForCardType(me, drag.type);
      if (target.hasAttribute("data-seat") && action && action.kind === "target" && action.action === SEAT_TARGETED[drag.type]) {
        var seatNum = Number(target.getAttribute("data-seat"));
        finishCardDrag();
        send(action.action, { targetSeat: seatNum });
        return;
      }
      if (target.hasAttribute("data-zone") && action && action.kind === "direct") {
        finishCardDrag();
        send(action.action);
        return;
      }
    }
    cancelCardDrag();
  }

  function onCardPointerCancel(e) {
    if (!pointerDrag || e.pointerId !== pointerDrag.pointerId) return;
    endCardDragListeners();
    cancelCardDrag();
  }

  function finishCardDrag() {
    var drag = pointerDrag;
    if (!drag) return;
    if (drag.rafId) cancelAnimationFrame(drag.rafId);
    if (drag.ghostEl && drag.ghostEl.parentNode) drag.ghostEl.parentNode.removeChild(drag.ghostEl);
    if (drag.hoverTarget) drag.hoverTarget.classList.remove("drop-ready", "zone-active");
    if (drag.sourceEl) drag.sourceEl.classList.remove("drag-source");
    iterateDropTargets(false);
    setDrag(null);
    pointerDrag = null;
    if (renderAfterDrag) { renderAfterDrag = false; requestAnimationFrame(render); }
  }

  // An invalid/cancelled drop: ease the ghost back to its origin, then
  // clean up — same end state as finishCardDrag, just with a visible
  // return instead of an instant removal.
  function cancelCardDrag() {
    var drag = pointerDrag;
    if (!drag || !drag.committed || !drag.ghostEl) { finishCardDrag(); return; }
    if (drag.rafId) { cancelAnimationFrame(drag.rafId); drag.rafId = null; }
    drag.returning = true;
    if (drag.hoverTarget) drag.hoverTarget.classList.remove("drop-ready", "zone-active");
    var ghost = drag.ghostEl;
    ghost.classList.add("returning");
    ghost.style.transform = "translate3d(0,0,0) rotate(0deg) scale(1)";
    var done = false;
    var finish = function () { if (!done) { done = true; if (pointerDrag === drag) finishCardDrag(); } };
    ghost.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 220);
  }

  // Lighter teardown for when render() is about to wipe the original card
  // node out from under an in-flight drag (an SSE-triggered mid-drag state
  // change) — no return-animation, since the source is gone anyway.
  function abortCardDrag() {
    if (!pointerDrag) return;
    suppressNextClick = pointerDrag.committed;
    endCardDragListeners();
    finishCardDrag();
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && pointerDrag) { suppressNextClick = pointerDrag.committed; endCardDragListeners(); cancelCardDrag(); }
    else suppressNextClick = false;
  });

  // A committed drag suppresses the browser's post-pointerup synthetic
  // click once, so releasing over the original (now-dimmed) card doesn't
  // also fire its onclick/targeting logic. A plain tap never sets this
  // flag, so normal click-to-play is completely unaffected.
  document.addEventListener("pointerdown", function () { suppressNextClick = false; }, true);
  document.addEventListener("click", function (e) {
    if (suppressNextClick) { suppressNextClick = false; if (e.detail !== 0) { e.preventDefault(); e.stopPropagation(); } }
  }, true);

  // ---- Card ---------------------------------------------------------------
  // Anatomy: brass rim > dark inner bed > ornamental corners > raised title
  // plate > recessed art window (painting) > type ribbon > rules text >
  // status footer. Only the painting is an image; all text is live HTML.
  function cardFace(type, statusText) {
    var info = CARD_INFO[type] || { name: type, category: type, effect: "" };
    var art = ART(type);
    return [
      el("span", { class: "plate" }, [cardGlyph(type), el("span", { class: "card-name" }, [info.name])]),
      el("span", { class: "card-art" }, [art ? el("img", { class: "card-art-img", src: art, alt: "", "aria-hidden": "true", loading: "lazy", draggable: "false", style: "object-position:" + (ART_POS[type] || "50% 40%") }, []) : ""]),
      el("span", { class: "ribbon" }, [info.category]),
      el("span", { class: "card-effect" }, [info.effect]),
      el("span", { class: "card-status" }, [statusText]),
    ];
  }
  function cardShell(type, extraClass, button) {
    var corners = ["tl", "tr", "bl", "br"].map(function (p) { return el("span", { class: "corner " + p }, [cardCorner()]); });
    return el("div", { class: "card card-" + type + (extraClass ? " " + extraClass : "") }, [el("span", { class: "rim" }, [])].concat(corners).concat([button]));
  }

  function handCardNode(me, c, inDiscard, playable) {
    var info = CARD_INFO[c.type] || { name: c.type, effect: "" };
    if (inDiscard) {
      var isSel = !!selected[c.id];
      var b = el("button", {
        id: "card-" + c.id, "aria-pressed": isSel ? "true" : "false", disabled: busy,
        "aria-label": info.name + (isSel ? " — selected for discard" : " — select to discard"),
        onclick: function () { selected[c.id] = !selected[c.id]; render(); },
      }, cardFace(c.type, isSel ? "Discarding" : "Tap to discard"));
      return cardShell(c.type, isSel ? "selected" : "discardable", b);
    }
    var action = playable ? actionForCardType(me, c.type) : null;
    var isTargeting = action && action.kind === "target" && targeting === action.action;
    var status = !playable ? "Not now" : isTargeting ? "Choose a target" : action && action.kind === "target" ? "Drag to a foe" : "Tap to play";
    var props = {
      id: "cardplay-" + c.id,
      disabled: busy || !playable || !action,
      "aria-label": info.name + ": " + info.effect + (playable ? "" : " (not playable now)"),
      onclick: function () {
        if (!playable || busy || !action) return;
        if (action.kind === "target") { targeting = targeting === action.action ? null : action.action; render(); }
        else send(action.action);
      },
    };
    if (playable && action) {
      props.onpointerdown = function (e) { startCardDrag(e, c.type); };
      props.style = "touch-action:none";
    }
    return cardShell(c.type, (playable ? "playable" : "unavailable") + (isTargeting ? " targeting" : ""), el("button", props, cardFace(c.type, status)));
  }

  // ---- Controls (fallback + decisive buttons; cards are primary) ---------
  function controls(me) {
    var done = match.matchResult.status === "complete";
    var hand = me.hand || [];
    var pending = match.pending;
    var avail = computeAvailability(me);
    if (done) return [el("p", { class: "ctl-note muted" }, ["The match is over."])];
    if (me.eliminated) return [el("p", { class: "ctl-note muted", id: "spectating" }, ["You are eliminated — spectating."])];
    function waiting(text) { return el("p", { class: "ctl-note muted", id: "waiting" }, [text]); }
    function group(cls, kids) { return el("div", { class: "ctl-group " + cls }, kids); }

    // P5: when the viewer themself must answer an attack/group/rescue
    // response, the note + decision buttons render center-stage instead
    // (see centerResponseActions, consumed by battleTable's .zone) — the
    // rail stays empty rather than duplicating them. A bystander still
    // sees their own "waiting on seat N" note here, unchanged.
    if (pending && pending.kind === "attack_response") {
      if (pending.target !== me.seat) return [waiting("Seat " + pending.target + " must respond to the Attack from seat " + pending.attacker + ".")];
      return [];
    }
    if (pending && pending.kind === "group_response") {
      var ctx = pending.context, who = ctx.queue[0];
      var cardName = ctx.cardType === "war_cry" ? "War Cry" : "Arrow Volley";
      if (who !== me.seat) return [waiting("Seat " + who + " must respond to " + cardName + " from seat " + ctx.actor + ".")];
      return [];
    }
    if (pending && pending.kind === "dying_rescue") {
      var rescuer = pending.queue[0];
      if (rescuer !== me.seat) return [waiting("Seat " + pending.dyingSeat + " is dying. Waiting on seat " + rescuer + " to rescue.")];
      return [];
    }
    if (match.activeSeat !== me.seat) return [waiting("Waiting for seat " + match.activeSeat + " to play.")];

    if (match.turnPhase === "discard") {
      var excess = hand.length - me.hp;
      var ids = Object.keys(selected).filter(function (k) { return selected[k]; });
      return [group("discard", [
        el("p", { class: "ctl-note", id: "discard-note" }, ["DISCARD: choose " + Math.max(0, excess) + " card(s) to discard (hand limit = HP " + me.hp + ")."]),
        el("div", { class: "ctl-row" }, [
          btn("discard_cards", "Discard selected (" + ids.length + ")", function () { send("discard_cards", { cardIds: ids }); }, ids.length === 0, "primary small"),
        ]),
      ])];
    }

    var living = others(me);
    if (targeting) {
      var pool = living.filter(function (p) { return targeting === "play_attack" || p.handSize > 0; });
      var row = [el("span", { class: "ctl-label" }, ["Target"])];
      pool.forEach(function (p) {
        row.push(el("button", { id: "target-" + p.seat, class: "btn gold small", disabled: busy, onclick: function () { var t = targeting; send(t, { targetSeat: p.seat }); } }, ["Seat " + p.seat + " (Team " + p.team + ")"]));
      });
      if (pool.length === 0) row.push(el("span", { class: "ctl-note muted" }, ["No valid targets."]));
      row.push(el("button", { id: "cancel-target", class: "btn ghost small", onclick: function () { targeting = null; render(); } }, ["Cancel"]));
      return [group("targeting", [
        el("p", { class: "ctl-note" }, ["Choose a target for " + targeting.replace("play_", "").replace(/_/g, " ") + " — tap a seat below, or drag the card onto a station."]),
        el("div", { class: "ctl-row" }, row),
      ])];
    }
    var t = function (type) { return function () { targeting = targeting === type ? null : type; render(); }; };
    var quick = el("div", { class: "ctl-row" }, [
      btn("play_attack", "Attack", t("play_attack"), !avail.attack, "ghost small"),
      btn("play_heal", "Heal (self)", function () { send("play_heal"); }, !avail.heal, "ghost small"),
      btn("play_seize", "Seize", t("play_seize"), !avail.seize, "ghost small"),
      btn("play_disarm", "Disarm", t("play_disarm"), !avail.disarm, "ghost small"),
      btn("play_war_cry", "War Cry", function () { send("play_war_cry"); }, !avail.war_cry, "ghost small"),
      btn("play_arrow_volley", "Arrow Volley", function () { send("play_arrow_volley"); }, !avail.arrow_volley, "ghost small"),
      btn("play_insight", "Insight (draw 2)", function () { send("play_insight"); }, !avail.insight, "ghost small"),
    ]);
    return [group("main", [
      el("div", { class: "ctl-row" }, [btn("end_turn", "End Turn", function () { send("end_turn"); }, false, "primary small")]),
      el("details", { class: "fallback" }, [el("summary", null, ["Quick actions (keyboard / accessibility)"]), quick]),
    ])];
  }

  // ---- Lobby: tournament entrance -----------------------------------------
  function lobbyEntry() {
    var select = el("select", { id: "mode", class: "sr-only", "aria-label": "Game mode", tabindex: "-1" }, MODES.map(function (m) { return el("option", { value: m.v }, [m.v]); }));
    select.value = chosenMode;
    var modeCards = MODES.map(function (m) {
      var input = el("input", { type: "radio", name: "cc-mode", value: m.v, "aria-label": m.name + " (" + m.v + ")" });
      if (m.v === chosenMode) input.checked = true;
      input.addEventListener("change", function () { chosenMode = m.v; select.value = m.v; render(); });
      return el("label", { class: "mode" + (m.v === chosenMode ? " on" : "") }, [
        input, modeEmblem(m.v),
        el("span", { class: "mode-text" }, [
          el("span", { class: "mode-name" }, [m.name]),
          el("span", { class: "mode-count" }, [m.v + " · " + m.count]),
          el("span", { class: "mode-desc" }, [m.desc]),
        ]),
      ]);
    });
    var input = el("input", { id: "room-code", class: "field", placeholder: "ROOM CODE", "aria-label": "Room code", maxlength: "16", autocomplete: "off" });
    function join() {
      var c = input.value.trim().toUpperCase();
      if (!c) return;
      setCode(c);
      api("POST", base() + "/join", {}).then(function (r) { message = r.ok ? "" : (r.body.error || "Could not join"); refresh(); });
    }
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") join(); });
    return el("div", { class: "gate" }, [
      el("div", { class: "crest-hero" }, [
        crest("crest"),
        el("h1", { class: "title" }, ["Card Clash"]),
        el("div", { class: "title-rule" }, ["The Knight's War Table"]),
        el("p", { class: "subtitle" }, ["Gather your house, draw your hand and outwit rival knights across the table — every move must be made within ten seconds."]),
      ]),
      error(),
      el("div", { class: "entry-grid" }, [
        el("section", { class: "plaque entry", "aria-labelledby": "create-h" }, [
          el("h2", { id: "create-h" }, ["Muster a Company"]),
          el("p", { class: "lede" }, ["Found a new room, choose the battle, then send the invitation to your rivals."]),
          el("div", { class: "modes", role: "radiogroup", "aria-label": "Game mode" }, modeCards),
          select,
          el("div", { class: "entry-actions" }, [el("button", { class: "btn primary big", id: "create", onclick: function () {
            api("POST", "/api/card-clash/rooms", { mode: select.value }).then(function (r) {
              if (!r.ok) { message = r.body.error || "Could not create room"; render(); return; }
              message = ""; setCode(r.body.code); refresh();
            });
          } }, ["Create Room"])]),
        ]),
        el("section", { class: "plaque entry", "aria-labelledby": "join-h" }, [
          el("h2", { id: "join-h" }, ["Answer the Call"]),
          el("p", { class: "lede" }, ["Hold an invitation? Enter its room code to take your seat."]),
          el("div", { class: "join-row" }, [input, el("button", { class: "btn gold", id: "join", onclick: join }, ["Join Room"])]),
          el("div", { class: "how" }, [
            el("h3", null, ["How a duel unfolds"]),
            el("ol", null, [
              el("li", null, ["Each turn you draw, then play cards from your hand."]),
              el("li", null, ["Attacks must be Dodged; War Cry and Arrow Volley strike everyone."]),
              el("li", null, ["At 0 HP any knight may Heal you — otherwise you fall."]),
              el("li", null, ["The last house standing wins the table."]),
            ]),
          ]),
        ]),
      ]),
    ]);
  }

  // ---- Room assembly: war council ------------------------------------------
  function lobbyRoom() {
    var need = SEATS[room.mode];
    var taken = {};
    room.seats.forEach(function (st) { taken[st.seatNumber] = st; });
    var modeName = (MODES.filter(function (m) { return m.v === room.mode; })[0] || {}).name || room.mode;
    var banners = [];
    for (var n = 1; n <= need; n++) {
      var st = taken[n], t = teamFor(room.mode, n), me = room.viewerSeat === n;
      banners.push(el("div", { class: "banner-wrap" }, [
        el("span", { class: "banner-pole", "aria-hidden": "true" }, []),
        el("div", { class: "seat banner-seat " + t.toLowerCase() + (st ? "" : " vacant") + (me ? " me" : "") }, [
          el("span", { class: "bcrest" }, [houseShield(t)]),
          el("span", { class: "bseat" }, ["Seat " + n]),
          el("span", { class: "btags" }, [
            el("span", { class: "tag" }, ["Team " + t]),
            n === 1 ? el("span", { class: "tag host" }, ["Host"]) : "",
            me ? el("span", { class: "tag you" }, ["You"]) : "",
          ]),
          st ? el("span", { class: "seal " + (st.ready ? "ready" : "notready") }, [st.ready ? "Ready" : "Not ready"]) : el("span", { class: "seal empty" }, ["Empty"]),
        ]),
      ]));
    }
    var link = location.origin + "/card-clash?room=" + encodeURIComponent(room.code);
    var mySeat = taken[room.viewerSeat];
    var allReady = room.seats.length === need && room.seats.every(function (x) { return x.ready; });
    var actions = [];
    if (room.viewerSeat === null) {
      actions.push(el("button", { class: "btn primary big", id: "join-here", onclick: function () { act("/join", {}); } }, ["Join this room"]));
    } else {
      actions.push(el("button", { class: "btn " + (mySeat && mySeat.ready ? "ghost" : "gold"), id: "ready", onclick: function () { act("/ready", { ready: !(mySeat && mySeat.ready) }); } }, [mySeat && mySeat.ready ? "Not ready" : "Ready"]));
      if (room.viewerSeat === 1) actions.push(el("button", { class: "btn primary big", id: "start", disabled: !allReady, onclick: function () { act("/start", {}); } }, ["Start Game"]));
    }
    var filled = room.seats.length, readyCount = room.seats.filter(function (x) { return x.ready; }).length;
    var hint = filled < need ? "Waiting for " + (need - filled) + " more knight" + (need - filled === 1 ? "" : "s") + " to answer the invitation."
      : !allReady ? readyCount + " of " + need + " knights are ready." : room.viewerSeat === 1 ? "All knights are ready — begin when you will." : "All knights are ready — waiting for the host to begin.";
    return el("div", { class: "council" }, [
      el("div", { class: "council-head" }, [
        crest("crest"),
        el("div", null, [
          el("h1", null, ["Room " + room.code + " (" + room.mode + ")"]),
          el("div", { class: "room-meta" }, [modeName + " — the war council assembles"]),
        ]),
      ]),
      error(),
      el("div", { class: "banners" }, banners),
      el("div", { class: "plaque dispatch" }, [
        el("div", null, [
          el("div", { class: "invite-label" }, ["Invitation"]),
          el("div", { class: "invite-line" }, [
            el("input", { id: "invite", class: "field", readonly: "readonly", value: link, "aria-label": "Invite link" }),
            el("button", { id: "copy", class: "btn", onclick: function () {
              if (navigator.clipboard) navigator.clipboard.writeText(link).then(function () { message = "Invite link copied."; render(); });
              else { document.getElementById("invite").select(); message = "Press Ctrl+C to copy."; render(); }
            } }, ["Copy Invite Link"]),
          ]),
        ]),
        el("div", { class: "council-actions" }, actions),
        el("p", { class: "hint" }, [hint]),
      ]),
    ]);
  }

  // ---- Battle -------------------------------------------------------------
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
  function phaseClass() {
    if (match.matchResult.status === "complete") return "p-done";
    if (match.pending) return "p-response";
    return match.turnPhase === "discard" ? "p-discard" : "";
  }

  // A player station. Opponent stations accept targeted-card drops when
  // dropTypes lists the dragged type; legality is still re-checked server-side.
  // The opponent knight's pose, from public state only (P2): never anything
  // that would leak a hidden card. "kneel" for eliminated or the current
  // dying-rescue target, "block" for whoever must respond right now
  // (attack/group response), "idle" otherwise — including on their own
  // active turn, since no card has actually been played yet. The one
  // transient exception is combatFx (P4): a bounded pose override, keyed by
  // seat, set only from a confirmed attack_played/group_card_played/etc.
  // event (see fxFor/detectCombatFx below) and auto-cleared on its own
  // timer — never a guess at what's about to happen.
  function knightPoseFor(p) {
    if (p.eliminated) return "kneel";
    var pending = match.pending;
    if (pending) {
      if (pending.kind === "dying_rescue" && pending.dyingSeat === p.seat) return "kneel";
      if (pending.kind === "attack_response" && pending.target === p.seat) return "block";
      if (pending.kind === "group_response" && pending.context.queue[0] === p.seat) return "block";
    }
    if (combatFx && combatFx.knight && combatFx.knight[p.seat]) return combatFx.knight[p.seat];
    return "idle";
  }

  function mkPose(seat, pose) { var o = {}; o[seat] = pose; return o; }

  // P4: maps one already-public PublicEvent (see types.ts's exhaustive
  // union — nothing outside it is ever consulted) to a bounded combat
  // flash: an optional knight pose override (mkPose), an optional FX
  // sprite anchored at a seat or "center" (/card-clash/fx/:name, itself a
  // fixed allowlist server-side), while the foreground gauntlets remain stable. Events
  // with no distinct combat visual (a declined rescue offer, the second of
  // disarm's two log entries) return null — the Chronicle text already
  // covers them, and a flash on every entry would cheapen the ones that
  // matter. Durations sit in the 150–650ms range the brief calls for.
  function fxFor(e) {
    switch (e.type) {
      case "attack_played": return { ms: 550, knight: mkPose(e.actor, "attack"), vfx: ["sword_slash", e.target] };
      case "dodge_played": return { ms: 450, knight: mkPose(e.actor, "block"), vfx: ["shield_block", e.actor] };
      case "attack_response_declined": return { ms: 450, knight: mkPose(e.actor, "hit"), vfx: ["physical_impact", e.actor] };
      case "heal_played": return { ms: 500, knight: null, vfx: ["healing", e.target] };
      case "rescue_declined": return null;
      case "eliminated": return { ms: 500, knight: null, vfx: ["physical_impact", e.seat] };
      case "match_complete": return { ms: 650, knight: null, vfx: ["victory", "center"] };
      case "seize_played": return { ms: 400, knight: null, vfx: ["card_cast", e.target] };
      case "disarm_played": return { ms: 400, knight: null, vfx: ["card_cast", e.target] };
      case "disarm_card_revealed": return null;
      case "insight_played": return { ms: 400, knight: null, vfx: ["card_cast", e.actor] };
      case "group_card_played": return { ms: 550, knight: mkPose(e.actor, "attack"), vfx: ["card_cast", e.actor] };
      case "group_response_played":
        return e.responseType === "dodge"
          ? { ms: 450, knight: mkPose(e.actor, "block"), vfx: ["shield_block", e.actor] }
          : { ms: 450, knight: mkPose(e.actor, "attack"), vfx: ["sword_slash", e.actor] };
      case "group_response_declined": return { ms: 450, knight: mkPose(e.actor, "hit"), vfx: ["physical_impact", e.actor] };
    }
    return null;
  }

  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (err) { return false; }
  }

  // Turns newly-arrived match.publicLog entries into at most one bounded
  // combatFx flash. Tracks (matchId, log length) itself — NOT match.version,
  // since version also bumps for things with no combat visual at all — so a
  // fresh page load or a reconnect on an already-in-progress match always
  // treats the existing log as history (no flash), and only entries added
  // since the last check are "new". If several land between polls (a missed
  // SSE tick, a backgrounded tab), only the latest is flashed: a momentary
  // readout of "what just happened", not a replay queue.
  function detectCombatFx(newMatch) {
    if (!newMatch || !newMatch.publicLog) return;
    if (newMatch.matchId !== lastFxMatchId) {
      lastFxMatchId = newMatch.matchId;
      lastFxLogLen = newMatch.publicLog.length;
      clearTimeout(combatFxTimer);
      combatFx = null;
      return;
    }
    if (newMatch.publicLog.length <= lastFxLogLen) return;
    var fresh = newMatch.publicLog.slice(lastFxLogLen);
    lastFxLogLen = newMatch.publicLog.length;
    if (reducedMotion()) return;
    var desc = fxFor(fresh[fresh.length - 1]);
    if (!desc) return;
    clearTimeout(combatFxTimer);
    combatFx = desc;
    combatFxTimer = setTimeout(function () { combatFx = null; render(); }, desc.ms);
  }

  function vfxImg(name, ms) {
    return el("img", { class: "vfx-flash", src: "/card-clash/fx/" + name, alt: "", "aria-hidden": "true", draggable: "false", style: "animation-duration:" + ms + "ms" }, []);
  }

  function seatPanel(p, done, compact, dropTypes) {
    var responding = !done && match.deadline && match.deadline.responderSeat === p.seat && match.pending;
    var won = done && match.matchResult.winningTeam === p.team;
    var pct = Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100));
    var props = { class: "seat team-" + p.team.toLowerCase() + (compact ? " compact" : "") + (responding ? " responding" : "") + (p.seat === match.activeSeat && !done ? " active" : "") + (p.seat === match.viewerSeat ? " me" : "") + (p.eliminated ? " out" : "") + (won ? " won" : "") };
    if (dropTypes && dropTypes.length) {
      props["data-drop"] = dropTypes.join(" ");
      props["data-seat"] = String(p.seat);
      // Tap-to-target: while a targeted card is chosen, valid stations light
      // up and accept a tap, mirroring the target buttons in the controls.
      // (Pointer-drag drop handling itself lives in onCardPointerUp/
      // resolveDropTarget, keyed off data-drop/data-seat above — no
      // per-element drag listeners needed here any more.)
      if (targeting && !p.eliminated && (targeting === "play_attack" || p.handSize > 0)) {
        props.class += " pick";
        props.onclick = function () { if (!busy && targeting) send(targeting, { targetSeat: p.seat }); };
      }
    }
    var pips = [];
    for (var i = 0; i < p.maxHp; i++) pips.push(el("i", null, []));
    var backs = [];
    if (p.seat !== match.viewerSeat) for (var j = 0; j < p.handSize; j++) backs.push(el("span", { class: "back", "aria-hidden": "true" }, []));
    var fxHere = combatFx && combatFx.vfx && combatFx.vfx[1] === p.seat ? vfxImg(combatFx.vfx[0], combatFx.ms) : "";
    return el("div", props, [
      fxHere,
      el("div", { class: "seat-crown" }, [
        el("span", { class: "screst" }, [houseShield(p.team)]),
        el("span", { class: "sname" }, ["Seat " + p.seat]),
        el("span", { class: "team-tag " + p.team.toLowerCase() }, ["Team " + p.team]),
      ]),
      el("div", { class: "seat-mid" }, [
        el("div", { class: "hp" }, [
          el("div", { class: "hp-label" }, [el("span", null, ["HP"]), el("b", null, [p.hp + "/" + p.maxHp])]),
          el("div", { class: "hp-track", role: "img", "aria-label": "HP " + p.hp + " of " + p.maxHp }, [el("div", { class: "hp-fill", style: "width:" + pct + "%" }, []), el("span", { class: "hp-pips" }, pips)]),
        ]),
        el("span", { class: "hand-shield", title: "Cards in hand" }, [shieldBadge(), el("b", null, [String(p.handSize)]), el("span", { class: "sr-only" }, ["Cards: " + p.handSize + (p.eliminated ? " (eliminated)" : "")])]),
      ]),
      el("div", { class: "seat-tags" }, [
        p.seat === 1 ? el("span", { class: "tag host" }, ["Host"]) : "",
        p.seat === match.viewerSeat ? el("span", { class: "tag you" }, ["You"]) : "",
        p.eliminated ? el("span", { class: "tag out" }, ["Eliminated"]) : "",
        won ? el("span", { class: "tag turn" }, ["Victor"]) : "",
        !done && p.seat === match.activeSeat ? el("span", { class: "tag turn" }, ["Active turn"]) : "",
        responding ? el("span", { class: "tag wait" }, ["Must respond"]) : "",
      ]),
      backs.length ? el("div", { class: "backs", "aria-hidden": "true" }, backs) : "",
    ]);
  }

  // The shared drop zone on the table, only when the viewer can play there.
  function centralZoneInfo(me) {
    if (!me) return null;
    var pending = match.pending;
    if (pending && pending.kind === "attack_response" && pending.target === me.seat) return { types: ["dodge"], cls: "z-response", title: "Defend yourself", hint: "Drop or tap your Dodge card." };
    if (pending && pending.kind === "group_response" && pending.context.queue[0] === me.seat) {
      var need = pending.context.requiredResponseType;
      return { types: [need], cls: "z-response", title: "Answer the " + (pending.context.cardType === "war_cry" ? "War Cry" : "Arrow Volley"), hint: "Drop or tap your " + (need === "attack" ? "Attack" : "Dodge") + " card." };
    }
    if (pending && pending.kind === "dying_rescue" && pending.queue[0] === me.seat) return { types: ["heal"], cls: "z-rescue", title: "Rescue seat " + pending.dyingSeat, hint: "Drop or tap your Heal card to save them." };
    if (!pending && match.activeSeat === me.seat && match.turnPhase !== "discard" && match.matchResult.status !== "complete") {
      return { types: ["heal", "insight", "war_cry", "arrow_volley"], cls: "z-cast", title: "Cast on the table", hint: "Heal · Insight · War Cry · Arrow Volley — strikes and ploys go onto a foe." };
    }
    return null;
  }

  // P5: the decision buttons for whichever pending response/rescue names
  // the viewer as its current responder, rendered into the center-stage
  // .zone (battleTable) instead of the bottom rail — the brief's "don't
  // bury the combat question in the bottom control area." Mirrors exactly
  // what controls() used to return for these three pending kinds (same
  // ids, same copy, same computeAvailability gating); controls() itself
  // now returns [] for a responder (see above) so this is the only place
  // that markup exists, not a second copy of it. Returns [] for every
  // bystander/no-pending case — battleTable only calls this when
  // centralZoneInfo(me) already identified the viewer as the responder.
  function centerResponseActions(me) {
    var pending = match.pending;
    var avail = computeAvailability(me);
    if (pending && pending.kind === "attack_response" && pending.target === me.seat) {
      return [
        el("p", { class: "ctl-note" }, ["Seat " + pending.attacker + " attacked you. Play Dodge or take 1 damage."]),
        el("div", { class: "ctl-row" }, [
          btn("respond_dodge", "Dodge", function () { send("respond_dodge"); }, !avail.dodge, "gold small"),
          btn("decline_attack_response", "Take the hit", function () { send("decline_attack_response"); }, false, "primary small"),
        ]),
      ];
    }
    if (pending && pending.kind === "group_response" && pending.context.queue[0] === me.seat) {
      var ctx = pending.context, need = ctx.requiredResponseType;
      var cardName = ctx.cardType === "war_cry" ? "War Cry" : "Arrow Volley";
      return [
        el("p", { class: "ctl-note" }, [cardName + " from seat " + ctx.actor + ": play " + (need === "attack" ? "an Attack" : "a Dodge") + " or take 1 damage."]),
        el("div", { class: "ctl-row" }, [
          btn(need === "attack" ? "respond_group_attack" : "respond_group_dodge", need === "attack" ? "Play Attack" : "Play Dodge",
            function () { send(need === "attack" ? "respond_group_attack" : "respond_group_dodge"); }, !avail[need], "gold small"),
          btn("decline_group_response", "Take the hit", function () { send("decline_group_response"); }, false, "primary small"),
        ]),
      ];
    }
    if (pending && pending.kind === "dying_rescue" && pending.queue[0] === me.seat) {
      return [
        el("p", { class: "ctl-note", id: "rescue-note" }, ["Seat " + pending.dyingSeat + " is dying" + (pending.dyingSeat === me.seat ? " (you)" : "") + ". Play Heal to save them?"]),
        el("div", { class: "ctl-row" }, [
          btn("rescue_heal", "Heal", function () { send("rescue_heal"); }, !avail.heal, "gold small"),
          btn("decline_rescue", "Decline", function () { send("decline_rescue"); }, false, "ghost small"),
        ]),
      ];
    }
    return [];
  }

  function battleTable(me, opponents) {
    var done = match.matchResult.status === "complete";
    var deadline = match.deadline;
    var log = match.publicLog.slice(-3).reverse();
    var top = match.discardPile.length ? match.discardPile[match.discardPile.length - 1] : null;
    var zone = centralZoneInfo(me);

    var drawStack = el("div", { class: "pile draw" }, [
      el("span", { class: "pile-stack draw", "aria-hidden": "true" }, [el("i", null, []), el("i", null, []), el("i", null, [])]),
      el("span", { class: "pile-label" }, ["Draw pile", el("b", null, [String(match.drawPileCount)])]),
    ]);
    var discardKids = top
      ? [el("i", null, []), el("i", null, []), el("i", { class: "top" }, [ART(top.type) ? el("img", { src: ART(top.type), alt: "", draggable: "false", style: "object-position:" + (ART_POS[top.type] || "50% 40%") }, []) : ""])]
      : [el("i", null, [])];
    var discardStack = el("div", { class: "pile discard" }, [
      el("span", { class: "pile-stack discard" + (top ? "" : " empty"), "aria-hidden": "true" }, discardKids),
      el("span", { class: "pile-label" }, ["Discards", el("b", null, [String(match.discardPile.length)]), top ? (CARD_NAMES[top.type] || "") : ""]),
    ]);

    var medallion;
    if (!done && deadline) {
      medallion = el("div", { class: "medallion", id: "medallion" }, [timerRing(), el("span", { class: "countdown", id: "countdown", "data-expires": String(deadline.expiresAt), role: "timer", "aria-label": "Time remaining" }, [""])]);
    } else {
      medallion = el("div", { class: "medallion idle" }, [el("span", { class: "countdown" }, [done ? "Ended" : "No timer"])]);
    }
    var turnLine;
    if (done) turnLine = el("div", { class: "turn-line" }, ["Result: ", el("b", { id: "winner" }, ["Winner: Team " + match.matchResult.winningTeam])]);
    else if (deadline && deadline.responderSeat !== match.activeSeat) turnLine = el("div", { class: "turn-line" }, ["Seat ", el("b", { id: "active" }, [String(match.activeSeat)]), "'s turn — waiting on seat " + deadline.responderSeat]);
    else turnLine = el("div", { class: "turn-line" }, ["Seat ", el("b", { id: "active" }, [String(match.activeSeat)]), match.activeSeat === match.viewerSeat ? " (you) to act" : " to act"]);

    var kids = [
      el("img", { class: "table-art", src: "/card-clash/environment/war-table", alt: "", "aria-hidden": "true", draggable: "false" }, []),
      el("div", { class: "far" }, opponents.map(function (p) {
        var drop = [];
        if (!p.eliminated) { drop.push("attack"); if (p.handSize > 0) { drop.push("seize"); drop.push("disarm"); } }
        var knightSrc = "/card-clash/knight/" + (p.team === "A" ? "red" : "blue") + "/" + knightPoseFor(p);
        return el("div", { class: "knight-stand" + (p.eliminated ? " out" : "") }, [
          el("img", { class: "knight-fig", src: knightSrc, alt: "", "aria-hidden": "true", draggable: "false" }, []),
          seatPanel(p, done, false, drop),
        ]);
      })),
      el("div", { class: "pile-group" }, [drawStack, discardStack]),
      el("div", { class: "centerpiece" }, [
        combatFx && combatFx.vfx && combatFx.vfx[1] === "center" ? vfxImg(combatFx.vfx[0], combatFx.ms) : "",
        el("div", { class: "phase-banner " + phaseClass() }, [el("span", { id: "phase" }, [phaseText()])]),
        medallion,
        turnLine,
      ]),
      el("div", { class: "chronicle" }, [
        el("h3", null, ["Chronicle"]),
        el("ol", { id: "log" }, log.length ? log.map(function (e) { return el("li", null, [describeEvent(e)]); }) : [el("li", null, ["The hall falls silent — no moves yet."])]),
      ]),
    ];
    if (done) {
      var mine = me && me.team === match.matchResult.winningTeam;
      kids.push(el("div", { class: "victory", role: "status" }, [
        el("span", { class: "vt" }, ["Team " + match.matchResult.winningTeam + " Triumphs"]),
        el("span", { class: "vs" }, [me ? (mine ? "Your house holds the field" : "Your house has fallen") : "The battle is decided"]),
      ]));
    } else if (zone) {
      var hasActions = zone.cls === "z-response" || zone.cls === "z-rescue";
      var actions = hasActions ? centerResponseActions(me) : [];
      var zp = { class: "zone " + zone.cls + (actions.length ? " has-actions" : ""), "data-drop": zone.types.join(" "), "data-zone": "1" };
      kids.push(el("div", zp, [
        el("div", { class: "zone-head" }, [crest("zone-icon"), el("div", null, [el("div", { class: "zone-title" }, [zone.title]), el("div", { class: "zone-hint" }, [zone.hint])])]),
        actions.length ? el("div", { class: "zone-actions" }, actions) : "",
      ]));
    }
    return el("div", { class: "stage-wrap" }, [el("div", { class: "stage" }, kids)]);
  }

  function prompt(me) {
    var done = match.matchResult.status === "complete";
    var deadline = match.deadline;
    if (done) return el("div", { class: "prompt" }, [el("b", null, ["The battle is over."]), " Team " + match.matchResult.winningTeam + " holds the field."]);
    if (!me) return el("div", { class: "prompt" }, ["Watching the table."]);
    if (deadline && deadline.responderSeat === me.seat) {
      var what = match.pending ? (match.pending.kind === "dying_rescue" ? "Rescue decision" : "Respond now") : match.turnPhase === "discard" ? "Discard down to your HP" : "Your turn";
      // The detailed instruction for a pending response/rescue now lives
      // center-stage (centerResponseActions, P5) alongside its own buttons
      // — this note only needs to point the player's eyes there.
      var how = match.turnPhase === "discard" && !match.pending ? " — tap the cards you will give up." : match.pending ? " — see the table." : " — play a lit card from your hand.";
      return el("div", { class: "prompt you" }, [el("b", null, [what]), how]);
    }
    return el("div", { class: "prompt" }, ["Waiting on ", el("b", null, ["seat " + (deadline ? deadline.responderSeat : match.activeSeat)]), "."]);
  }

  // One transparent pair in every phase, including during combat flashes.
  function handGripArt() {
    return [
      el("img", { class: "grip-hand grip-left", src: "/card-clash/hands/gauntlet_left", alt: "", "aria-hidden": "true", draggable: "false" }, []),
      el("img", { class: "grip-hand grip-right", src: "/card-clash/hands/gauntlet_right", alt: "", "aria-hidden": "true", draggable: "false" }, []),
    ];
  }

  function handDock(me) {
    var done = match.matchResult.status === "complete";
    var avail = me ? computeAvailability(me) : {};
    var inDiscard = me && match.turnPhase === "discard" && !match.pending && me.seat === match.activeSeat && !done;
    var hand = (me && me.hand) || [];
    var playableCount = hand.filter(function (c) { return avail[c.type]; }).length;
    var hint = inDiscard ? "Tap cards to mark them for discard" : playableCount ? playableCount + " playable — tap or drag a lit card" : "No card can be played right now";
    return el("div", { class: "hand-dock" }, [
      el("div", { class: "self-hud" }, [me ? seatPanel(me, done, true) : "", prompt(me)]),
      el("div", { class: "fan-dock" }, [
        el(
          "div",
          { class: "hand" + (hand.length ? "" : " is-empty"), id: "hand" },
          (me ? handGripArt() : []).concat(
            hand.length ? hand.map(function (c) { return handCardNode(me, c, inDiscard, !!avail[c.type]); }) : [el("span", { class: "hand-empty" }, ["Your hand is empty."])]
          )
        ),
      ]),
      el("div", { class: "mini-controls" }, [
        me && hand.length ? el("span", { class: "hand-hint" }, [hint]) : "",
        el("div", { id: "controls" }, me ? controls(me) : []),
      ]),
    ]);
  }

  function battle() {
    var me = viewer();
    var done = match.matchResult.status === "complete";
    var opponents = match.players.filter(function (p) { return p.seat !== match.viewerSeat; });
    var modeName = (MODES.filter(function (m) { return m.v === match.mode; })[0] || {}).name || match.mode;
    return el("div", { class: "battle" }, [
      el("div", { class: "topbar" }, [crest("crest"), el("strong", null, ["Card Clash"]), el("span", { class: "room-code" }, ["ROOM " + room.code]), el("span", { class: "mode-pill" }, [modeName + " · " + match.mode])]),
      battleTable(me, opponents),
      handDock(me),
    ]);
  }

  function error() { return message ? el("p", { class: "error", role: "alert", id: "message" }, [message]) : ""; }

  // Use actual rotated corner bounds rather than untransformed card widths.
  // All phases share these positions; selected/hovered cards clear the arc.

  function cardCorners(x, y, theta, cw, ch) {
    var rad = theta * Math.PI / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    var originX = x + cw / 2, originY = y, halfW = cw / 2;
    var pts = [
      { dx: -halfW, dy: 0 }, { dx: halfW, dy: 0 },
      { dx: -halfW, dy: ch }, { dx: halfW, dy: ch },
    ];
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var k = 0; k < pts.length; k++) {
      var ax = originX + pts[k].dx * cos + pts[k].dy * sin;
      var ay = originY + pts[k].dy * cos - pts[k].dx * sin;
      if (ax < minX) minX = ax;
      if (ax > maxX) maxX = ax;
      if (ay < minY) minY = ay;
      if (ay > maxY) maxY = ay;
    }
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
  }
  function fanExtent(xs, ys, thetas, cw, ch) {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < xs.length; i++) {
      var e = cardCorners(xs[i], ys[i], thetas[i], cw, ch);
      if (e.minX < minX) minX = e.minX;
      if (e.maxX > maxX) maxX = e.maxX;
      if (e.minY < minY) minY = e.minY;
      if (e.maxY > maxY) maxY = e.maxY;
    }
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
  }
  // Unrotated positions (centered on an arbitrary x=0) for a pivot-below-
  // the-fan arc: outer cards sit lower and more rotated, the center card(s)
  // sit higher and nearly upright, all converging toward one point below
  // the container — "the player's own hands," per the brief. Only the
  // SPACING (avgStep → radius R) varies between calls, for the compression
  // search in layoutHandFan; the per-card angle step is fixed for a given
  // n so re-running this never changes the fan's proportions, only how
  // tightly the cards overlap.
  function fanPositions(n, anglePerCard, thetaMax, avgStep, cw) {
    var thetaMaxRad = thetaMax * Math.PI / 180;
    var cosMax = Math.cos(thetaMaxRad);
    var desiredSpan = avgStep * (n - 1);
    var R = thetaMax > 0 ? desiredSpan / (2 * Math.sin(thetaMaxRad)) : 0;
    var baseLift = 6;
    var xs = [], ys = [], thetas = [];
    for (var j = 0; j < n; j++) {
      var theta = n > 1 ? (j - (n - 1) / 2) * anglePerCard : 0;
      var thetaRad = theta * Math.PI / 180;
      xs.push(R * Math.sin(thetaRad) - cw / 2);
      ys.push(baseLift + R * (Math.cos(thetaRad) - cosMax));
      thetas.push(theta);
    }
    return { xs: xs, ys: ys, thetas: thetas };
  }
  function layoutHandFan(container) {
    if (!container) return;
    var list = [];
    for (var i = 0; i < container.children.length; i++) {
      var child = container.children[i];
      if (child.classList && child.classList.contains("card")) list.push(child);
    }
    var n = list.length;
    if (!n) return;
    // Geometry is applied atomically: never animate from the zero-angle
    // CSS defaults to measured fan positions while a user starts a touch.
    container.classList.add("laying-out");
    // Undo any shrink a previous call applied (see the fallback below)
    // before measuring, so every layout starts from the CSS cascade's
    // natural card size for the current breakpoint — otherwise a narrow
    // viewport's shrink would compound further on every resize/re-render.
    for (var r = 0; r < n; r++) list[r].style.removeProperty("--w");
    // offsetWidth/offsetHeight (not getBoundingClientRect) deliberately:
    // these report the pre-transform border-box size regardless of any
    // --fr rotation already applied from a previous layout pass — exactly
    // the untransformed geometry input the rotation math above needs.
    var cw = list[0].offsetWidth, ch = list[0].offsetHeight;
    if (!cw || !ch) return;
    var sidePad = 18, topPad = 12, bottomPad = 18;
    // The fan keeps its independent P5.3 width budget. Side widgets follow
    // the resulting footprint rather than consuming this space.
    var dock = container.parentElement;
    var availW = Math.max(cw + sidePad * 2, (dock && dock.clientWidth) || cw + sidePad * 2);
    var availInner = Math.max(cw, availW - sidePad * 2);

    // Restrained, count-bounded rotation: half-spread settles around 11°
    // for any n from 2 to ~9 (so 4–6 cards — the common case — always get
    // the same shallow arc, not a tuning that only looks right at six),
    // widening only mildly for very large hands and never exceeding 20°.
    var anglePerCard = n > 1 ? Math.min(9, Math.max(3, 22 / (n - 1))) : 0;
    var thetaMax = n > 1 ? Math.min(20, anglePerCard * (n - 1) / 2) : 0;
    if (n > 1) anglePerCard = thetaMax * 2 / (n - 1);

    // Compress spacing (more overlap, same angles) until the fan's actual
    // ROTATED bounding box fits the available width, or we've hit the
    // minimum overlap (a couple of passes converges because width scales
    // close to linearly with avgStep for these angle ranges). If even the
    // tightest overlap still doesn't fit — a narrow phone dock with a
    // 5+ card hand — shrink the card itself (same aspect ratio) and redo:
    // this is the only way to guarantee the rotated fan never exceeds the
    // available width, since overlap alone bottoms out at "still readable."
    var pos, ext, fanW;
    for (var shrink = 0; shrink < 6; shrink++) {
      var naturalStep = cw * .76;
      var minStep = cw * 0.28; // how much of the next card must stay visible, worst case
      var avgStep = n > 1 ? Math.min(naturalStep, Math.max(minStep, (availInner - cw) / (n - 1))) : 0;
      for (var pass = 0; pass < 4; pass++) {
        pos = fanPositions(n, anglePerCard, thetaMax, avgStep, cw);
        ext = fanExtent(pos.xs, pos.ys, pos.thetas, cw, ch);
        fanW = ext.maxX - ext.minX;
        if (fanW <= availInner || avgStep <= minStep) break;
        avgStep = Math.max(minStep, avgStep * (availInner / fanW));
      }
      if (fanW <= availInner || cw <= 56) break;
      var shrunk = Math.max(56, cw * Math.sqrt(availInner / fanW));
      ch = ch * (shrunk / cw);
      cw = shrunk;
    }
    if (cw !== list[0].offsetWidth) {
      for (var w = 0; w < n; w++) list[w].style.setProperty("--w", cw.toFixed(1) + "px");
    }

    var fanH = ext.maxY - ext.minY;
    var stageW = Math.max(cw + sidePad * 2, Math.min(1600, fanW + sidePad * 2));
    var stageH = Math.max(ch + topPad + bottomPad, fanH + topPad + bottomPad);
    // Center the fan horizontally inside whatever extra room stageW's own
    // floor/cap leaves beyond the fan's tight bounds (matters for a 1–3
    // card hand, where stageW floors out wider than the fan itself).
    var extra = Math.max(0, stageW - (fanW + sidePad * 2));
    var shiftX = sidePad + extra / 2 - ext.minX;
    var shiftY = bottomPad - ext.minY;

    container.style.setProperty("--inspect-lift", (-(cw * .35 + 12)).toFixed(1) + "px");
    var portrait = window.matchMedia("(orientation:portrait) and (max-width:760px)").matches;
    var shortLandscape = !portrait && window.innerHeight <= 480;
    var gripW = portrait ? Math.min(300, cw * 1.86) : Math.min(580, cw * (shortLandscape ? 2.8 : 3.4));
    var gripH = gripW * 1402 / 1122;
    // Convert a point on a resting outer card into hand-local coordinates.
    // The two supplied paintings have different grip cavities: 74%/40% and
    // 26%/34%. Rotate each forearm around its own cavity, not around the fan.
    function gripPoint(index, across) {
      var a = pos.thetas[index] * Math.PI / 180;
      var dx = (across - .5) * cw, dy = (shortLandscape ? .07 : -.06) * ch;
      return { x: pos.xs[index] + shiftX + cw / 2 + dx * Math.cos(a) - dy * Math.sin(a),
        y: stageH - pos.ys[index] - shiftY + dx * Math.sin(a) + dy * Math.cos(a) };
    }
    var leftGrip = gripPoint(0, .08), rightGrip = gripPoint(n - 1, .92);
    container.style.setProperty("--grip-width", gripW.toFixed(1) + "px");
    container.style.setProperty("--grip-left", (portrait ? pos.xs[0] + shiftX + cw * .35 - gripW * .74 : leftGrip.x - gripW * .74).toFixed(1) + "px");
    container.style.setProperty("--grip-right", (portrait ? pos.xs[n - 1] + shiftX + cw * .65 - gripW * .26 : rightGrip.x - gripW * .26).toFixed(1) + "px");
    container.style.setProperty("--grip-left-top", (portrait ? stageH - gripH * .38 : leftGrip.y - gripH * .40).toFixed(1) + "px");
    container.style.setProperty("--grip-right-top", (portrait ? stageH - gripH * .38 : rightGrip.y - gripH * .34).toFixed(1) + "px");
    container.style.setProperty("--hand-stage-w", stageW.toFixed(0) + "px");
    container.style.setProperty("--hand-stage-h", stageH.toFixed(0) + "px");
    for (var j = 0; j < n; j++) {
      list[j].style.setProperty("--fx", (pos.xs[j] + shiftX).toFixed(1) + "px");
      list[j].style.setProperty("--fy", (pos.ys[j] + shiftY).toFixed(1) + "px");
      list[j].style.setProperty("--fr", pos.thetas[j].toFixed(2) + "deg");
      list[j].style.setProperty("--fz", String(j));
    }
    // Flush the final transforms with transitions disabled, then restore
    // normal hover/selection easing. This never runs on pointer movement.
    for (var k = 0; k < n; k++) list[k].getBoundingClientRect();
    container.classList.remove("laying-out");
    // HUD and controls follow the resting fan footprint; selection/hover never
    // moves these anchors. The cards themselves retain their P5.3 geometry.
    var handRect = container.getBoundingClientRect();
    var handDock = container.closest(".hand-dock");
    if (handDock) {
      var dockLeft = handDock.getBoundingClientRect().left;
      var fanLeft = handRect.left - dockLeft + sidePad + extra / 2;
      handDock.style.setProperty("--fan-left", fanLeft.toFixed(1) + "px");
      handDock.style.setProperty("--fan-right", (fanLeft + fanW).toFixed(1) + "px");
      var dockTop = handDock.getBoundingClientRect().top;
      handDock.style.setProperty("--side-y", (handRect.top - dockTop + ch * (shortLandscape ? .58 : .20)).toFixed(1) + "px");
    }
  }
  function layoutBattleScene() {
    var wrap = document.querySelector(".stage-wrap"), stage = document.querySelector(".stage");
    if (!wrap || !stage) return;
    var w = wrap.clientWidth, h = wrap.clientHeight;
    var scale = Math.max(w / 1672, h / 941);
    var sw = 1672 * scale, sh = 941 * scale;
    stage.style.width = sw + "px";
    stage.style.height = sh + "px";
    stage.style.setProperty("--crop-y", Math.max(0, (sh - h) / 2) + "px");
    layoutHandFan(document.getElementById("hand"));
  }
  var fanResizeRaf = null;
  window.addEventListener("resize", function () {
    if (fanResizeRaf) cancelAnimationFrame(fanResizeRaf);
    fanResizeRaf = requestAnimationFrame(layoutBattleScene);
  });


  function tickCountdown() {
    var c = document.getElementById("countdown");
    if (!c || !c.hasAttribute("data-expires")) return;
    var total = 10000;
    var remaining = Math.max(0, Number(c.getAttribute("data-expires")) - Date.now());
    c.textContent = (remaining / 1000).toFixed(1) + "s";
    var urgent = remaining <= 3000;
    c.classList.toggle("danger", urgent);
    var m = document.getElementById("medallion");
    if (m) m.classList.toggle("urgent", urgent);
    var ring = document.getElementById("countdown-ring");
    if (ring) {
      var frac = Math.max(0, Math.min(1, remaining / total));
      ring.setAttribute("stroke-dashoffset", String(251.3 * (1 - frac)));
      ring.setAttribute("stroke", urgent ? "#d1453c" : "#e2c47e");
    }
  }

  var hallNode = null;
  function render() {
    if (pointerDrag && match && pointerDrag.version === match.version) { renderAfterDrag = true; return; }
    renderAfterDrag = false;
    clearInterval(deadlineTimer);
    clearTimeout(deadlineRefetch);
    // An SSE-triggered re-render mid-drag is about to detach the original
    // card node anyway (root.textContent="" below) — tear the drag down
    // without a return-animation rather than letting it desync.
    if (pointerDrag) abortCardDrag();
    setDrag(null);
    var focusId = document.activeElement && document.activeElement.id;
    root.textContent = "";
    if (!hallNode) { hallNode = el("div", { class: "hall", "aria-hidden": "true" }, [el("img", { src: "/card-clash/environment/castle-hall", alt: "", draggable: "false" }, [])]); document.body.insertBefore(hallNode, document.body.firstChild); }
    document.body.classList.toggle("in-battle", !!match);
    if (match) {
      root.appendChild(battle());
      if (message) root.insertBefore(error(), root.firstChild);
      layoutBattleScene();
    } else {
      root.appendChild(el("div", { class: "entrance" }, [room ? lobbyRoom() : lobbyEntry()]));
    }
    if (focusId) { var nextFocus = document.getElementById(focusId); if (nextFocus && !nextFocus.disabled) nextFocus.focus({ preventScroll: true }); }
    if (match && match.deadline && match.matchResult.status !== "complete") {
      tickCountdown();
      deadlineTimer = setInterval(tickCountdown, 250);
      // One refetch just after expiry; the server applies the timeout and
      // normally pushes an SSE invalidation first. Not polling.
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
