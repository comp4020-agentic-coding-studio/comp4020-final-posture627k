# Card Clash — two-person URL-only playtest

Status: **original human session plus retained follow-up evidence; Lobby usability remains open**.
On 17 October 2026, two classmates who had not developed the game used the
newly deployed version for about five minutes and played one match. The
author reports no operational hints were given. The record below is based
on the author's account of the session and participant feedback, not a
screen recording or matched server trace. Earlier automated checks remain
separate evidence. The protocol planned a longer session; its proposed
duration and viewport targets must not be read as actual coverage.

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

## Session record — 17 October 2026

- Venue/version: production; the author identifies the newly deployed
  candidate. Release baseline: `9276b651fc8d28dbdee9fbda7426a361be72f688`.
  No session-side build identifier or screenshot was retained/provided.
- Room: `EVM43AVT`; two independent identities; approximately five minutes,
  one match. Exact start/end times and game mode were not supplied.
- Participants: two classmates unfamiliar with development; anonymized as
  A and B. They agreed to test; permission to publish identifiable material
  has not been established, so no names or identifying screenshots are used.
- Prior card-game experience: on 23 October the author clarified that these
  two testers had played card games before. This later clarification does
  not establish the experience of all potential users.
- Environment: Windows laptops, Chrome; browser versions, screen dimensions
  and viewport sizes not recorded. This is not evidence of portrait testing.
- Assistance: the author explicitly reports giving no operating hints.
- Evidence source: author-supplied notes and paraphrased participant feedback.
  No per-participant attribution, exact quotes or action timestamps supplied.

| Check | Author-reported outcome | Evidence boundary |
|---|---|---|
| Find game, create/join and start | Successful independently | No per-step timestamps or recording |
| Understand turns, available cards and targets | Successful | Applies to this brief session, not every card |
| Play, defend, discard and understand both screens' changes | Successful overall; discard defect below | Specific card types not recorded |
| Synchronization without refresh | Successful; no delay noticed | Subjective observation, no measured latency |
| Hidden-hand privacy | Neither tester saw the other's hidden hand | Visual observation, not a network-payload audit |
| Ten-second timeout and rescue | Author confirms successful testing | Exact scenario/action trace unavailable |
| Refresh/reopen with same identity and state | Author confirms successful testing | Same-day recovery; not next-day/redeploy evidence |
| Participant response | Art was the most liked aspect; self HUD felt too small | Paraphrases, not verbatim quotations |

### Findings and follow-up

These are the **original** findings. [Subsequent local repairs](card-clash-playtest-repair.md) address all four and pass automated checks. Repairs were published in 18ad415; the later follow-up below confirms two fixes and adds a Lobby usability finding. The original observations below are retained unchanged.

| ID | Reported finding | Code inspection / interpretation | Required follow-up |
|---|---|---|---|
| U1 | Some targetless cards required double clicking; dragging to the table center failed | `resolveDropTarget` only accepts a hit inside an element with `data-drop`; for direct cards this is the central prompt, not the whole painted table. The click handler sends a direct action on one click, so a universal double-click requirement is not established. | Identify affected card/state and reproduce in Chromium. Align visible table affordance and drop hit area; preserve one-click, keyboard and cancel paths. |
| U2 | With 2 HP and 5 cards, players could discard more than the expected 3 | UI selection has no excess-count cap; `discardCards` validates ownership but not a maximum count. Rules currently say hand size must be at most HP; the author's feedback clarifies the intended boundary. | Clarify the rule and enforce the remaining excess on both client and authoritative server, preserving partial discard and the existing deadline. Test 3 accepted versus 4/5 rejected, with rejected state unchanged. |
| U3 | No return-to-lobby control during/after play | Battle topbar and completed-match controls contain no lobby navigation. This is a navigation gap, separate from excluded rematch/replacement features. | Add navigation with clear active-match behavior; do not imply that navigation cancels a match or resets identity. |
| U4 | Self information HUD felt too small | A readability finding on Windows laptops; exact viewport not recorded | Improve compact text/HP readability; inspect fan/control clearance without rebuilding the visual composition. |

### Server-log capture result

A subsequent read of `flyctl logs --no-tail --json` returned 100 structured
action records across the app but none carrying room `EVM43AVT`; no retained
room-code record supplied a reliable roomId association for its timeout
events. Consequently **no server trace has been attributed to this session**.
This command reads the recent buffer, not a complete history. Absence from
that buffer is not evidence that the session did not happen. Exact action
counts, server timing and a log-supported narration cannot be reconstructed
from the available evidence. A failed browser-only drag may generate no
request at all and needs browser observation as well as server logs.

The local export retained only allowlisted fields and a capture summary;
it did not save platform raw output, cookies, tokens, hands or deck data.
See [capture metadata](evidence/crit10-playtest/log-capture-summary.json).

### Saving logs for a repeat session

Run these commands in Ubuntu/WSL **before** participants begin. Keep the
terminal open throughout; stop with Ctrl+C after the session:

```bash
cd /home/posture627ka/comp4020-final-posture627k
umask 077
mkdir -p "$HOME/card-clash-playtest-logs"
mise exec -- /home/posture627ka/.fly/bin/flyctl logs -a comp4020-final-posture627k --json | tee "$HOME/card-clash-playtest-logs/session-$(date +%Y%m%d-%H%M%S).json"
```

These files live outside the repository. The output is a stream of JSON
objects, not necessarily one JSON array or one object per line. Before
publishing an excerpt, select `card_clash_action` records for the room;
associate timeout records by roomId from its player-action records. Retain
timestamps, anonymous participant/seat, action/outcome and version changes.
Review/redact first; never publish raw platform logs or authentication data.
Record the room code, local start/end time and timezone in the test notes.
Saving a trace next time does not retroactively supply this session's logs.

For each subsequent fix, cite its actual commit and repeat the affected
task with a saved trace. Mark independent versus assisted retests. This
session does not establish next-day persistence, final visual acceptance
or complete Crit 10 compliance without the required log-based observation.

## Follow-up — retained capture and new feedback

The author supplied `crit10-20261017-190236.json` and confirmed JCD73KK4 as
the follow-up room, operated by the same two classmates with independent
identities, unchanged Windows/Chrome environment and no operating hints.
The retained room-specific window is 19:02:52.668–19:04:08.904 UTC+8 on
17 October 2026; do not substitute the first session's five-minute duration.

The [redacted evidence](evidence/crit10-retest/README.md) preserves 41 accepted
operations for two server identities. It excludes 160 unrelated timeout
records and retains no raw platform output, credentials or private hands.
This does not recover EVM43AVT's earlier trace or establish live narration.

The author reports that classmates confirmed targetless use and discard
limits repaired. They found the Lobby button too small and recommended a
confirmation before returning: **new open issue L1**. No confirmation flow
or button-size change has been implemented in this documentation submission.
No separate new HUD acceptance result was supplied. Gestures, discard
quantities, navigation outcomes and subjective readability are not encoded
in these action records; the evidence README distinguishes them from the
author's report. Final visual acceptance remains separate.

## Additional session — novice 2v2 playtest, 21 October 2026

At approximately 16:30 UTC+8 on 21 October, the author observed four players
in 2v2 with little or almost no card-game experience. Despite a small amount
of operating guidance, players struggled to identify turns, discover Attack
targeting, respond to attacks, interpret some card descriptions, understand
countdown/discard rules and distinguish the teams. This was an assisted
session, not an independent URL-only test. The room code and candidate
version were not recorded, and no server logs were captured.

The [field-observation record and proposed responses](card-clash-novice-playtest-20261021.md)
were organised from the author's oral account on 23 October. They distinguish
observations from interpretation, offer illustrated preparation rules,
reusable/contextual Help, clearer team cues and two timing options, and retain
the alternatives considered. The author approved the recommended combination
on 23 October; [the local repair record](card-clash-novice-repair.md) separates
implementation checks from the still-pending human retest. No improved
usability outcome is attributed to this earlier session. It challenges generalisation
from the earlier experienced testers; it does not invalidate their results.

## Crit 10 reflection

The [Crit 10 reflection](../reflections/crit-10.md) now records the original
session, subsequent trace and follow-up limits, answering:

1. What was the breakthrough that moved the work forward?
2. What did this work change about who I want to be as a software developer?

Use one concrete observation/log, explain the decision it changed, and cite
any corresponding fix/test commit. Mark outstanding retests honestly. Do not
create a completed reflection before the session.
