# Poker Final Architecture

**Status: PROPOSED — CONDITIONAL GO**

- **Development: APPROVED FOR DEVELOPMENT.** The human decision to cancel
  the strategy-war product and replace it with Poker Lab has been made
  explicitly, and development on a `poker-pivot` branch (created from the
  reviewed `c9-realtime` foundation) is authorized.
- **Public deployment: NOT YET APPROVED FOR PUBLIC DEPLOYMENT.** This
  authorization covers development only. Nothing here should be read as
  the instructor or any regulator having already approved publishing a
  poker application. Public production deployment remains separately
  gated on all of: course/instructor acceptance, demonstrated game
  correctness against the P0 bar, and resolution of the applicable
  simulated-gambling publication questions in §12. None of those gates has
  been passed yet.

This document records the architecture decision for pivoting the Final
Project from the strategy-war prototype to a multiplayer Texas Hold'em
poker application. It is conditional on the open decisions in §9 and the
gates in §12 — it authorizes development on the `poker-pivot` branch, not
production deployment of poker.

## 1. Context

The strategy-war prototype (`main`, Crit 8 baseline `b022960`) successfully
established a working, tested, deployed vertical slice of real
infrastructure:

- Persistent, server-issued anonymous identity (`identities`, cookie-based)
- A persistent backend on `node:sqlite` with additive, guarded migrations
  (currently `user_version = 4`)
- Authoritative, transactional mutation handling (`BEGIN IMMEDIATE` /
  `COMMIT`, with every precondition re-derived server-side inside the
  transaction rather than trusted from the client)
- Persistent world state (`countries`, `tiles`, `buildings`)
- A resource-production action (`buildResourceBuilding`) and a crash-safe,
  timer-free "settle on read" accounting model
- SSE transport (`realtime.ts`, `GET /c/:code/events`) and a per-identity
  authorized HTML fragment (`GET /c/:code/live`)
- A post-commit, content-free notification pattern (`publish()` fires only
  on effective mutations, never on no-ops, reads, or failures)

This is real, working infrastructure, not a failed implementation — it is
exactly the foundation a realtime, authoritative, multiplayer application
needs. What remains incomplete is the war-game's own gameplay loop: resource
production has no sink. Resources cannot yet be spent on armies, movement,
or anything that produces a victory condition, so the game is not yet
playable to a conclusion.

**The strategy-war product is cancelled, explicitly and by human decision.**
This is not a parallel product alongside poker, and it is not being kept
available for human acceptance testing or further polish — the war-game
gameplay routes and UI are being actively removed from the `poker-pivot`
branch (see the companion foundation-slice implementation), while its
infrastructure, history, and course evidence are retained exactly as
described in §10. The pivot is motivated by producing a complete,
demonstrably playable game within the remaining Final Project schedule
(C9, C10), using the
infrastructure already built and verified rather than discarding it.

The official Final Project deadline is **Monday, 9 November 2026, 12:00
noon, Canberra time** (per
[the assessment page](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/assessment/)).
This is a confirmed fact, not an open question, and is the basis against
which §11's roadmap feasibility should be judged.

## 2. Decision

**Adopt Strategy B: reuse the existing runtime and infrastructure, and add
poker as a new, separately organized domain module within the same
application and repository.**

This means:

- `db.ts`'s connection setup, migration-guard pattern, and transactional
  discipline are reused as a *pattern* for new poker tables added as an
  additive `v5` migration.
- `realtime.ts` is reused **unchanged** — it has no dependency on the
  war-game domain today and needs none added for poker.
- `server.ts`'s identity middleware, cookie-issuing logic, and per-identity
  authorized-fragment rendering pattern (`/c/:code/live`) are reused as a
  pattern for a poker equivalent.
- `campaigns`, `countries`, `tiles`, and `buildings` are **not** repurposed,
  renamed, or reinterpreted as poker entities. A poker table is not a
  renamed campaign: the existing tables carry war-game-specific concepts
  (`resource_preset`, `settings_revision`, grid tiles, building types) that
  a poker table does not need and should not inherit.
- All existing historical data, migrations `v1`–`v4`, commits, and course
  evidence are retained untouched.

## 3. Product definition

**Poker Lab — Multiplayer Texas Hold'em.**

Primary goal: a complete, server-authoritative, realtime, persistent,
two-player No-Limit Texas Hold'em game, genuinely playable to a conclusion
— unlike the war-game prototype, which intentionally stopped at resource
production.

Complete hand loop:

```
Create table → Join → Deal → Blinds → Preflop → Flop → Turn → River
  → Showdown or Uncontested Win → Settlement → Next hand
```

## 4. Scope

**P0 (mandatory, must pass acceptance before anything else is promised):**

- Complete heads-up No-Limit Texas Hold'em
- All basic betting actions (fold, check, call, bet, raise) and all-in
- Correct heads-up action order (button/blind rules — see §9, needs an
  authoritative reference before implementation)
- Correct five-card hand evaluation from seven available cards, including
  ties and split pots
- Correct chip settlement, with uncontested-pot awards and all-in runouts
- Private hole-card access, enforced server-side
- Persistent hand/table state surviving restart
- Realtime synchronization via the existing SSE pattern
- Recovery from disconnect and process restart
- A functional desktop and mobile interface

**P1 (after P0 passes acceptance, not before):**

- 3–6 players
- Multiplayer side pots, multiple all-in players
- Correct odd-chip distribution

**P2 (optional, never prioritized over P0 correctness):**

- Hand history and decision replay
- Non-monetary gameplay statistics
- Improved visual presentation

P1 and P2 are not promised as part of this decision. P0 correctness for two
players is the entire bar for this phase.

## 5. Architecture

A dedicated, HTTP-independent poker rules engine, conceptually organized
(file layout to be finalized at implementation time, not created here):

```
poker rules engine
├── deck / secure shuffle
├── hand evaluator
├── betting engine (legal actions, turn order, min-bet/raise, round completion)
├── pot construction and settlement
├── table and hand state machines
└── persistence adapter (engine state <-> database rows)
```

HTTP controllers, the per-identity view renderer, and SSE notification calls
sit outside this engine and depend on it — the engine must not depend on
Hono, HTML rendering, or any transport concern, mirroring how `db.ts` today
has no dependency on `server.ts`'s HTTP layer.

Table lifecycle and hand lifecycle are distinct state machines: a table
persists across many hands (`WAITING_FOR_PLAYERS → ACTIVE`), while a hand is
a short-lived cycle nested inside an active table
(`HAND_INITIALIZATION → PREFLOP → FLOP → TURN → RIVER → SHOWDOWN →
HAND_COMPLETE`, looping back to a fresh initialization).

## 6. Persistence

Recommend an additive `v5` migration on the existing SQLite database,
guarded exactly like the existing `v1`–`v4` migrations
(`if (currentVersion < 5)`), applied through the same connection and
migration runner already in `db.ts`. **No migration is run as part of this
document.** `v1`–`v4` and all existing data remain untouched.

Minimal proposed schema (entity names and fields are conceptual, not final):

- **Tables and seats** — a table record (code, status, blinds, button seat)
  and a seat record per joined identity (chip stack, `CHECK >= 0`), separate
  from and unrelated to `campaigns`/`participants`.
- **Current hand and street** — persisted columns for the active hand's
  street and the seat currently on action, updated transactionally on every
  action so no engine state lives only in process memory.
- **Dealer/button and actor** — a persisted button-seat column on the table,
  rotated transactionally at the start of each new hand.
- **Deck and private cards** — the dealt deck order and each player's hole
  cards are stored server-side only, associated with the hand and the
  specific player, and are never included in any query used to build a
  shared or broadcast view.
- **Betting contributions and stacks** — committed-chip amounts tracked per
  player per street as persisted state, reconstructable from an append-only
  action log kept as the authoritative audit trail. A "pot" is not a
  separately funded store of chips: it is simply the running sum of
  contributions already moved out of player stacks during the hand. Moving
  a contribution into the pot and moving stack chips out are the **same
  transactional event**, not two independent ledger entries, which is what
  prevents committed chips from being double-counted as both "in the pot"
  and "in the stack" at once.
- **Action history** — an append-only log of every submitted action
  (type, amount, sequence), used both as an audit trail and as the basis
  for rejecting duplicate or stale submissions.
- **Settlement status** — a settled/not-settled flag per hand, checked and
  set inside the same transaction that pays out chips, so a hand can be
  settled exactly once. At settlement, contributions transfer directly:
  the hand's total committed chips (the pot) are moved into the winning
  player's (or players', for a split) stack column in the same transaction
  that marks the hand settled, and the per-player committed-chip columns
  are then zeroed for the next hand. No chips are created or destroyed in
  this step — only moved from the committed-contribution ledger into stack
  balances.
- **Constraints** — uniqueness on (table, seat) and (hand, player) pairs,
  foreign keys from hand/action/pot rows back to their table and hand,
  `CHECK` constraints preventing negative chip stacks.
- **Chip-conservation invariant** — for a given table, at every point in
  time: **sum of all seats' remaining stacks + sum of all players' chips
  currently committed to the active hand's pot(s) = the table's initial
  total chip issuance**, assuming no buy-ins, cash-outs, rake, or any other
  external chip creation/destruction during play. Committed chips must be
  counted exactly once in this sum — never simultaneously as a "live pot"
  amount and as part of a player's stack, since they are mutually exclusive
  states of the same chips. This cannot be enforced by a single-row `CHECK`
  constraint; it must be verified as a cross-row test-suite invariant
  checked after every state transition, not assumed from schema alone.

Exactly-once settlement, crash recovery, and duplicate-action rejection all
follow the same discipline already proven in `db.ts`: re-derive and
re-validate everything fresh inside a `BEGIN IMMEDIATE` transaction, never
trust a client-submitted value, and never let engine state exist only in
memory between actions.

## 7. Concurrency and privacy

Reuse the existing post-commit SSE pattern unchanged:

```
Player action → validate table/hand/turn server-side → transactional state
  transition → commit → content-free notification → each connected player
  fetches their own authorized snapshot
```

- Every poker action is validated transactionally against current
  server-persisted state. Turn ownership, winning-hand determination,
  payout amounts, and chip balances are never accepted from the client —
  they are always recomputed server-side inside the transaction, exactly
  as `db.ts` already does for the war-game's build/settle actions.
- SSE events carry no private cards, no deck information, and no poker
  state at all beyond a content-free "something changed" signal, matching
  the existing `campaign_changed` event's discipline.
- Each player's view is built from a server-side render that filters hole
  cards and any other player-private information before any HTML is
  generated — generalizing the existing `/c/:code/live` pattern, which
  already produces a different authorized fragment per identity (today,
  hiding the opponent's resource balance; for poker, hiding hole cards).

**Action-validation contract.** Every poker action request must identify:

- the target hand (which hand this action applies to),
- the expected authoritative state version the client last observed (e.g.
  a monotonically increasing version/sequence on the hand), so the server
  can tell a client is acting on current information rather than stale
  information,
- a unique action/request identifier (e.g. a client-generated idempotency
  key), so a retried or duplicated network request can be recognized as
  the same action rather than applied twice, and
- the requested action type and any wager parameters (bet/raise amount).

Player identity is **never** taken from the request body — it is derived
solely from the trusted, server-verified session (the existing identity
cookie mechanism), exactly as the war-game code already does for every
mutation. The server-side transaction handling the action must, inside a
single `BEGIN IMMEDIATE`: re-derive the identity's seat, confirm it is
that seat's turn, confirm the submitted state version matches the hand's
current version (rejecting the action as stale otherwise), and check the
action's unique identifier against already-applied actions for that hand
(rejecting it as a duplicate, without re-applying any chip deduction, if
it has already been recorded) — before committing any chip movement. This
guarantees that a network retry of the same request can never deduct chips
twice, and that an action built against an outdated view of the hand is
rejected rather than silently applied on top of state the client never saw.

## 8. Test strategy

Tests are designed before implementation, prioritized as:

- Deterministic hand-ranking tests against independent oracles (published
  hand-ranking vectors or a separately-implemented brute-force comparator),
  not tests that merely reproduce the implementation's own assumptions
- Deck/shuffle tests: 52 unique cards, and verification that the shuffle is
  sourced from `node:crypto`, never `Math.random()`
- Blind posting and heads-up action-order tests
- Minimum-bet/raise and short all-in tests
- Fold-winner, showdown, and split-pot outcome tests
- Chip-conservation tests (the invariant from §6, checked after every
  transition)
- Duplicate/stale action rejection and out-of-turn rejection
- Card-privacy tests (no hole-card leakage via HTML, `/live`, or SSE)
- Concurrent-action handling (mirroring the existing concurrent-build race
  test pattern in `construction.test.ts`)
- Persistence-after-restart tests
- Realtime two-browser end-to-end acceptance
- Responsive usability checks at both a desktop (1920×1080) and a mobile
  (390×844) viewport

Existing war-game tests are not deleted or weakened by this document. They
remain the only protection for the verified Crit 8 production deployment
until an explicit, separate, human-approved decision retires any of them.

## 9. Open decisions

Explicitly unresolved, pending human approval. Every item below is a
**recommendation only** — none of these are approved implementation
constants, and none should be silently treated as decided just because a
default is proposed:

1. **Initial chips and blinds** — proposed default: 1,000 chips per player,
   5/10 blinds, no ante, no rake. Not yet approved.
2. **Authoritative poker ruleset** — which specific, citable rules reference
   (e.g. a recognized cardroom/tournament rule set) governs this
   implementation when rule sources disagree. Not yet chosen.
3. **Heads-up turn ordering** — the button/blind/first-to-act order must be
   confirmed against whichever ruleset is chosen in (2) before Slice 2
   begins; not yet confirmed.
4. **Minimum raises and short all-in reopening** — the exact minimum-raise
   calculation and whether a short all-in reopens betting for players who
   have already acted; depends on (2); not yet confirmed.
5. **Player disconnect / turn-timeout policy** — whether an unfinished turn
   on disconnect times out to an auto-fold, pauses the hand indefinitely,
   or something else. Not yet decided.
6. **Non-participant spectator policy** — whether, and how much, a
   non-seated viewer may observe a poker table. The war-game's default of
   open public read-access to a started game must **not** carry over by
   default. Not yet decided.
7. **Anonymous-identity recovery limitations** — whether the existing
   long-lived anonymous cookie identity is adequate for a persistent chip
   ledger. Tentatively acceptable for a two-player, non-cash P0; an open
   question before any P1 multiplayer or statistics feature. Not a final
   decision.
8. **Public deployment and age-access questions** — whether any age-gate,
   disclaimer, or access restriction is needed on a public deployment,
   pending §12's regulatory question. Not yet decided.
9. **Instructor approval** — approval of the project pivot itself, from the
   course instructor. Not yet obtained.

## 10. Evidence and branch strategy

- `main` (`b022960`) preserves the completed, deployed Crit 8 baseline,
  unmodified.
- `c9-realtime` (`4b117ead65280e7ff0d37b35dc65d1fb6869ca23`) preserves the
  realtime development evidence (SSE transport, live fragment, publish-on-
  commit) and is now pushed to `origin` and verified to match HEAD exactly.
- A future `poker-pivot` branch should branch from the reviewed, pushed
  `c9-realtime` foundation — not yet created by this document.
- Existing war-game routes, domain code, and tests remain intact and
  untouched until a poker P0 implementation is proven against its own
  acceptance criteria.
- Production must not switch to serving poker before explicit human
  approval and full P0 acceptance; the verified Crit 8 deployment must not
  be put at risk by an incomplete poker rebuild.

## 11. Delivery stages

0. **Pivot architecture approval** — this document reviewed and approved;
   no game code. *Success: approval recorded. Risk: proceeding without
   approval. Non-goal: any implementation.*
1. **Card, deck, shuffle, evaluator** — pure rules primitives, no HTTP, no
   DB. *Success: deterministic tests pass against independent oracles.
   Risk: inventing rules without an authoritative reference. Non-goal:
   betting logic.*
2. **Heads-up betting engine** — blinds, turn order, bet/raise/call/fold/
   all-in, round-completion and min-raise rules. *Success: rule-invariant
   tests pass for all legal/illegal action combinations. Risk: incorrect
   heads-up order or short-all-in handling. Non-goal: persistence, UI.*
3. **Poker persistence** — the additive `v5` schema, table/seat/hand
   creation and lookup. *Success: migration applies cleanly alongside
   `v1`–`v4` with no data loss; existing suite still passes. Risk:
   schema gaps that block P1 side pots later. Non-goal: full hand
   lifecycle wiring.*
4. **Full-hand state machine and settlement** — complete hand lifecycle,
   showdown, exactly-once settlement, next-hand initialization. *Success: a
   complete two-player hand runs end to end with correct chip outcomes.
   Risk: double-settlement or chip leakage. Non-goal: realtime, UI.*
5. **Realtime and authorized private views** — SSE wiring, per-identity
   hole-card filtering, reconnect. *Success: no hole-card leakage under
   test; reconnect recovers state from SQLite only. Risk: privacy leakage
   via a shared render path. Non-goal: new transport infrastructure.*
6. **Playable desktop/mobile UI** — real two-browser playable interface.
   *Success: a full hand is playable by two humans on separate devices.
   Risk: desktop-only interactions. Non-goal: animations, visual polish.*
7. **History/replay, if feasible** — P2. *Non-goal: ahead of P0/P1
   completion.*
8. **Multiplayer expansion, if feasible** — P1, 3–6 seats, side pots.
   *Risk: assuming heads-up logic generalizes without side-pot work.
   Non-goal: starting before P0 acceptance.*
9. **Final acceptance, evidence, deployment** — full automated suite, real
   two-browser play, persistence/restart proof, CI green, production smoke
   test, PROCESS/evidence updated, submission. *Risk: replacing the
   verified Crit 8 deployment with an unproven build. Non-goal: deploying
   before every P0 gate in §12 passes.*

## 12. GO / NO-GO gates

Full public poker deployment is **not authorized** unless and until:

- Instructor acceptance of the pivot is confirmed, or an explicitly
  approved alternative path is chosen
- The simulated-gambling/regulatory question from the prior audit is
  resolved or explicitly accepted as a documented risk by the instructor
- P0 functionality is complete and passes its own acceptance tests
- No private card or deck information leaks through HTML, `/live`-style
  fragments, or SSE, under test
- Chip-conservation and exactly-once-settlement invariants pass
- Persistence/restart and reconnect tests pass against a live, running app
- All existing course evidence (`main`, `c9-realtime`, commits, reflections,
  `PROCESS.md`) remains intact and unaffected
