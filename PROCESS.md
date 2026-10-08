# Process overview

This repository was built with Claude Code as the implementing agent,
working in explicit, human-reviewed slices rather than one large generation.
Each slice below was proposed, implemented, verified against the running
container, and only then committed — the commit sequence below is the actual
development history, not a cleaned-up retelling of it. The
[final project brief](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/final-project/#what-you-submit)
says what this account covers and how long it runs.

## Direction and architecture, before any code

The first two commits fixed what the project actually was before any
implementation began.
[`9f4212a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/9f4212a)
replaced the course's empty README/CLAUDE.md templates with a genuine
project direction (a grid-based multiplayer strategy prototype,
server-authoritative by design, with team coordination as the actual design
goal) and a concrete harness of rules for how the agent should work —
written before a single line of application code existed.
[`b675681`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/b675681)
then recorded the real stack and schema decisions (Node + Hono +
`node:sqlite`, persistent anonymous identity, a settings-revision/approval
model for match start, a fixed 8×8 world, and settle-on-read resource
production) as a reviewed architecture record, again before the vertical
slice itself was built. Deciding these up front meant every later slice
extended one coherent design instead of improvising a new one each time.

## Implementation as small, reviewed vertical slices

Each gameplay capability landed as its own slice, verified against a real
Docker container — not just unit tests — before being committed:

- [`a46479c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/a46479c)
  replaced the course's placeholder BusyBox/static page with the real
  Node/Hono server, while deliberately keeping the two fixed course
  invariants (`/` and `/readme/`) green throughout the swap.
- [`439ec8f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/439ec8f)
  added persistent anonymous identity and campaign create/join/return,
  verified with a real two-cookie-jar restart test against a Docker volume,
  not just in-process assertions.
- [`fecb926`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/fecb926)
  added the settings-revision/approval model and atomic match start,
  grounded in explicit invariants (a settings change invalidates prior
  approvals; starting requires unanimous current-revision approval; approved
  settings become immutable) rather than ad hoc checks.
- [`e456218`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/e456218)
  added persistent world generation and the schema v2 → v3 migration. The
  migration test suite — run against a synthetic database built to the exact
  shape of the *previous* schema version, not just a fresh one — caught a
  real temporal-dead-zone bug in the migration's backfill path (a `const`
  referenced before its own initializer had run) before it ever touched a
  real database; it was fixed and re-verified, not patched around. This
  "test the actual prior version, not just fresh" approach was repeated for
  every later migration (v1 → v2 → v3 → v4 is still exercised as one chain
  in the current test suite).
- [`a25682b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/a25682b)
  added authorized resource-building construction. The existing schema
  already covered it, so no migration was added for the sake of having one;
  concurrent same-tile construction was explicitly tested to confirm the
  database constraint — not an in-memory check — is what actually prevents a
  double-build.
- [`d4874db`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/d4874db)
  added settle-on-read offline resource production. A real bug in my own
  first test draft — mixing a synthetic settlement time with
  `buildResourceBuilding`'s real `Date.now()` — produced an impossible
  timeline; it was caught by the test itself, not by inspection, and fixed
  by switching to Vitest's fake timers so construction and settlement share
  one controlled clock. The no-timer design was then verified for real: the
  container was stopped, left fully offline past a production interval, and
  restarted from the same volume, with production correctly reconstructed
  from persisted state alone.

## Automated correctness was not treated as sufficient

By the end of the slices above, the suite reached 81/81 tests covering
authorization, concurrency, schema migration across every historical
version, and real container restart/offline behaviour. That was treated as
necessary, not sufficient. A full functional acceptance pass re-ran the same
flow an actual two-browser user would, followed by real human browser
inspection — which found presentation problems no automated check could:
the lobby read as raw default HTML, the 8×8 world was too small to function
as the primary game surface on desktop, and a long deployed invite URL had a
mobile wrapping risk.
[`2ccf8ed`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/2ccf8ed)
corrected exactly those issues — visual hierarchy, grid sizing, tile/build
legibility, safe URL wrapping — without changing any gameplay behaviour; the
same 81 tests still pass unchanged after it.

## Scope, deliberately

Crit 8 was scoped as one proof-of-life vertical slice — create or join a
campaign, agree on settings, start a persistent world, build one resource
building, let production continue while offline, and recover the same state
on return — and development stopped there on purpose. Armies, combat, fog of
war, research and alternative victory conditions are real parts of the
project's direction (see README.md) but were deliberately not started this
cycle, rather than shipping partial, undertested versions of systems that
each carry their own large set of invariants. Nothing in this repository or
its README claims the current prototype is a complete strategy game, or that
its design has been shown to teach the coordination and planning skills it's
built around — those remain stated design goals, not measured outcomes.

## Crit 9: realtime synchronization

Realtime work followed the same before-code discipline as Crit 8.
[`f4a14cb`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/f4a14cb)
recorded the full decision record in `docs/crit-9-architecture.md` before
any realtime code existed: SQLite stays the sole authority, an SSE event
carries no payload, and the contract for exactly which mutations must (and
must not) publish a notification was specified up front — including an
explicit correction made mid-document, that a mutation returning
`ok: true` is not the same as a mutation that changed anything, and only
the latter may ever publish.
[`4d8d0d5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/4d8d0d5)
added the SSE transport itself (`realtime.ts`, `GET /c/:code/events`),
gated to participants per the ADR (`403`/`404` before the stream opens).
Implementing cleanup surfaced a real race: `stream.onAbort()` has to be
registered before any `await` in the handler, or a disconnect in that gap
would go undetected — the comment recording this in `server.ts` was written
at the point it was caught, not added afterward.
[`bea7ede`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/bea7ede)
added the authoritative `/live` fragment and the client-side refresh
script, coalescing overlapping fetches so an older response can never
overwrite a newer one.
[`4b117ead`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/4b117ead)
wired `publish()` into the existing mutation routes, but only on an
*effective* change — reusing the no-op distinctions `db.ts` already exposed
(`alreadyJoined`, `changed`) rather than re-deriving them, so a repeated
join or a resubmission of the already-active preset correctly produces no
notification.

Beyond the automated suite (128/128, including dedicated
`spec/realtime.test.ts`, `spec/live-fragment.test.ts`, and
`spec/realtime-mutations.test.ts` files), this slice was verified by
building the actual Docker image this project ships and driving it with two
independent cookie jars acting as two separate participants: one held an
open `/c/:code/events` connection while the other performed a real
mutation (an approval), and the first connection received a live
`campaign_changed` event; a subsequent `/live` fetch showed exactly the
resulting state, correctly scoped to each identity's own view. A
non-participant identity's attempt to open the same event stream was
rejected with `403`, as the ADR requires.

This two-identity HTTP-level verification is real and was performed
directly against the built image. A genuine two-browser, two-human visual
acceptance pass — the standard this project held itself to for Crit 8 — has
not yet been performed, and this branch has not yet been deployed:
`main` and the live Fly deployment still reflect the Crit 8 baseline only.

## Pivot: strategy-war cancelled, replaced by Poker Lab

A human decision was made to cancel the strategy-war product entirely and
replace it with Poker Lab, a multiplayer Texas Hold'em application, carried
out on a new `poker-pivot` branch from the reviewed `c9-realtime` foundation
rather than on `main`. The decision and its architecture are recorded in
[`docs/poker-final-architecture.md`](docs/poker-final-architecture.md)
before any poker-specific code existed, following the same before-code
discipline as the Crit 8 and Crit 9 architecture records. The reasoning: the
strategy-war's own gameplay loop remained incomplete (resources had no
sink — no armies, movement, or victory condition), while its
infrastructure — identity, SQLite transactions, SSE, Docker, Fly — was
real, working, and worth keeping. `main` and `c9-realtime` are both
preserved untouched as evidence of that earlier, completed work.

[`6f4689f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/6f4689f)
is the foundation-slice commit: it removes the strategy-war's HTTP routes
and business logic from `server.ts`/`db.ts` (keeping the v1-v4 schema and
migrations byte-for-byte, since an existing database's historical data must
keep migrating exactly as it always did), adds an additive v5 migration for
two new, independent tables (`poker_tables`, `poker_seats`), and implements
table creation, heads-up seating, and realtime join notifications by reusing
the existing identity/transaction/SSE infrastructure unchanged — `realtime.ts`
required no edits at all. The obsolete strategy-war test files were removed
from the active suite in the same commit, since their corresponding runtime
no longer exists; they remain in `main`'s and `c9-realtime`'s history.
`spec/migration.test.ts` was rewritten to verify the v1-v4 chain with raw
SQL instead of the now-removed campaign business-logic functions it used to
call, so migration correctness stays independently verified rather than
resting on trust.

This foundation slice is not a complete game: it has no cards, no betting,
and no hands. It is scoped and tested as exactly that — a table/seat/identity
foundation — not represented anywhere as more than it is.
