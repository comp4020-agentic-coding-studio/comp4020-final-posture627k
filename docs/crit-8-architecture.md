# Crit 8 architecture decisions

This is a decision record for the Crit 8 vertical slice: what was approved and
the boundaries implementation must stay inside. It is not a design essay, and
it does not describe anything as already implemented.

## Stack

- Node.js 24.21, as already pinned by the repository.
- Native TypeScript execution using Node's built-in type stripping — no
  bundler, no separate build step.
- Hono with `@hono/node-server` as the minimal HTTP routing layer.
- Built-in `node:sqlite` for SQLite access.
- No frontend framework, no ORM, no bundler.
- Server-rendered HTML plus minimal browser JavaScript where needed.

Constraints on the above:
- Node 24.21 can use `node:sqlite` without the old `--experimental-sqlite`
  flag.
- Native TS execution must stay within syntax Node can strip directly.
- Runtime code must not depend on tsconfig-only path aliases or on TypeScript
  syntax that requires transformation.

None of these dependencies are installed yet; this document records the
decision, not the installation.

## Crit 8 match shape

Exactly one match structure is in scope: fixed 1v1, two required country
slots, one player per country, symmetric starting structure. 2v2, 3v3,
2v2v2 and asymmetric matches are future work.

A match may start only when **both** are true:
1. every required country slot is occupied
2. every required current participant has approved the current settings
   revision

Unanimous approval is not sufficient on its own if a required seat is vacant.

If a player explicitly leaves before match start: their pre-match country
slot becomes vacant, their approval no longer counts, and the match cannot
start until that slot is filled again. This is distinct from replacement of
a player in an already-started campaign, which is deferred beyond Crit 8.

## Lobby readiness

READY is not persisted as independent state. Readiness is derived, at read
time, from:
- the campaign is still pre-start
- all required country slots are occupied
- every required participant has approved the current settings revision

Settings changes: occur only pre-start, advance the settings revision,
invalidate all approvals tied to the previous revision, and do so atomically.

Starting: re-checks required seats and unanimous current-revision approval
atomically, and transitions the campaign exactly once.

After start: approved settings are immutable, enforced server-side.

## Minimal Crit 8 setting

One configurable gameplay rule only — resource production preset:
- **Standard**: 10 resource units per resource building per complete
  10-second interval
- **Rapid**: 20 resource units per resource building per complete 10-second
  interval

These are prototype Crit 8 values, not a claim of final game balance.
Changing this setting invalidates all previous approvals. No general-purpose
settings system is in scope.

## World

Fixed 8×8 grid for Crit 8:
- no configurable map size
- symmetric countries
- headquarters generated automatically
- at most one building per tile for this slice
- only headquarters and one resource-producing building type are required
- no armies, no combat, no pathfinding, no terrain system

Future combat/world rules are not pre-defined in the schema to anticipate
them.

## Player identity and campaign access

A server-issued, random opaque browser identity stored in an HttpOnly
cookie. For the eventual implementation:
- the server, not the client, resolves permissions/country from this
  identity
- sensible cookie protections (e.g. `SameSite`, `Secure` where appropriate)
  are used
- this is anonymous prototype identity, not full authentication
- clearing cookies or changing browser/device does not recover the previous
  identity in Crit 8

Campaign discovery:
- campaign creation produces a shareable campaign URL
- another independent browser can use the URL to occupy the open second
  country slot
- the landing page also shows the current browser's existing campaigns
  ("Your campaigns"), based on its server-recognized identity
- returning through either the campaign URL or the landing-page campaign
  list recovers the existing participation rather than creating a second one

Cross-device recovery and passwords are out of scope.

## Persistence

SQLite on the persistent data directory.

- the application receives the data directory via environment/configuration
- the container/Fly deployment uses `/data`
- local development/tests may override the location
- application code must not treat browser state or process memory as
  authoritative persistence
- fresh storage must initialise safely
- a lightweight, explicit schema version/migration path is maintained
- no ORM
- SQLite foreign-key enforcement is enabled
- WAL and an appropriate busy timeout may be enabled for the single-process
  deployment

## Resource model and offline progression

- one pooled spendable resource balance per country
- per-resource-building production settlement state

This is intentional: a single country-level production cursor is **not**
used, because if multiple resource buildings are created at different times,
a shared cursor could retroactively credit a newly-created building for time
before it existed. Each resource building begins producing from its own
activation time.

When resources need to be observed or spent:
- the server settles all relevant producers
- only complete 10-second intervals count
- each producer advances its own settlement cursor only by the complete
  intervals actually credited
- the resulting production is added to the country's pooled balance
- settlement is atomic

This must prevent: double credit on repeated reads, retroactive production
before a building existed, and double credit from concurrent requests. No
in-memory interval is authoritative — browser close, server restart, Fly
sleep and redeploy must not change the calculation, because elapsed
production is reconstructed from persisted timestamps.

## HTTP/UI boundary

Conceptually:
- landing page: create/join + "Your campaigns"
- lobby page: players/countries, one setting, approval state, start
- world page: 8×8 grid, headquarters, resource balance, construct resource
  building

The server owns: identity, permissions, lifecycle state, approval
validation, resource settlement, persistence. The browser expresses user
intent and renders server responses. Real-time push synchronization is still
deferred to Crit 9.

## Concurrency invariants

Transactions/constraints must protect at minimum:
- settings revision change + approval invalidation
- approval recorded against the current revision
- start preconditions + single transition
- two build attempts on the same tile
- resource settlement

"Node is single-threaded" is not relied on as the correctness mechanism —
these are protected explicitly (transactions/constraints), not implicitly.

## Testing priorities

Beyond the fixed course invariants, Crit 8 tests should cover at least:
- both required 1v1 seats must be occupied before start
- settings change invalidates approvals
- cannot start without unanimous current-revision approval
- settings are immutable after start
- conflicting construction on one tile cannot create two buildings
- returning identity sees the same campaign/state
- persisted world/building state is recovered
- resource production credits complete 10-second intervals only
- repeated settlement does not double-credit
- a resource building receives no production for time before it was
  constructed
- the server does not trust a client claim to control another country

Game invariant tests are prioritised over UI snapshot tests.

## Docker/deployment contract

The placeholder Dockerfile will later be replaced. The real image must:
- run the Node application
- listen on `0.0.0.0:$PORT`
- preserve the `/readme/` behaviour required by the fixed invariant tests
- use `/data` for persistent production storage through configuration
- boot correctly against an empty `/data` directory in CI
- remain compatible with the existing `fly.toml` and GitHub Actions workflow

`fly.toml`, the course invariant tests, the CI workflow and secret-scanning
infrastructure are not modified.

## Explicit Crit 8 non-goals

- real-time push synchronization
- armies/combat
- army merge/split/retreat
- fog of war
- replacement of players in an active campaign
- technology trees
- alternative victory conditions
- asymmetric player counts
- multiple configurable map sizes
- polished battle animation

## Implementation sequence

1. Real Node/Hono server replaces the placeholder while preserving `/` and
   `/readme/`.
2. SQLite + anonymous identity + campaign creation/join/return.
3. Fixed 1v1 lobby + setting revision + approvals + start.
4. 8×8 world + headquarters.
5. Resource-building construction.
6. Offline resource settlement.
7. End-to-end return/persistence verification.
8. Mobile/desktop usability pass.

Each slice must leave the running artefact and relevant tests green before
continuing.
