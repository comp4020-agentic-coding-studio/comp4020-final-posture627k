# Card Clash backend — release checklist (preparation only)

Nothing here has been executed. No backup exists yet, no push or deploy has
happened, and production has not been verified.

1. **Local main** is clean (`git status --short` empty) and contains the Card Clash commits D0–D4C-2.
2. **origin/main may be behind.** Run `git fetch && git log --oneline origin/main..main` and `main..origin/main`; resolve any divergence before deploying.
3. **CI/deploy workflow:** review `.github/workflows/checks.yml` (checks job, then a deploy job running `flyctl deploy --remote-only --ha=false`). It must stay unmodified.
4. **Fly config:** `fly.toml` mounts the single volume at `/data`; confirm the app, machine and volume exist (`flyctl status`, `flyctl volumes list`).
5. **Backup BEFORE release (not yet done):** snapshot the volume (`flyctl volumes snapshots create <id>`) and/or copy `/data/app.sqlite*` (WAL mode: take `.sqlite`, `-wal`, `-shm` together or use `sqlite3 .backup`). Record where it is stored.
6. **No data loss:** all Card Clash migrations are additive `CREATE TABLE IF NOT EXISTS`; no historical table is altered or dropped.
7. **Migrations to schema v8** (`PRAGMA user_version`): v7 Card Clash tables, v8 `card_clash_deadlines`. Run `spec/migration.test.ts`, `spec/card-clash-storage.test.ts`, `spec/poker-persistence.test.ts`.
8. **Poker Lab** routes still work (`/`, poker table create/join, `/t/:code/events`).
9. **Card Clash routes** exist under `/api/card-clash/rooms…` (create, join, ready, start, state, events, actions).
10. **Privacy:** `/state` and action responses include only the viewer's own `hand`; others show `handSize`; no draw-pile order.
11. **SSE:** subscribe, observe another browser's invalidation, confirm subscriber cleanup on disconnect (`spec/card-clash-realtime.test.ts`).
12. **Timers:** MAIN/response/DISCARD deadlines are persisted in SQLite; reconciliation runs on startup and on `/state`/`/actions`. Fly auto-stop means timers do not fire while the machine is stopped; expired deadlines are applied on the next wake/request.
13. **Secrets:** never print or commit `mise.local.toml`, tokens, `.env`, or any `*.sqlite*` file; review `git diff --staged` before committing.
14. **Rollback limits:** once v8 is applied, older builds refuse the database (`user_version` newer than supported). Rollback requires restoring the pre-release backup from step 5, losing post-release data.
15. **Smoke test after deploy** (`APP=https://<repo>.fly.dev`):
    - `curl -s -o /dev/null -w "%{http_code}\n" $APP/` and `$APP/readme/` → 200.
    - `curl -s -c jar -H 'content-type: application/json' -d '{"mode":"1v1"}' $APP/api/card-clash/rooms` → 201 with a room code.
    - Join with a second cookie jar, ready both, start, then `GET /api/card-clash/rooms/<code>/state` shows `deadline.expiresAt`.
    - `curl -N -b jar $APP/api/card-clash/rooms/<code>/events` receives `ready`.

Known limitation: no UI exists yet (D5).
