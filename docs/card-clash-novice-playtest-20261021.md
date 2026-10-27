# Card Clash — novice 2v2 playtest and proposed responses

**Status:** author-reported field observations recorded on 23 October 2026. The author subsequently approved the recommended combination: illustrated preparation, contextual Help/action guidance, explicit team relationships and 15-second decisions. The [local implementation record](card-clash-novice-repair.md) is separate from these observations; a new human usability retest remains pending.

## Session and provenance

- Session: 21 October 2026, approximately 16:30, UTC+8; four players, 2v2.
- Observer: the project author, present during play. This document organises the author's subsequent oral account of the observations; it is not a verbatim transcript or a contemporaneous written log.
- Experience: the author describes this group as having little or almost no card-game experience. The author also clarifies that the two earlier testers had card-game experience. These sessions therefore sampled different experience levels.
- Assistance: the author gave a small amount of operating guidance, but reports that participants still struggled to understand. This was an assisted session, not an independent URL-only test. The wording and timing of interventions were not recorded.
- Room code: not recorded. Candidate/deployed version: not recorded. Server logs were not captured for this session.
- Hosting location, devices, browsers, viewport sizes, session duration and per-participant observations: not supplied. Do not import these from the earlier Windows/Chrome sessions.
- Evidence: the author's observations and paraphrased feedback. No recording, attributable server trace, measured response times or exact participant quotations are asserted. No result about privacy, synchronisation, persistence or match completion is inferred.

## Observed difficulties

| ID | Author's field observation | Interpretation to investigate |
|---|---|---|
| N1 | Players struggled to identify whose turn it was and what they should do. | Existing state labels may require knowledge that novice players do not have. Distinguish the normal turn owner from the player currently required to respond. |
| N2 | Players did not discover that an Attack could be dragged onto another player's character/seat. | The targeting gesture and destination are insufficiently discoverable. Teach and expose the existing click/tap alternative as well as dragging. |
| N3 | Players were slow to recognise or perform a defensive response when attacked, and misunderstood some card descriptions. | Reading, recognising the required response and operating it may compete with the decision deadline. Specific misunderstood cards and elapsed response times were not recorded; do not attribute all delays to one cause. |
| N4 | Players did not clearly understand the countdown and discard rules. | The interface should explain what the current timer measures, what happens at expiry, and how many cards must be discarded. No new over-discard engine defect was reported. |
| N5 | Players struggled to distinguish the red and blue teams and identify team membership. | Existing colour and Team A/B labels did not communicate relationships clearly enough for this group. |

The author's suggested directions are illustrated rules during preparation, an in-game Help/question-mark control, a maximum decision window of 15 seconds instead of 10, and clearer team presentation. These are design proposals, not retest outcomes.

## Baseline inspected before the 23 October repair

The [UI](../card-clash/ui.ts) already has short entrance instructions, preparation banners with team labels, turn/countdown displays, contextual defence/rescue controls, and click/tap/keyboard alternatives to dragging. The finding is that these existing cues were insufficient for this novice group, not that the capabilities are absent.

The current [timer contract](../card-clash/timers.ts) uses a shared 10,000 ms duration for action, response, rescue and discard deadlines. The UI countdown ring also assumes 10,000 ms. The [rules](card-clash-rules.md) describe the timeouts; changing a client-side number alone would not extend the authoritative deadline.

One wording risk found during inspection is Attack's description, “Strike a foe,” while the rules allow targeting any other living player, including a teammate. This is a code-inspection finding, not evidence that these testers specifically misunderstood that sentence. Group effects also include teammates, and War Cry requires Attack rather than Dodge. Help must reflect these distinctions.

The previously requested Lobby size/confirmation repair remains a separate local, uncommitted change. It must not be represented as part of the version these participants tested.

## Options considered and author selection

The author selected all four recommended options below on 23 October. Alternatives are retained to make the development decision legible.

### 1. Preparation and reusable help

**Recommended:** show a compact illustrated quick start inside the room preparation screen, before Ready/Start, with an expandable eight-card reference. Reuse existing card art and clearly labelled arrows/diagrams: Attack → another player's seat; incoming Attack → Dodge; Insight → table; end turn → discard excess. Include the selected mode's team arrangement and explain that dragging is optional. Avoid requiring players to memorise a long rules page.

Add a visible `? Help` control during play, opening the same reference with the current phase's guidance first. Keep the timer and an explicit “the match continues” message visible; opening Help must not pause shared play, extend a deadline or send an action. If the state changes, the contextual section must update rather than retain obsolete instructions. Preserve keyboard focus, Escape/close and focus return.

**Smaller alternative:** illustrated preparation rules plus a static Help sheet. This costs less, but leaves players to translate general rules into an urgent current action.

### 2. State guidance and card wording

**Recommended:** pair the reference with a short, prominent current-action message. Examples: `Your turn — play a lit card or End Turn`; `Seat 2 attacked you — play Dodge or lose 1 HP`; `Discard 3 cards — hand 5, HP 2`. Show the timer owner and expiry consequence alongside the message. Use restrained emphasis when a player becomes the required responder; avoid recurring overlays that cover cards or targets.

Highlight compatible cards and legal targets for the selected action, retaining the existing input paths and legality checks. Review all eight descriptions using “when usable / target / effect / response” as a writing checklist. In particular, explain Dodge as a response card, War Cry's Attack response, group effects including allies, and proactive self-Heal versus a requested rescue. Do not silently change targeting or rescue rules to simplify the wording.

**Smaller alternative:** revise card descriptions and help content only. Turn and response discoverability would still require a retest.

### 3. Timing — unified 15-second option selected

- **Recommended for this novice-focused revision:** give each action, defensive response, rescue opportunity and discard phase a maximum 15-second decision window. Preserve current reset/suspension rules and the existing deadline across partial discards. A valid decision can finish earlier; 15 seconds is not a minimum wait or a cap on an entire multi-action turn.
- **Narrower alternative:** extend only the main action window to 15 seconds, leaving responses/rescue/discard at 10. This changes less pacing, but does not directly address the reported difficulty responding to attacks.

The recommended option can lengthen sequential group/rescue resolution in 2v2. Fifteen seconds is the author's proposed value, not an experimentally established optimum. Any selected change must align the authoritative timer, persisted deadlines, UI ring/text, rules, README/harness and tests; it must not retroactively extend existing stored deadlines or become a client-authorised timeout.

### 4. Team identity

**Recommended:** retain the painted composition, add an explicit `You — Team A (Red)` or `You — Team B (Blue)` identity, and label other seats `Ally` or `Opponent` relative to the viewer. Reuse shields with distinct A/B marks or patterns as well as colour. Preparation should state the actual 2v2 assignment: seats 1 and 4 versus seats 2 and 3. A turn cue and a response cue must remain visually distinct from team colours.

**Smaller alternative:** clearer A/B and Ally/Opponent text using existing shields. New large character art or a battlefield redesign is unnecessary for either option. Ally labels must not imply that currently legal teammate targeting has been disabled.

## Proposed evaluation and evidence

The earlier experienced-player success and this assisted novice session support a narrower conclusion: learnability remains unestablished for players without card-game experience. They do not establish experience level as the sole cause, because the sessions were not controlled comparisons.

For the next human retest, record the candidate commit, actual environment, room code, time and interventions. In a new novice session, observe whether players can identify their team, turn and required responder; discover both input routes; answer an Attack and a group effect; and explain discard/expiry. Treat a teaching intervention as the boundary between independent and assisted evidence. Record time to a meaningful action if measuring responsiveness; server request times alone omit time spent confused before a request.

Review the 15-second choice against observed understanding and 2v2 waiting time. Keep failed attempts and remaining confusion in the record. Capture allowlisted room-specific server events before play, while using observation to assess comprehension; neither screenshots nor logs alone establish it.

## Design references for these proposals

These references inform the proposed response retrospectively; they are not claimed as sources used before the session or as proof the proposals work.

- Harley, A. (2018). [Visibility of System Status](https://www.nngroup.com/articles/visibility-system-status/): communicating current state motivates explicit turn/responder and expiry cues.
- Budiu, R. (2024). [Memory Recognition and Recall in User Interfaces](https://www.nngroup.com/articles/recognition-and-recall/): visible choices motivate compatible-card and target cues instead of relying on remembered instructions.
- Kendrick, A. (2020). [Help and Documentation](https://www.nngroup.com/articles/help-and-documentation/): concise task-focused proactive and reactive help motivates preparation guidance and reusable contextual Help. Help complements improvements to the interaction itself.
