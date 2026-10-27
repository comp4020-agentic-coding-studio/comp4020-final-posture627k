# Before/after screenshots: scene and hand composition

These four images are genuine, unedited local Chromium screenshots captured
during the actual P5.1–P5.3 repair session on 17 October 2026, recovered from
the local engineering working directory used for that repair (outside this
repository). They are presented here as before/after comparisons to support
[PROCESS.md](../../PROCESS.md)'s account of that repair; they are not a new
screenshot session and no claim is made beyond what each image shows.

## 1. Inset double-background scene → full-screen war table

- **Before**: `scene-before-1920x1080.png` — captured against the running app
  at commit [aa66609](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/aa66609)
  (the last commit before the P5.1–P5.3 repair). The castle-hall painting is
  visible as a separate background around an inset, bordered, rounded table
  panel — the "framed picture" defect PROCESS.md describes.
- **After**: `scene-after-1920x1080.png` — the same 6-card hand, same room
  mode, captured against the repaired implementation shipped in commit
  [393cc48](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/393cc48).
  The war-table painting now fills the viewport at cover scale with no
  exterior stage margin, border, or mask; the castle-hall layer is hidden
  during battle.

## 2. Old dashboard/card display → first-person fanned hand

Both crops below are the lower third of the same pair of screenshots above
(`scene-before-1920x1080.png` / `scene-after-1920x1080.png`), isolating the
hand region so the dashboard-vs-fan difference is visible at a readable size:

- **Before**: `hand-before-1920x1080.png` — six flat, evenly-spaced cards
  sitting directly on the table surface with no connection to a player
  presence; no gauntlets or hands are rendered at all at this commit.
- **After**: `hand-after-1920x1080.png` — the same six cards rendered as a
  rotated fan, with a pair of armored gauntlets anchored to the outer cards'
  lower edges, placing the hand in the player's own first-person foreground.

## What this evidence does and does not show

- It shows the actual rendered output of the named commits, at 1920×1080,
  for a representative 6-card hand. The SHA-256 of `scene-after-1920x1080.png`
  matches `docs/evidence/p56/1920x1080-normal6.png` already in this
  repository, confirming both were produced from the same packaged source.
- It does not show every intermediate step between those two commits (P5.1
  and P5.2 are not separately pictured here), other viewports, other phases,
  or any human playtest reaction — see [the P5.3 audit](../card-clash-p53-audit.md)
  and [P5.6 evidence](../p56/README.md) for the broader automated matrix.
- Captured by the agent driving that repair session, not by the author
  directly; the author's own visual inspection and acceptance decisions are
  recorded separately in PROCESS.md and are not re-claimed here.
