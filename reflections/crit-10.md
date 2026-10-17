# Crit 10 reflection

**What was the breakthrough that moved the work forward?**

On 17 October 2026, two classmates unfamiliar with development played the
deployed Card Clash using independent identities and no operating hints.
They understood turns and liked the artwork, but found failed targetless
drops, excessive discarding, missing lobby navigation and a small HUD.
Five cards at two HP made the discard boundary concrete: they expected to
discard three, but could discard more.

I directed focused repairs within the existing composition.
[18ad415](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/18ad415)
expanded the drop surface, enforced discard limits on client and server,
and improved navigation and HUD information. Corrections reached CLAUDE.md,
the rules and regression tests. In the follow-up, the same classmates
confirmed targetless use and discard limits were repaired, but found the
Lobby button too small and requested confirmation. That new issue remains open.

**What did this work change about who I want to be as a software developer?**

I found a gap in my observation process. Logging existed, but I had no
retained trace for the original room EVM43AVT. I cannot claim that I
narrated that session from logs or measured its latency.

I subsequently retained a [follow-up trace](../docs/evidence/crit10-retest/README.md)
for JCD73KK4: 41 accepted operations attributable to two server identities.
I excluded unrelated rooms and replaced participant IDs with stable labels.
The trace establishes server attribution, while the classmates' feedback
supports the usability findings; it does not encode gestures or discard
quantities. Saving it also does not prove live narration occurred.

I want to direct agents through observed problems and preserve evidence of
the decisions they change. The Lobby feedback shows why a deployed repair
still needs human review. Final visual acceptance remains separate.
