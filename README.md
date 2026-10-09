# Card Clash

A real-time, multiplayer, server-authoritative card-combat game for 2–4
players. It is an original game with no gambling, no stakes and no payments:
players fight with action cards and hit points only.

Live: https://comp4020-final-posture627k.fly.dev/

## How it came about

This project began as a grid-based multiplayer strategy war game (see
`docs/crit-8-architecture.md`, `docs/crit-9-architecture.md`), was pivoted to a
Texas Hold'em "Poker Lab" (`docs/poker-final-architecture.md`), and was then
replaced by Card Clash. The identity, SQLite persistence, transactions and
realtime plumbing were reused each time. The legacy Poker Lab code, routes
(for example `/poker` and `/t/:code`) and database tables are kept intact but
are no longer the product.

## Modes and rooms

Three modes, with fixed seats and teams: 1v1, 1v2 (one host against two
allies) and 2v2. A player creates a room, shares the invite link
(`/?room=CODE` or `/card-clash?room=CODE`), others join, everyone marks
Ready, and the host (seat 1) starts the game. Identity is an anonymous,
server-issued, HttpOnly cookie; there are no accounts.

## Playing

On your turn you draw, then play cards, then end your turn (hand limit: your
current HP). The eight cards are Attack, Dodge, Heal, Seize, Disarm, Insight,
War Cry and Arrow Volley. Attack, War Cry and Arrow Volley ask opponents to
respond (Dodge or Attack, otherwise they lose 1 HP). A player reaching 0 HP
enters a rescue sequence where others may play Heal; otherwise they are
eliminated. A team wins when the other team is eliminated. The full frozen
rules are in `docs/card-clash-rules.md`.

## Server-authoritative timing

Every action, response and discard window is 10 seconds, stored as an
absolute deadline in SQLite. On expiry the server declines for the player,
ends the turn, or randomly discards exactly the excess cards, atomically.
The browser countdown is display-only. Known limitation: the Fly machine
auto-stops when idle, so a timer cannot fire while it is stopped; overdue
deadlines are applied when the machine next starts or a request arrives.

## Privacy and realtime

The server sends each viewer only their own hand; opponents show card counts,
and the draw pile is never sent. Realtime uses room-scoped Server-Sent Events
that carry only an "invalidate" signal; the browser then refetches its
filtered state.

## Architecture

- `server.ts`: Hono app, identity middleware, HTTP and SSE routes.
- `card-clash/`: pure rules engine (`engine`, `combat`, `effects`,
  `group-effects`, `turn-flow`), deadlines (`timers`, `scheduler`), action
  parsing (`action-http`), the realtime hub and the browser page (`ui.ts`,
  plain HTML/CSS/JS, no build step).
- `db.ts`: SQLite (schema v8) with additive migrations.

## Development and testing

Node 24 runs the TypeScript directly. Start the app with
`DATA_DIR=$(mktemp -d) PORT=8080 node server.ts`, then run
`APP_URL=http://localhost:8080 pnpm check` (typecheck plus the spec suite) and
`pnpm check:evidence`. A two-person manual test script is in
`docs/card-clash-playtest.md`; the release steps are in
`docs/card-clash-release-checklist.md`.

## Not implemented

Rematch, player replacement, accounts, and any card beyond the eight above.
