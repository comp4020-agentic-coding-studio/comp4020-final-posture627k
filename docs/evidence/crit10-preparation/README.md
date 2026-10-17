# Crit 10 preparation evidence

These records are **automated local engineering checks**, captured before
the agreed two-person session. They do not claim a completed human playtest,
production redeploy/restart test, next-day return or final visual acceptance.
The source hashes tie the recorded preparation to the packaged implementation.

- `verification-summary.json`: 373 passing tests and preparation status.
- `http-smoke.json`: real HTTP, independent cookies, rejected wrong-seat
  action, exactly-once commit/replay distinction and an actual timeout log.
- `docker-smoke.json`: built runtime, README entry, gauntlet asset and
  two-identity create/join/ready/start smoke checks.

The logging/harness/test changes are in [00544ac](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/00544ac).
Follow [the human test protocol](../../card-clash-playtest.md) and fill its
record only after the real session. The subsequent CI/deployment status is
recorded in GitHub Actions, separately from this preparation snapshot.
