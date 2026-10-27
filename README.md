# Card Clash

[Play Card Clash](https://comp4020-final-posture627k.fly.dev/) with 2–4 friends or classmates, each using their own browser identity. This original medieval card-combat game uses HP and eight action cards, with no gambling, stakes or payments.

## What good means here

I define a good match as shared tension built on understandable choices and trustworthy consequences. Another person's Dodge can defeat your Attack; spending Heal during rescue can keep someone else in the game. Being together changes what happens. The first-person war table and held cards aim to make ownership and targeting visible, while click, tap and keyboard controls keep dragging optional.

Two references frame this review. Hunicke, LeBlanc and Zubek's [MDA framework (2004)](https://www.cs.northwestern.edu/~hunicke/MDA.pdf) distinguishes rules from the behavior and experience they produce: correct mechanics alone cannot establish enjoyable play. Harley's [Visibility of System Status (2018)](https://www.nngroup.com/articles/visibility-system-status/) provides a criterion for judging whether turns, pending responses and action results are understandable. These are evaluation references for this revision, not evidence of completed user testing.

## Start a match

1. Open the game in separate Chrome profiles, or a normal and an incognito window. Two tabs sharing cookies are the same player.
2. Choose 1v1, 1v2 or 2v2. Create a room and share its invite link. Other players join; everyone marks Ready; the host starts.
3. Use ? Help for rules; its timer continues. On your turn, play available cards, then End Turn. If prompted, select excess cards and confirm discard down to your current HP.
4. Respond when asked: Attack requires Dodge; War Cry requires Attack; Arrow Volley requires Dodge. Declining costs HP. At zero HP, a successful Heal can rescue the dying player; otherwise they are eliminated. Win by eliminating the opposing team.

Attack, Seize and Disarm can target teammates; group attacks affect all other living players. Each action/response/rescue/discard window lasts fifteen seconds. Expiry ends the action phase, declines a response or randomly discards excess cards. Keep the invite URL and browser profile to return; clearing cookies loses that identity. See the [frozen rules](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/blob/main/docs/card-clash-rules.md).

## Guarantees and evidence

[CLAUDE.md](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/blob/main/CLAUDE.md) requires server authority, hidden-hand privacy and persistent state. Tests in [spec/](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/tree/main/spec) check:

- **Identity and privacy:** permissions come from the server-issued cookie; each player receives only their own hand, with opponents represented by counts.
- **Shared state:** transactional actions reject stale versions and prevent duplicate effects. Room-scoped SSE requests a fresh, authorized view without reloading.
- **Persistence and time:** SQLite stores rooms, matches and absolute deadlines; tests cover restart recovery, migrations and action/timeout races.

Rules enforcement is tested; balance, intuitive play and a convincing held-card composition require judgment. Local Chromium automation and screenshot reviews cover desktop/mobile layouts and input. A five-minute, two-person independent session on Windows/Chrome found understandable turns and synchronized updates, but exposed targetless-drop, over-discard, navigation and HUD-readability problems ([record](docs/card-clash-playtest.md)). The original trace was unavailable; a [later capture](docs/evidence/crit10-retest/README.md) records two identities. Classmates confirmed targetless use and discard limits repaired, but found the Lobby button small and requested confirmation. Measured latency, next-day checks and final visual acceptance remain unclaimed.

## Scope and current status

Card Clash replaces the earlier strategy and Poker Lab experiments; their development is explained in [PROCESS.md](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/blob/main/PROCESS.md). Legacy Poker routes remain. Rematch, replacement players, accounts and extra cards are excluded to keep one loop bounded. This test candidate packages the P5.x visual repairs and server-side action logging. Single-card control spacing still needs refinement. Fly auto-stop pauses execution; overdue deadlines reconcile on wake-up.

For local checks, use Node 24 and pnpm: start `node server.ts` with a disposable `DATA_DIR` and `PORT=8080`, then run `pnpm check` and `pnpm check:evidence`. Follow the [release checklist](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/blob/main/docs/card-clash-release-checklist.md) before publishing.
