# Grid Strategy (working title)

A small-scale, grid-based multiplayer strategy war game. It takes cues from
the strategic layer of RTS games, but it is not a unit-by-unit real-time
simulation: armies are formations occupying grid tiles, not individually
simulated soldiers.

This is a Crit 8 vertical slice. Most of what's described below is where the
project is going, not what's built yet — the "Crit 8 scope" section describes
the intended target slice for Crit 8, not work that has already been
implemented.

## Who it's for

Small groups of players — a pair, a couple of pairs, maybe three teams of two
— who want a strategy match that rewards coordinating with each other, not
just playing alongside each other. Teams are made of multiple countries
rather than one country per team, which only works if the players on a team
actually coordinate. No in-game communication mechanism has been decided yet.

## What players do

Each player controls one country: its headquarters, its buildings, its
resources, its research, its armies, its territory. Players place buildings,
produce resources, build up armies, and move those armies as formations on a
shared grid. Decisions play out over a persistent, ongoing match rather than
a single short real-time skirmish.

## Why multiplayer/co-presence matters here

The team structure — multiple countries, one shared win/loss outcome — is the
point of the game, not a mode bolted onto a single-player design. Teammates
can see each other's armies exactly, which is deliberate: it removes
uncertainty inside a team so the coordination problem is about deciding what
to do together, not about guessing what a teammate has. The difficulty is
meant to come from the players, not from the game hiding information within
a team.

## What "good" means for this game

A good match is one where:

- meaningful strategic benefit comes from dividing responsibility (who builds
  what, who defends what, who watches which front) among teammates, rather
  than from any one player trying to do everything alone
- economic, research and military decisions on one side of the map have
  visible consequences for teammates elsewhere
- information sharing is necessary — allies can see the full picture, but
  someone has to notice and act on what they see
- the strategic layer (economy, research, territory, formation movement)
  carries the game, rather than micromanagement of individual units

This is a design goal, not a measured outcome. Nothing here claims the game
has been shown to teach or improve any of these skills, only that the rules
are built to require and exercise them during play.

## Grid formations instead of per-unit RTS simulation

Armies are represented as formations occupying tiles on a grid, not as
individually simulated units. This is a deliberate scope decision: a
strategic layer where a handful of formations matter more than unit-level
micromanagement is more playable at a team-strategy scale, and it keeps the
server-authoritative simulation tractable. Formation mechanics such as
splitting, merging, tile capacity and retreat are part of the intended
direction but are not implemented in Crit 8 (see below).

## Lobby: consent-based match configuration

Before a match starts, a host can propose and change match settings, but the
host has no special power beyond that configuration role — once the match
starts, the host doesn't own the campaign and gets no extra gameplay
authority. The rule that matters more than who holds the host role is
consent: any settings change clears existing approvals, and a match can only
become ready once every current player has approved the current settings. If
someone rejects, the match stays in configuration. If someone leaves before
the match starts, approval is recalculated for whoever remains. Once a match
starts, its approved settings are locked in.

## Persistence

A match's world — its grid, buildings, resources, armies, territory — belongs
to the campaign, not to any one player or to the host. If a player leaves an
ongoing campaign, their country's state stays in the world rather than
disappearing; a replacement-player system to let someone else take over a
vacant country, with teammate approval, is planned but not part of this
slice. Time-based resource production and already-issued orders are meant to
keep advancing on the server while players are offline, since the server is
the authority on game state and time, not the browser.

## Crit 8 scope

Crit 8 is a proof-of-life vertical slice, not the finished game. The target
for this stage is:

1. create or enter a campaign/lobby
2. at least two users can participate
3. assign players to symmetric opposing teams/countries
4. the host can configure a minimal set of match settings
5. every current player approves those settings
6. the match starts only once approval is unanimous
7. approved match settings become immutable
8. a small grid world is created
9. each side starts with a headquarters
10. a player can construct at least one resource-producing building
11. resource production advances on the 10-second game rule
12. match/world/building/resource state persists
13. a player who leaves and returns can find the campaign and its state intact

Only symmetric team configurations (e.g. 1v1, 2v2, 3v3, possibly 2v2v2) are
in scope for this stage, and not all of them are guaranteed to be implemented
immediately.

## Non-goals and deferred work (not Crit 8)

Explicitly out of scope for Crit 8:

- asymmetric team sizes (e.g. 2v1)
- full combat resolution
- army split/merge
- retreat mechanics
- replacement players taking over a vacant country
- a full fog-of-war/intelligence system
- large technology trees
- multiple victory conditions beyond headquarters destruction
- polished battle animation
- the final real-time synchronization layer (planned for later, particularly
  Crit 9)

Combat, when it arrives, is intended to be server-authoritative with limited
randomness, and enemy information is intended to eventually be filtered
server-side rather than merely hidden in the client UI — but the exact
mechanics, thresholds and formulas for both are not decided yet, and nothing
here should be read as a commitment to specific numbers or algorithms.
