# Card Clash — novice guidance repair

Date: 23 October 2026. Baseline: `70ec40a` plus the preserved local Lobby repair and playtest documentation. Status: local implementation and automated verification complete. No new human acceptance is claimed.

## Why this slice

The [21 October assisted novice 2v2 session](card-clash-novice-playtest-20261021.md) exposed turn/response confusion, undiscovered targeting, card-description misunderstandings, unclear timeout/discard consequences and weak team recognition. The author selected the recommended response on 23 October. Earlier success with two experienced card players is retained as evidence about that session, not proof of novice learnability.

## Implemented behaviour

- Preparation includes four illustrated steps using existing card art: target a seat, respond with Dodge, play direct cards on the table, and discard excess. An expandable eight-card reference explains timing, target, effect and response. The Ready/Start approval mechanism is unchanged.
- `? Help` opens a native modal dialogue with the same material and the current decision first. It displays the active decision owner and remaining time. Server updates refresh the context without closing the dialogue or resetting its expanded reference. Escape/Close return focus to Help; Tab/Shift+Tab stay within it. Opening or closing Help sends no gameplay action and does not pause shared play.
- The existing central prompt now states the required action and timeout consequence, including waiting and discard. The turn owner remains distinct from the current responder. Response phases use compact RESPOND/RESCUE labels. Duplicate response prose is removed from the visible button group, while existing decision buttons remain.
- Card-face text is concise; the reference carries full detail. Attack/Seize/Disarm wording no longer implies that only enemies are legal targets. War Cry requires Attack, Arrow Volley requires Dodge, group effects include allies, and normal self-Heal is distinguished from requested rescue.
- You/Ally/Opponent labels appear alongside Team A/B, red/blue identity and the existing distinct shield marks. Relationships follow each viewer, including all four 2v2 seats and the asymmetric 1v2 mode. The existing landscape rule hiding all seat tags is overridden for relationship labels only. Legal ally targeting is preserved.
- All newly created action, defensive-response, rescue and discard windows use 15 seconds. `CARD_CLASH_DEADLINE_MS` is shared by server deadline calculation and browser display. Existing stored absolute deadlines are not migrated or extended; partial discards retain their original expiry. Reset/suspension and timeout outcomes remain unchanged.
- Laptop and landscape guidance spacing is adjusted without changing fan geometry, drag mechanics, painted environments, gauntlet proportions, SSE, database schema or privacy filtering. The earlier local 80×44px Lobby control and native confirmation remain intact.

## Code, contracts and checks

Implementation: [UI](../card-clash/ui.ts), [timer duration](../card-clash/timers.ts). Current contracts: [rules](card-clash-rules.md), [harness](../CLAUDE.md), [README](../README.md).

Regressions: [UI tests](../spec/card-clash-ui.test.ts), [timer tests](../spec/card-clash-timers.test.ts), [existing Chromium matrix](../scripts/card-clash-browser-check.cjs), and [novice Chromium checks](../scripts/card-clash-novice-browser-check.cjs). The course-provided invariant tests and CI/deployment constraints are unchanged.

The browser scripts use an externally installed Playwright runtime and real Chromium against the running HTML/assets, with deterministic filtered state projections. They assess rendering and input; the suite separately exercises real rules, storage, HTTP projection and deadlines. They do not establish comprehension, satisfaction or improved learning speed.

## Verification and remaining limits

[Portable verification evidence](evidence/novice-ui/verification.json) records:

- `git diff --check`, `pnpm typecheck`, `pnpm check` (380 tests / 22 files), and `pnpm check:evidence`: passed.
- Chrome 156.0.8078.47 at 1920×1080, 1366×768, 844×390 and 390×844: the existing 84-case layout/input matrix passed, covering normal 4/5/6-card hands, viewpoints, response/rescue/discard, mouse/keyboard, touch and drag cancellation.
- Sixteen additional 2v2 viewpoint cases passed (four seats × four viewports), including preparation, visible relationships, live Help across phases, clock progression, native keyboard/focus handling and active/completed Lobby confirmation round trips. No page errors were observed.
- Representative screenshots were inspected by Codex: [desktop normal play](evidence/novice-ui/1920-normal6.png), [laptop Help](evidence/novice-ui/1366-help.png), [landscape response](evidence/novice-ui/844-response.png) and [portrait functionality](evidence/novice-ui/390-normal6.png). This is not the author's final visual acceptance.

Human retesting with novice players is still required, particularly whether 15 seconds is sufficient and whether sequential 2v2 response/rescue windows feel too slow. Firefox, Safari and physical-device behaviour are not established. Existing historical test records retain their original 10-second timing; this repair does not rewrite what those participants tested.

Nothing in this record asserts a commit, push, deployment or final visual acceptance.

## Manual follow-up — duplicate-card targeting, 23 October

During local review the author reported that clicking one of two same-type
cards also raised the other as selected. The affected card type was not
specified in the report. Inspection found a shared targeting-action string:
every card with that action received the targeting class. The earlier
browser fixtures used distinct card types and did not exercise this case.

The local repair tracks the chosen card ID alongside the action. Selecting
another copy transfers the highlight; clicking the same copy again or
Cancel clears it. Quick actions select one matching physical card. An
unchanged refresh preserves it, while a changed authoritative state or a
completed submission clears it. Target-card buttons expose their selected
state with `aria-pressed`. Discard selection remains independently keyed by
card ID. Rules and server action payloads are unchanged.

The new UI regression failed before the fix (two IDs selected instead of
one) and passes afterward. `pnpm check` passes 381 tests in 22 files,
including typechecking; `git diff --check` passes. Twelve targeted Chrome
cases cover duplicate Attack, Seize and Disarm at all four target viewports,
including real mouse/keyboard switching, quick actions, cancellation,
unchanged refresh and the unselected copy's resting transform. See
[browser results](evidence/duplicate-selection/browser-summary.json),
[the repeatable check](../scripts/card-clash-duplicate-browser-check.cjs)
and [the second Attack selected alone](evidence/duplicate-selection/1366-second-attack-selected.png).
These are filtered-projection checks, not a new human acceptance result.

The author-requested preview on port 8823 was stopped. Verification used
short-lived isolated test servers that were terminated afterward. The local
repair remains uncommitted; no push or deployment was performed.

## Manual follow-up — card readability, 23 October

The author selected a focused card-copy and typography pass after reviewing the
art. This is a local implementation record, not another participant session.

- Names retain the existing serif face, with enough line height for two-line
  names. Core effects use a left-aligned sans-serif face at 12.48px on desktop
  and laptop, with response names and quantities emphasized. The existing card
  rectangles, fan geometry, hover/selection motion and gauntlets are preserved;
  the illustration window gives a little space to the larger copy.
- Eight short effects and practical ribbons (Target, Block, Heal / Rescue,
  Take card, Draw, All others) replace abstract categories. Seize and Disarm
  explicitly identify the target. Full timing, ally-targeting and response
  restrictions remain in Help and in each card button's accessible description.
- Card footers explain Response only, Full HP, Attack limit used, Empty hands,
  waiting and the required response. `computeAvailability` still decides legal
  play. Regression coverage checks that an Attack response remains legal after
  the ordinary attack limit, and that full-HP players may still provide rescue.
- Small live-SVG/card-count cues identify Seize (Take 1) and Insight (Draw 2).
  The existing paintings are retained. A transparent-to-22% dark edge shade
  slightly reduces background-guard contrast without dimming the central stage.
  New decorative layers have `pointer-events: none`.

[Verification evidence](evidence/card-readability/verification.json) records
`git diff --check`, `pnpm typecheck` and `pnpm check` (382 tests / 22 files).
Real Chrome checks passed at 1920×1080, 1366×768, 844×390 and 390×844:
84 existing layout/input projections including 4/5/6-card hands and viewpoints;
96 resting/hover face measurements covering all eight card types;
40 contextual status checks; and 12 duplicate-selection cases. The new
[readability check](../scripts/card-clash-readability-browser-check.cjs) records
unclipped title/rule/status bounds; the existing matrix covers real pointer,
keyboard, touch, drag cancellation, discard and Lobby controls. Projections are
deterministic test data, with the running application's actual HTML and assets.

Representative screenshots inspected by Codex include
[the laptop six-card fan](evidence/card-readability/1366-normal6.png) and
[Seize inspected](evidence/card-readability/1366-seize-hover.png).
Small mobile faces still use smaller type (9.6px landscape, 10.56px portrait),
and the resting fan deliberately overlaps; hover/focus/selection is the way to
inspect an entire card. Comprehension and final visual acceptance require the
author's review and novice retesting. No final acceptance is claimed.

The manual preview remains stopped. Temporary verification servers were
terminated after checking. This pass was not committed, pushed or deployed.

## Manual follow-up — four-seat perspective, 23 October

The author identified that 2v2 still placed all three other players across the
far edge. The [four-seat repair record](card-clash-seating-repair.md) documents
the viewer-relative left/across/right layout, preserved absolute seat targets,
small-screen controls and the new geometry/input regressions. This is a local
implementation follow-up, not a new human playtest or final acceptance.
