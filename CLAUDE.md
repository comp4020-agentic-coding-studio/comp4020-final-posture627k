# Project harness

This file holds the rules coding agents must follow while working on this
project. It exists because the rules an agent is held to are part of what
gets marked, not just the code it produces.

## Before changing code

- Read the current spec (`spec/README.md`, `spec/invariants.test.ts`, and any
  other `spec/*.test.ts`) and the relevant existing project files before
  making a change. Don't assume prior context is still accurate.
- Work in small vertical slices. Prefer a thin, working end-to-end change
  over a broad partial one.
- Do not silently expand scope. If a task implies work beyond what was
  asked — including anything listed as deferred/out-of-scope in README.md —
  stop and say so instead of building it.

## Authority and state

- The server is authoritative for game state, time progression and any
  randomness. The client expresses intent; it does not decide outcomes.
- Persistent gameplay state must survive a restart or redeploy. Do not rely
  on browser-only storage, in-memory timers, or process-local state as the
  source of truth for anything that must persist or keep progressing while
  players are offline.
- Once a match has started, its approved settings are immutable. Any change
  to pre-match settings invalidates existing player approvals and requires
  re-approval from all current players before the match can become ready.
- Hidden enemy information must never be sent to the client, even if the UI
  hides it. If something shouldn't be visible to a player, filter it out
  server-side before it leaves the server.

## Course infrastructure

- Do not modify or weaken the course-provided invariant tests
  (`spec/invariants.test.ts`), the deployment constraints in `fly.toml`,
  `.github/workflows/checks.yml`, or the secret-scanning configuration. These
  are fixed contracts, not implementation details to optimise around.
- `Dockerfile` is the opposite case: it's a supplied placeholder explicitly
  intended to be replaced by the application's real build. Agents may modify
  or replace it when implementing the app. Any replacement must still serve
  HTTP on `0.0.0.0:$PORT` as `fly.toml` requires, and must keep `/readme/`
  serving README.md in a form the invariant tests can check — see
  `spec/README.md` and `spec/invariants.test.ts` for what that means in
  practice.
- Don't alter a test just to make it pass. If a test fails, fix the
  underlying behaviour or raise the conflict instead.

## Verifying changes

- Run the relevant automated checks (`pnpm typecheck`, `pnpm test` /
  `pnpm check`) after making changes.
- Verify the running artefact, not just the static code — start the app the
  way the spec expects (see `spec/README.md`) and confirm the behaviour
  actually works, not just that the code compiles.
- When you discover a regression, convert it into a test where practical
  rather than only fixing it silently.

## Honesty about state

- Do not fabricate evidence, tests, playtest findings, or claims about what
  is implemented. If something isn't built yet, say so.
- Clearly distinguish implemented behaviour from planned/intended behaviour,
  both in code comments/PRs and in project documents like README.md.
- Don't implement features listed as deferred or out of scope (see
  README.md's Crit 8 scope and non-goals) unless explicitly instructed to.

## Usability

- Maintain mobile usability alongside desktop usability — don't build
  interactions that only work with a mouse and keyboard unless there's a
  stated reason a given surface is desktop-only.

## What this file does not do

This file does not invent file paths, APIs, database schemas, field names,
state machine names, libraries, or architecture that don't exist yet in this
repo. Where a concrete design decision is needed, make it in the code and
describe it in the relevant spec or PR, not pre-declared here before it
exists.
