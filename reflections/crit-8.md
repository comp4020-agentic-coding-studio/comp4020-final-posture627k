# Crit 8 reflection

**What was the breakthrough that moved the work forward?**

The project became tractable once I stopped trying to build "a multiplayer
strategy war game" directly and narrowed it to one provable vertical slice:
create a campaign, have a second person join, agree on settings together,
start a persistent world, build one resource building, let production
continue while offline, and recover the same state on return. That chain
preserved the actual design goal — coordination between real people over a
shared persistent state — without prematurely building armies, combat, fog
of war, or research, each of which carries its own large set of invariants
before the core loop even works. Fixing that boundary before writing any
code was what let implementation proceed as a sequence of small, verifiable
slices instead of stalling on an open-ended scope.

**What did this work change about who I want to be as a software developer?**

The suite reached 81/81 tests — covering authorization, concurrency, every
historical schema migration, and real container offline/restart behaviour —
and it was tempting to treat that as proof the work was finished. Real human
browser inspection still found problems the automated suite structurally
could not see: the interface read as raw default HTML, the game's own grid
was too small to be the visual focus, and a deployed invite URL had a mobile
wrapping risk. Combined with catching a real temporal-dead-zone migration
bug and a timing bug in my own test design along the way, this left a
concrete habit rather than a slogan: a green test suite is evidence of
behaviour, not evidence that a human can use or understand the result, so
the right response is to correct what's found rather than explain it away.
