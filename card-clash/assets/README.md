# Card Clash artwork

The project author identifies this art as original AI-generated artwork for
Card Clash. The painted cards, hall, war table, knights and effects were
provided through the project's local art packs. The two transparent gauntlet
PNGs were supplied separately by the author and retain their original alpha
and proportions. The author remains responsible for this provenance account;
no third-party game-art attribution or historical licensing claim is implied.

Runtime WebP derivatives and the two gauntlet PNGs are versioned here so a
fresh Git checkout can reproduce the game. Original pack ZIPs, full-resolution
environment source PNGs and Windows download metadata remain local and are
excluded from Git and Docker contexts. Existing allowlisted pose URLs are
retained even where the current scene uses the dedicated gauntlets instead.

- `cards/`: eight card paintings.
- `environment/`: optimized castle-hall and war-table paintings.
- `characters/`: red/blue knight poses.
- `first-person/`: supplied gauntlets and retained pose derivatives.
- `effects/`, `ui/`: painted feedback and interface artwork.

The frozen engine rules determine outcomes. Artwork and combat effects are
presentation; the gauntlet layers do not intercept pointer input.
