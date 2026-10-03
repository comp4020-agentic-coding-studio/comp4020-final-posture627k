# Crit 9 realtime architecture decisions

This is a decision record for Crit 9 realtime synchronization: what was
approved and the boundaries implementation must stay inside. Like
`docs/crit-8-architecture.md`, it is written before implementation, not after,
and it does not describe anything as already built unless the surrounding text
says so explicitly.

## 1. Core architecture

Crit 9 realtime is one flow, end to end:

```
existing authoritative POST
  -> SQLite BEGIN IMMEDIATE transaction
  -> COMMIT
  -> lightweight realtime notification
  -> participant browser
  -> browser re-fetches its own authoritative server-rendered snapshot
```

SQLite remains the sole source of truth, exactly as in Crit 8. Nothing about
this changes that.

SSE is explicitly **not**:

- a second state store
- an event-sourcing system
- a mutation transport (no mutation is ever expressed as, or carried by, an
  SSE event)
- a client-side authority (the browser never decides outcomes from an SSE
  event's content, because the event carries no content — see Section 4)

## 2. Transport choice

Use Hono's already-installed SSE support (`hono/streaming`'s `streamSSE`,
present in the `hono` version already in `package.json`).

- No new dependency.
- No schema migration.
- No Redis/Postgres/pub-sub service.

The current deployment (one Fly machine, `fly.toml`) is intentionally treated
as a single application process for this slice. An in-process, in-memory
subscriber registry is sufficient and is what this slice uses.

**Future limitation, documented and deliberately not solved here:** running
more than one application instance would require a cross-process pub/sub
mechanism (for example Redis or Postgres `LISTEN`/`NOTIFY`), since an
in-process registry on one instance has no way to learn about a commit that
happened on another instance. That mechanism is not implemented as part of
Crit 9.

## 3. Subscription authorization

For Crit 9, the SSE endpoint is **participant-only**. A requester may
subscribe only when:

- the campaign exists, and
- the server-resolved cookie identity (from the existing identity middleware)
  is an actual participant in that campaign.

Responses:

- unknown campaign code -> `404`
- known campaign, non-participant identity -> `403`
- known campaign, participant identity -> the event stream opens

This is **deliberately narrower** than the existing public campaign-page view
(`GET /c/:code`, which a non-participant may already load and see the world
grid on a started campaign). The reason: a bare realtime event carries no
game data on its own, but the timing and frequency of events still reveals
that *something* is happening in a given campaign right now. Crit 9 exists to
give participants realtime collaboration with each other; an unrelated public
viewer does not need that activity signal, even content-free.

The later `/live` snapshot endpoint (Slice 2, not built yet) may keep the
existing campaign-page visibility rules as-is, because its *contents* are
already fully server-authorized per request the same way `GET /c/:code` is
today — the stricter rule here is specific to the subscription itself, not to
every realtime-adjacent endpoint.

## 4. Event contents

One content-free domain event:

```
event: campaign_changed
```

The SSE payload for this event never contains:

- resource balance
- seat-specific state
- country state
- tile state
- identities
- timestamps supplied by clients
- any gameplay snapshot

The event means exactly one thing: "your authoritative view may now be
stale; re-read it." Nothing more is ever encoded in it.

## 5. Realtime contract

Shared, effective changes that a later slice **must** publish after:

- a participant actually joins
- the resource preset actually changes
- approval state actually changes
- a campaign successfully starts
- a resource building is successfully constructed

Must **not** publish:

- campaign creation (no other participant exists yet to notify)
- failed mutations
- rejected mutations
- no-op/idempotent mutations
- resource settlement caused by a GET/read (see Section 9)

**Correction carried from review:** later wiring must publish only for
*effective state changes*, not merely whenever a `db.ts` function returns
`ok: true`. Concretely:

- a participant re-joining a campaign they already belong to is a successful
  no-op (`joinCampaign` returns `{ok: true, alreadyJoined: true, ...}`) ->
  no event
- re-approving an already-approved current revision is idempotent
  (`approveCurrentSettings`'s `INSERT ... ON CONFLICT DO NOTHING`) -> no event
- submitting the preset that is already active returns `changed: false`
  (`setResourcePreset`) -> no event

If an existing `db.ts` return type is not already sufficient to distinguish
"succeeded and changed something" from "succeeded as a no-op," a later slice
may minimally enrich that return type to expose the distinction, without
changing the underlying behaviour it reports on. `setResourcePreset` already
exposes this (`changed: boolean`); `joinCampaign` already exposes this
(`alreadyJoined: boolean`); `approveCurrentSettings` currently does not
distinguish a fresh insert from a no-op conflict and would need this if a
later slice wires it up.

## 6. Concurrency ADR

**Commit-order wins + authoritative snapshot convergence.**

- Mutations remain server-authoritative; nothing about realtime changes who
  decides outcomes.
- SQLite serializes conflicting writers via `BEGIN IMMEDIATE` and the
  existing UNIQUE/CHECK constraints, exactly as in Crit 8 — this is not new
  machinery, realtime is layered on top of it.
- Every transaction revalidates the state it observes inside itself (for
  example `approveCurrentSettings` always reads `settings_revision` fresh,
  inside its own transaction, never from a value the caller supplied).
- Clients never merge competing local states; there is no client-side
  reconciliation logic of any kind.
- After a commit notification, each browser re-fetches authoritative state
  from the server rather than trying to interpret or apply the event itself.
- A failed transaction (one that rolls back) never generates a success
  notification — only a committed, effective change does.

**Worked example A — settings change vs. approval:** a host changes the
resource preset while, concurrently, a participant submits an approval.
Because `approveCurrentSettings` reads `campaign.settings_revision` fresh
inside its own transaction, the approval always lands against whichever
revision is current at the moment it actually runs, regardless of commit
order:
- if the preset change commits first, the approval (now evaluated against the
  new revision) is recorded correctly against it;
- if the approval commits first (against the old revision), it is simply
  never selected by a later `WHERE a.revision = ?` check once the revision
  bumps — inert, harmless data, by design.

Both orders converge to the same invariant: only approvals tied to the
*current* revision ever count toward readiness.

**Worked example B — two concurrent same-tile building attempts:** already
exercised in Crit 8 (`spec/construction.test.ts`, concurrent `Promise.all`
requests at the same tile). The losing transaction hits the existing
`UNIQUE(tile_id)` constraint and rolls back, returning `{ok: false, reason:
"occupied"}` — it never commits, so under this contract it never publishes.
The loser learns of its own loss synchronously, from its own HTTP response;
there is nothing for the realtime layer to communicate to it.

## 7. Reconnect semantics

- No durable event log.
- No `Last-Event-ID` requirement.
- No events database table.

On every `EventSource` connect or reconnect, the browser re-fetches its own
authoritative snapshot. Missed notifications do not matter, because SQLite
always contains the current truth and a fresh fetch always reflects it,
regardless of which (if any) intermediate events were missed while
disconnected.

Connection loss is not framed as a single specific cause. It may happen
because of network interruption, process restart, a deployment, machine
lifecycle behaviour, or the browser suspending the tab — the exact cause
varies and is not enumerated exhaustively here. Recovery is designed around
the fact that it does not depend on receiving every event, for any of these
causes.

## 8. Later client refresh race (recorded now, not implemented)

This is an explicit requirement for the later live-fragment slice (Slice 2),
recorded now so it isn't missed when that slice is designed:

Multiple rapid `campaign_changed` events (for example a host starting a
match immediately after both approvals land) can trigger overlapping fragment
fetches from the same browser. The client **must** prevent an older, slower
response from overwriting a newer snapshot once both resolve.

Acceptable solutions, to be chosen during that slice:
- serialize/coalesce refreshes so only one fetch is in flight at a time, or
- a generation token / "latest request wins" application of fetch results.

This is **not** implemented in this document's Phase A or in Slice 1 — there
is no client-side fetching of any kind yet (see Section 10).

## 9. Resource settlement exception

Recorded because it is a real, existing subtlety in the current codebase, not
a hypothetical one: `GET /c/:code`'s started-campaign branch may mutate the
*current viewing participant's own* resource balance and their own resource
buildings' settlement cursors, as a side effect of settle-on-read
(`settleAndGetOwnCountryResources`, called inline from
`renderCampaignPage`).

This settlement **must not** call realtime publish. It is private,
time-derived state belonging only to the identity making the request — not
another player's explicit shared mutation — and nothing about it is visible
to, or actionable by, anyone else viewing the same campaign.

## 10. Slice plan

- **Slice 1** — SSE transport only. A participant can open a long-lived
  event stream for their campaign; no existing mutation publishes to it yet.
- **Slice 2** — authoritative live fragment endpoint + safe client refresh
  (including the overlapping-fetch protection from Section 8).
- **Slice 3** — publish effective shared mutations after commit, per the
  contract in Section 5.
- **Slice 4** — race/reconnect hardening.
- **Slice 5** — two-browser human acceptance + Crit 9 evidence.

Armies, combat, and the other README non-goals remain out of scope and are
not part of Crit 9; nothing above should be read as describing them.
