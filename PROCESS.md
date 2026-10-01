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
