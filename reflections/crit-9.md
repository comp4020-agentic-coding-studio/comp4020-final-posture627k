# Crit 9 reflection

**What was the breakthrough that moved the work forward?**

The breakthrough was deciding, before any realtime code existed, that SSE
would never be a second source of truth. It would have been easy to let an
event carry the changed data itself; writing `docs/crit-9-architecture.md`
first forced the opposite choice: SQLite stays the sole authority, and
`campaign_changed` carries no payload at all — it only means "your view may
be stale, re-fetch it." That discipline paid off directly twice. First,
distinguishing "the mutation succeeded" from "the mutation changed
anything" turned out to matter — a repeated join or a resubmitted,
already-active preset must never publish, or every open browser refetches
for nothing — and the fix reused small distinctions `db.ts` already exposed
(`alreadyJoined`, `changed`) instead of a redesign. Second, implementing
connection cleanup surfaced a real race: `stream.onAbort()` has to be
registered before any `await` in the handler, or a disconnect in that gap
goes undetected. Both are documented in the code where they were found, not
smoothed over afterward.

**What did this work change about who I want to be as a software developer?**

It made me trust writing the contract before the code, even for something
that feels inherently reactive. It also made me verify that contract the
same way Crit 8 did: by running the real thing, not just unit tests. I
built the actual Docker image and drove it with two independent cookie
jars acting as two participants — one holding an open event stream while
the other approved settings — and watched a real `campaign_changed` event
arrive, followed by a `/live` fetch showing exactly the resulting state. A
genuine two-human, two-browser pass is still pending, and I'm not
recording that as done when it isn't.
