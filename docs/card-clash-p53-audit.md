# Card Clash P5.3 audit and repair

> Historical P5.3 repair snapshot. P5.4–P5.6 subsequently changed hand scale,
> angles and HUD composition. Portable P5.6 screenshots and their evidence
> boundaries are in [docs/evidence/p56](evidence/p56/README.md). Machine-local
> paths below are retained as historical development pointers.

Date: 17 October 2026 (UTC+8). Repository: `\\wsl.localhost\Ubuntu\home\posture627ka\comp4020-final-posture627k`.

Implementation and automated verification are complete. Codex inspected representative rendered screenshots. **Final human visual acceptance remains pending.**

## 1. Root causes and code locations

There is one battle renderer and one shared `handDock()` (`card-clash/ui.ts:1732`), used by every phase and viewpoint. No separate response/discard hand renderer was found.

| Defect | Verified cause | Repair location |
| --- | --- | --- |
| Inset battle over the castle | The old `.battle` had a 1640px cap and exterior padding; `.stage` used contain-like sizing, rounded edges, shadow and a fading mask, while `.stage-wrap` had a negative bottom margin and the castle remained visible. The 1920px baseline screenshot also extended below the viewport. | `card-clash/ui.ts:56`, `:183`, `:249`, `:1927` |
| Brown strip / changing foreground | Desktop already had a transparent shared dock. The narrow breakpoint added a dark sticky-dock gradient, while `handGripArt()` conditionally replaced two resting images with a large composite combat pose. Existing cutouts themselves included leg/static-card fragments. A second desktop dashboard rendering path was not found. | `card-clash/ui.ts:335`, `:381`, `:1725` |
| Cramped or obscured cards | The fan shared a flex row with variable-width instructions and controls. On portrait the six-card baseline received only about 180px and shrank cards to about 59px. Resting transforms also differed with availability; lifted states were outside the resting geometry assumptions. The existing four-corner rotation math was useful and has been retained. | `card-clash/ui.ts:338`, `:410`, `:458`, `:1828` |
| Unrealistic first-person presence | Previously extracted grip images included unrelated body/card pixels; combat swaps reintroduced entire poses. | Two supplied PNG assets; `card-clash/ui.ts:1725`, `server.ts:1291` |
| Drag lag / interruption | The ghost inherited the card's 160ms transform transition despite rAF updates. Hit-testing hid/showed it every frame, and its dimensions came from an already rotated/scaled rectangle. Unchanged SSE refreshes and FX expiry could rebuild the source DOM during a drag. | `card-clash/ui.ts:462`, `:801`, `:954`, `:1022`, `:1111`, `:1964` |

Pointer testing additionally verified that hover keeps the resting angle so it does not straighten away from the pointer before a click. Selected and targeting cards straighten after selection.

## 2. Files changed in this repair

- `card-clash/ui.ts`: scene, foreground positioning, fan allocation, responsive rules, card readability, pointer lifecycle and focus preservation.
- `server.ts`: allowlisted PNG gauntlet URLs and correct MIME type; existing pose URLs retained.
- `card-clash/assets/first-person/gauntlet_left.png` and `gauntlet_right.png`: exact copies of the two supplied attachments, with original alpha and aspect ratio.
- `spec/card-clash-ui.test.ts`: combat now asserts a stable gauntlet pair; added phase/viewpoint/mode and discard-focus regressions.
- `scripts/card-clash-browser-check.cjs`: repeatable real-Chromium layout, pointer, touch, keyboard and resize checks; uses an external Playwright installation, adding no app dependency.
- `docs/card-clash-p53-audit.md`: this handoff.

The original uncommitted work and asset archives remain. No engine/rules, database, SSE transport, deadline implementation, protected coursework files, lobby design, dependencies, or development-history documents were changed. No commit, push, deploy, reset, stash or deletion of existing user work was performed.

## 3. Full-screen scene

The original `knights-war-table.webp` is the single battle environment. The castle layer is hidden during battle. A uniform cover scale, `max(viewportWidth/1672, viewportHeight/941)`, sizes the painting and its shared overlay coordinate surface together. This preserves aspect ratio while cropping excess edges. There are no exterior stage margins, masks, rounded stage borders or inset shadows. Portrait uses the same painting with cover and simpler viewport-relative controls.

The castle-hall homepage and waiting room retain their artwork and layout. Public knights, HP, phase, timer, piles and Chronicle remain live HTML.

## 4. One fan across states

HUD, fan and controls now have independent anchors. Instruction length cannot consume the fan's width. The same measured corner bounds, spacing and stacking apply during normal play, waiting, targeting, discard, defence, group responses and rescue. Natural spacing is 76% of card width, compressed when necessary. All six-card resting geometry was compared across phases in the browser. Initial measured geometry is applied without animating from zero-angle defaults; normal hover/selection easing is restored afterwards.

Hover on a fine pointer, or keyboard focus, raises a card while preserving its angle. Coarse touch pointers do not inherit mouse hover movement. Selection/targeting raises and straightens it above neighbouring cards and gauntlets; rules text gets more space without replacing the illustration. Discard uses the same fan with pressed state and a checkmark. Keyboard focus survives rebuilding a selected discard card. Portrait gives the fan a full-width area above the compact HUD/control row and places titles on the exposed left portion.

## 5. Independent gauntlets

`card_clash_scene_hands_v1.zip` was not found in the repository or the checked Downloads location. Its contents were not assumed. The two actual attached PNGs were inspected and used directly.

Each image keeps its native 1122:1402 ratio. Width is derived from card width, capped at 250px. Separate fingertip anchors follow the first and last card's lower edges; the forearms extend off the screen. Their z-index is above resting cards and below hovered/selected cards. All decorative images have `pointer-events:none`. Combat effects remain on the battlefield and never replace the pair with a combined body pose.

## 6. Dragging

The floating ghost uses untransformed card dimensions and rAF-batched `translate3d`, with no transform transition during tracking. Only canceled returns animate. The ghost and its descendants are excluded from hit-testing, so frame-by-frame hiding is unnecessary. Valid targets highlight as the pointer moves.

Unchanged refreshes preserve the source DOM. Same-version FX expiry defers rebuilding until release; a new authoritative version safely cancels an obsolete drag. Escape, lost capture, pointer cancellation, invalid drops, listener teardown, pending rAF cancellation and post-drag click suppression clean up consistently. Click, keyboard, `busy`, request IDs and expected-version submission remain available through the existing single action function.

## 7. Browser verification and screenshot review

The automated browser matrix uses **deterministic filtered projection fixtures** served with the real app HTML/assets. It verifies presentation and input; it does not prove gameplay outcomes. The separate Docker smoke below uses the real, unmocked server and randomly dealt hands.

84 rendered layout scenarios cover 1920×1080, 1366×768, 844×390 and 390×844:

- Normal 4/5/6-card hands; both duel viewpoints; waiting and target selection.
- Discard with selection; attack response for both viewers; War Cry and Arrow Volley.
- Rescue for both viewers and self-rescue.
- Every 2v2 seat and all 1v2 seats.

At every viewport, checks include transformed bounds, coverage of the scene, reachable controls/cards, consistent six-card phase geometry, complete inspected rules text, real mouse dragging and target highlight, exact-once action intent, invalid-drop/Escape cancellation, keyboard actions, unchanged-refresh drag continuity and a resize roundtrip. CDP touch input in fresh mobile contexts additionally verifies real touch drag and touch cancellation at both mobile sizes, starting in a measured visible interior at least 24px across. The trace showed Chromium retargeting a near-edge touch to the adjacent rotated card, so touch assertions use the intended card interior rather than a thin shared corner. No JavaScript page errors were observed.

Representative screenshots were inspected for desktop 4/5/6-card play, selection/discard, laptop rescue, landscape response/2v2, portrait normal/rescue/2v2, and dragging. This is Codex screenshot review, not the user's visual approval.

Evidence folder:
`C:\Users\27776\.codex\visualizations\2026\10\16\01a146c7-eafd-7980-9598-c9a8f0c1d673\p53-evidence`

Useful files: `1920x1080-normal6.png`, `1920x1080-discard.png`, `1366x768-rescue.png`, `844x390-2v2-seat4.png`, `390x844-normal6.png`, `390x844-rescue.png`, `bounds.json`, `summary.json`, and `docker-smoke.json`.

## 8. Verification results

- `git diff --check`: passed.
- `pnpm typecheck`: passed.
- `pnpm check`: **367 tests passed, 21 files**; running-image HTTP invariants included.
- Docker build: passed for `card-clash-p53-final:local` (image config `9242a15923dbc14f3cc69ce4dc4e4fbeada870b2fab0cab8a8f651062845c210`).
- Real two-browser Docker smoke: passed. Room `A89VSUHJ`, match 1: a real pointer Attack submitted exactly one POST; version advanced 2 → 3; the other browser received defence through SSE and played Dodge; version advanced to 4. Real 10-second deadlines, filtered hands, allowlisted PNG/404 routes, `/readme/`, and SQLite identity/match persistence after a container restart passed. No test-state injection was used for this smoke.
- Real browser projection/input matrix: **84 cases passed**; details in `summary.json` and `bounds.json`.

The browser script requires a separately available Playwright installation. Example:

```sh
APP_URL=http://127.0.0.1:8784 PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/card-clash-browser-check.cjs /tmp/p53-evidence
```

To preview the retained local Docker artifact after the audit, run `docker start -a card-clash-p53-final` in WSL, then open `http://localhost:8784/`. Its SQLite data is isolated audit data. The normal source workflow in README remains available.

## 9. Limits and handoff

- Verified in Chromium; Firefox, Safari and physical-device behaviour were not tested.
- Chromium may assign touches at the thin overlapping corners to a neighbouring card. Use the exposed title/interior or the fallback action buttons.
- Portrait intentionally uses a compact, overlapping fan. Selecting/focusing a card and the keyboard/action controls expose its details/actions; the elaborate desktop composition is not replicated there.
- The supplied gauntlets retain their red sleeve/gold armour for either team; no new team artwork was generated.
- Very large hands beyond the verified 4–6-card cases did not receive a dedicated visual acceptance pass.
- Human playtesting and final aesthetic acceptance remain with the user. No final visual acceptance is claimed.

A deployment credential was encountered while reading local tool configuration. It was not used or modified; rotate it separately. Its value is not included in this report or screenshots.
