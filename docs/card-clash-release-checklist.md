# Card Clash — release checklist

Status per step is recorded in the release report; this file lists what to verify, not what has been done.

1. Local `main` is clean and `git fetch` shows `origin/main` is an ancestor (fast-forward only, never force-push).
2. Review the outgoing diff for secrets, SQLite files and accidental deletions.
3. `pnpm typecheck`; build the Docker image; run it with a throwaway `/data` (`docker run -d --init -p 8080:8080 -e PORT=8080 --tmpfs /data`); `APP_URL=http://localhost:8080 pnpm check`; `pnpm check:evidence`.
4. CI (`.github/workflows/checks.yml`, unmodified) runs check, both secret scans, then deploys with `flyctl deploy --remote-only --ha=false`. Do not deploy manually.
5. **Fresh backup immediately before pushing:** stop the machine if running, `flyctl volumes snapshots create <volume-id> -a comp4020-final-posture627k`, wait until the snapshot lists as `created`, and record its ID, creation time and retention (Fly keeps snapshots 5 days by default). Writes after the snapshot are not covered.
6. **Recovery (do not run without authorization):** `flyctl volumes create data --snapshot-id <id> -a <app>` creates a new volume from the snapshot; attach it to a machine to recover.
7. SQLite is schema v8 and this release adds no migration. An older, pre-v8 build refuses a v8 database; an application-only rollback to the previous v8-compatible release is possible, a database restore is a separate, destructive decision.
8. Smoke test production with disposable rooms only: `/` and `/card-clash` return 200 with Card Clash, `/readme/` returns the README, `/poker` and `/t/:code` still answer, create/join/ready/start with two cookie jars, each viewer sees only their own hand, an action persists, an SSE stream receives an invalidation, a deadline expires and reconciles.
9. Never print or commit `mise.local.toml`, tokens, `.env` or SQLite files.
10. Fly auto-stop means timers do not fire while the machine is stopped; they reconcile on the next start or request.
