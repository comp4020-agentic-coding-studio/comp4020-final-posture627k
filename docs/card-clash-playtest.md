# Card Clash — two-person URL-only playtest

Status: **scheduled/preparing; no human results recorded yet**. Two people who
have not developed the game have agreed to test. Prior jsdom tests, real
Chromium automation and Docker two-identity smoke tests are engineering
checks; they are separate from this session.

## Before inviting the testers

- Agree a 20–30 minute slot. Use two independent Chrome profiles/devices.
- Use 1v1. Prefer one 1920×1080 viewport and one 390×844 viewport; record
  actual dimensions. Two tabs sharing cookies are one identity.
- Check the intended candidate is deployed and opens at the course URL.
  Current local work is not automatically deployed. Follow
  [the release checklist](card-clash-release-checklist.md) separately;
  this protocol does not authorize a push or deployment.
- Start observing server logs with
  `mise exec -- flyctl logs -a comp4020-final-posture627k`.
  Save relevant output locally, then redact/review excerpts before publishing.
- Local rehearsal: start `node server.ts` with a new temporary DATA_DIR and
  PORT=8080. Its terminal prints the same records. Localhost on your computer
  is not reachable from a classmate's separate computer. A local session must
  be recorded as local, not represented as deployed acceptance.

## Participant message

Send each tester only the project URL for the independent phase:

https://comp4020-final-posture627k.fly.dev/readme/

Do not send this observer guide, card instructions or an invite room in
advance. Let one participant create a room and share the game's invite link
with the other. The author observes; the two players operate the game.

## Phase 1 — independent use (about 10 minutes)

Do not explain the controls or take over. Observe whether they can get from
the supplied URL to the game, create/join, Ready/start, recognize whose turn
it is, use a card and respond. If they get stuck, record where and their
words. An intervention ends that segment's independent evidence: record its
exact wording and timestamp, then label subsequent use as assisted.

The local candidate adds a real Play Card Clash link above the full README.
Verify it is present on the deployed test version. Failure to find the game
is a finding, not a reason to quietly navigate for the participant.

## Phase 2 — directed follow-up (about 10 minutes)

Keep these observations separate from Phase 1. If naturally available, ask
players to try an Attack and response, End Turn and discard, and leaving a
window unanswered for ten seconds. Check that the other screen updates
without reload. Reload/reopen the same invite URL in the same profile and
observe identity/state recovery. Random hands may not expose every action;
record "not encountered" instead of inventing coverage.

Ask both players: What were you trying to do? What did you expect? What was
hard to understand? Could you tell when your action succeeded? Was there a
moment when the other player's choice changed yours?

## Reading the logs

Every operational line has `event: "card_clash_action"`. A record includes
server-derived `participant` (anonymous p-number), canonical `room`/`roomId`,
`seat`, `action`, `outcome`, HTTP `status`, and state versions. `set_ready`
also includes the resulting ready boolean. `duplicate` means a replay, not
another state transition; `rejected` means the request did not succeed.
Automatic deadlines use `actor: "system"`, the affected seat, roomId and
matchId, and source `timer` or `reconcile`. Correlate roomId with the earlier
room creation record. Logging code remains in the server after the session.
No cookie, private hand, deck, card ID list or whole payload is logged.

## Session record — fill only after the session

- Date/time/timezone: pending
- Candidate commit/local revision and deployed-version evidence: pending
- Venue: local / deployed (choose the actual one)
- Participants: A and B; consent to anonymized notes: pending
- Browser versions, viewports and identity separation: pending
- Observer and log capture location: pending

| Time | Phase | Participant/seat | Observed action or exact quote | Matching log/version | Observation vs interpretation | Intervention / follow-up |
|---|---|---|---|---|---|---|
| pending | pending | pending | pending | pending | pending | pending |

| Check | Observed / failed / not encountered | Evidence |
|---|---|---|
| Find game from URL; create/join/ready/start | pending | pending |
| Own hand and other player's public state | pending | pending |
| Real action and other screen updates | pending | pending |
| Defence, discard, timeout | pending | pending |
| Reload/return using the same identity | pending | pending |
| Player understanding and effect of co-presence | pending | pending |

Record findings separately from changes. For each fix, cite the commit and
repeat the affected task; record whether retesting was independent or
assisted. A human session is not a redeploy or next-day persistence test.

## Crit 10 reflection

After real observations, write `reflections/crit-10.md` in your own voice
(about 150–300 words), answering:

1. What was the breakthrough that moved the work forward?
2. What did this work change about who I want to be as a software developer?

Use one concrete observation/log, explain the decision it changed, and cite
any corresponding fix/test commit. Mark outstanding retests honestly. Do not
create a completed reflection before the session.
