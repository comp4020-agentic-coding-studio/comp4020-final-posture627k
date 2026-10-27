# Card Clash — four-seat perspective repair

Date: 23 October 2026. Local follow-up to the author's screenshot review.
No new participant testing or final visual acceptance is claimed.

## Finding and repair

The author noticed that 2v2 placed the viewer at the near edge and all three
other players at the far edge. The renderer mapped every non-viewer into the
same `.far` flex row. Earlier browser checks covered all viewers but checked
bounds and input, without asserting the intended seat directions.

The 2v2 renderer now computes a direction from the fixed clockwise seat order.
The viewer occupies the near edge through their existing hand/HUD. Other
players occupy the left, across and right edges:

| Viewer / near | Left | Across | Right |
| --- | --- | --- | --- |
| 1 | 2 | 3 | 4 |
| 2 | 3 | 4 | 1 |
| 3 | 4 | 1 | 2 |
| 4 | 1 | 2 | 3 |

The offset is `(seat - viewerSeat + 4) % 4`. Eliminated players keep their
station, rather than causing other players to change direction. Teams remain
A = {1,4} and B = {2,3}; an ally may therefore be beside the viewer. Actual
seat numbers remain the target IDs. No rules, engine, API, persistence,
privacy filtering, SSE or deadlines are changed.

`.stage.seats-four` and `.far.around-table` scope the new layout to 2v2.
Side panels are compact (180px desktop, 138px landscape, 108px portrait),
with HP, team, relationship and hand count retained. Repeated decorative card
backs are omitted at the sides. Artwork proportions, the painted environment,
the existing fan and gauntlets remain intact. The overlay container passes
pointer input through; the actual seat panels remain targetable.

The clock and central prompts use the space between the four seats. Chronicle
moves to the upper right on wide screens; the extra discard-card overlay is
hidden in 2v2 to clear the right station, while its count/type and the painted
deck remain. Narrow layouts also keep rescue and result text above the fan.
Target hints appear above the stations. On small screens, the three fallback
target buttons and Cancel form two columns; full team information remains in
accessible labels and tooltips. The 1v1/1v2 layouts are retained.

## Verification

[Recorded results](evidence/four-seat-layout/verification.json):

- The new UI regression failed before the repair (zero directional stations)
  and passes afterward. It checks every viewer and each of the three targets
  through the real Hono app, including legal ally targeting, unchanged
  deadlines on selection, and fixed positions after elimination.
- `git diff --check`, `pnpm typecheck` and `pnpm check`: passed, 383 tests in
  22 files. The course-provided invariants are preserved.
- Real Chrome 156 at 1920×1080, 1366×768, 844×390 and 390×844: 160 four-seat
  projections passed. Each viewer covers 4/5/6-card normal play, selected
  targeting, defence, group response, rescue, discard, completion and an
  eliminated station. Checks assert left/across/right geometry, correct
  absolute seats, visible controls and no panel/prompt/fan intersections.
- Forty-eight mouse drags (each viewer × viewport × direction) submitted
  the correct targets. Each viewport also passed Escape drag cancellation,
  keyboard Cancel, keyboard targeting of the right seat and direct Insight
  drops outside the narrow central prompt.
- The existing 84-case layout/input matrix passed, including other modes,
  mouse/keyboard, touch, cancellation, direct cards, discard and Lobby.

The [dedicated browser check](../scripts/card-clash-seating-browser-check.cjs)
uses deterministic, filtered state projections with the running app's HTML and
assets. Its companion UI test exercises real server transitions. These checks
do not establish human comprehension, a new live four-player playtest, or
final visual acceptance. Small-screen layouts prioritize functionality;
physical devices, other browsers and unlisted viewport sizes remain unverified.

Representative screenshots inspected by Codex:
[desktop, viewer 1](evidence/four-seat-layout/1920-seat1-main6.png) and
[laptop, viewer 4](evidence/four-seat-layout/1366-seat4-main6.png).
The layout bounds and per-direction results are stored alongside them.

The earlier manual preview on port 8823 stays stopped. All verification used
short-lived isolated servers, stopped afterward. Existing uncommitted work is
preserved. This repair was not committed, pushed or deployed.