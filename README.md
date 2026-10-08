# Poker Lab

A multiplayer, real-time, persistent, non-cash Texas Hold'em poker
application. Players play with virtual chips only: no real money, no
purchases, no prizes, no cash-out, and no payments or wagering integration
of any kind.

This project was previously a grid-based multiplayer strategy war game
(documented in `docs/crit-8-architecture.md` and `docs/crit-9-architecture.md`,
and in the Crit 8 reflection). That product is cancelled by explicit decision
— see `docs/poker-final-architecture.md` for the pivot's architecture
decision record. Its infrastructure (identity, persistence, transactions,
realtime transport) is reused for Poker Lab; its gameplay is not.

This is an early foundation slice, not a playable game yet. What's
implemented now is covered under "Foundation slice scope" below. Dealing
cards, betting, hands and chip settlement are not implemented yet.

## Who it's for

Two players who want to play heads-up Texas Hold'em together online, for
fun, with no stakes attached.

## What players will do (once complete)

Create a table, invite another player, join and take a seat, start a hand,
receive private hole cards, post blinds, bet through preflop/flop/turn/
river, reach a showdown or an uncontested win, settle chips, and start
another hand — all server-authoritative and persistent, with each player
seeing only their own private information.

## Foundation slice scope

This stage implements:

1. a landing page describing Poker Lab, with no war-game interface or copy
2. create a poker table
3. join an existing poker table by its code
4. exactly two seats per table, each tied to a distinct anonymous identity
5. an identity cannot occupy both seats, and a seat cannot be claimed twice
6. each seated player starts with a non-purchasable virtual chip stack
7. a table's lifecycle status (waiting for a second player, or both seats
   filled)
8. real-time updates: a player joining is reflected in the other player's
   open browser tab without a reload
9. persistent table/seat state that survives a server restart
10. a responsive layout usable on both desktop and mobile

## Non-goals for this slice

Explicitly not implemented yet:

- dealing cards, hole cards, or any hand state
- blinds, betting, folding, calling, raising, or any wagering action
- showdown, hand evaluation, or chip settlement
- reconnect/recovery of in-progress hand state (there is no hand state yet)
- more than two seats per table
- side pots or any multiplayer-specific pot logic
- hand history, replay, or statistics

## Explicit exclusions (always out of scope)

- real-money betting, purchased chips, cryptocurrency, or redeemable prizes
- player-to-player transfers of real-world value
- AI poker opponents
- tournament systems or public gambling leaderboards
- payment or wagering integrations

## Defaults used in this slice

Development defaults, not an approved permanent product configuration:
1,000 virtual chips per seat, small blind 5, big blind 10, no ante, no rake.
These are stored per table (not hard-coded constants) so a later slice can
make them configurable without a schema change.

## Persistence and identity

Tables and seats are stored in SQLite, in the same database and using the
same anonymous, server-issued, HttpOnly-cookie identity as the rest of this
project — reused unchanged from the strategy-war product. The old
strategy-war tables (campaigns, participants, countries, tiles, buildings)
may still physically exist in an existing database file for migration
compatibility, but nothing in the poker application reads from or writes to
them, and no old campaign data is ever converted into poker data.
