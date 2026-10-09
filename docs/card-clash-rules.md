# Card Clash v2.5 — Frozen Game Rules

**Status:** Frozen specification for the D0 rebuild. Documentation only — no
gameplay is implemented against this spec yet. This document is the
authoritative rule source for all later Card Clash implementation slices;
later slices clarify ambiguities by amending this file, not by inventing
behavior in code.

Card Clash is an original 2–4 player, turn-based, server-authoritative
card combat game. It replaces the cancelled Texas Hold'em Poker Lab product
and the earlier strategy-war game. No poker, betting, blind, pot, or
gambling concept carries over.

## 1. Modes, seats, and starting state

| Mode | Seats | Teams | Starting HP | Draw/turn | Normal Attacks/turn |
|---|---|---|---|---|---|
| 1v1 | 1, 2 | 1 vs 1 | 3/3 each | 2 (both) | 1 (both) |
| 1v2 | 1 (host), 2, 3 | host vs {2,3} | host 5/5; seats 2–3 3/3 | host 3; seats 2–3 each 2 | host 2; seats 2–3 each 1 |
| 2v2 | 1, 2, 3, 4 | {1,4} vs {2,3} | 3/3 each | 2 (normal), see below | 1 (all) |

Seat order is fixed and clockwise: 1 → 2 → 3 → 4 → 1. Eliminated seats are
skipped when advancing turn order. The host always occupies seat 1 and acts
first.

**2v2 initial-hand exception:** seat 1 draws only **one** card on their
first turn; seat 4 starts with **five** hand cards instead of four. Every
other seat/mode starts with four cards. All subsequent normal draw phases
draw two cards regardless of mode (host in 1v2 draws three every turn,
including their first).

A team wins when every opposing-team player has been eliminated. An
eliminated player's team result (win or loss) is shared with their
surviving teammates once the match ends.

## 2. Cards

Exactly 64 cards per generated deck:

| Card | Count | Effect |
|---|---:|---|
| Attack | 24 | Target any other living player. They must respond with Dodge or lose 1 HP. |
| Dodge | 14 | Response to Attack or Arrow Volley. |
| Heal | 6 | Restore 1 HP, not exceeding maximum. Proactive use only targets self (see §3). |
| Seize | 5 | Randomly transfer one target player's hand card into the user's hand. |
| Disarm | 5 | Randomly discard one target player's hand card (revealed — see §6). |
| War Cry | 2 | All other living players must respond with Attack or lose 1 HP. Does not consume a normal Attack allowance. |
| Arrow Volley | 2 | All other living players must respond with Dodge or lose 1 HP. |
| Insight | 6 | Draw 2 additional cards. |

Targeting rules:
- A normal Attack can never target the attacker themself.
- Attack, Seize, and Disarm **can** target teammates.
- Area-effect cards (War Cry, Arrow Volley) affect **all** other living
  players, including teammates.
- A card used defensively (e.g. Dodge in response to Attack) never
  triggers its own proactive effect, and does not consume the responding
  player's own future turn's action allowance.

## 3. Turn structure

1. Draw phase (counts per §1/§6).
2. Active card-playing phase — the active player may play any number of
   proactive cards; there is **no** overall cap on proactive plays per turn,
   only the per-turn normal-Attack limit in the table below.
3. Defensive response interruptions, resolved as they arise (see §4).
4. End-of-turn discard: discard down to a hand size at most equal to
   **current** HP (not maximum HP — see §5).
5. Advance to the next living seat, clockwise.

Normal Attack limits per turn:

| Mode / seat | Limit |
|---|---:|
| 1v1, both seats | 1 |
| 2v2, all seats | 1 |
| 1v2 host (seat 1) | 2 |
| 1v2 seats 2–3 | 1 |

War Cry and Arrow Volley are separate from this limit. Heal may be played
proactively on the active player themself when below maximum HP; healing
another player proactively is not possible — the only path to healing
someone else is the dying rescue protocol (§4).

## 4. Dying and rescue protocol

Triggered the instant any player's HP reaches zero, from any source
(normal Attack, War Cry/Arrow Volley non-response, Disarm/Seize never
reduce HP so never trigger this):

1. Suspend resolution of the effect currently in progress.
2. Mark the player DYING (a persistent state, not instantaneous).
3. Starting with the nearest **living** player counterclockwise from the
   dying player, sequentially ask every **other** living player — allies
   and enemies alike — whether they wish to play Heal on the dying player.
   Only the player currently being asked may respond; no one may act with
   another player's Heal or Dodge on their behalf.
4. The first successful Heal restores 1 HP and ends the rescue window
   immediately — no further players are asked.
5. If every other living player declines, the dying player is asked
   **last** whether to self-heal.
6. If nobody heals them (including the dying player's own decline or
   lack of a Heal card), the player is eliminated.
7. Resume the suspended effect resolution, if the match is still active
   (the dying player's elimination may itself end the match — see §7).

**Multi-target area effects:** when War Cry/Arrow Volley brings multiple
players to 0 HP in the same resolution, process each dying player's full
rescue window **one at a time, in seat order**, before moving to the next
dying player. Do not interleave rescue windows, and do not implement
nested counterspell-style chains (a Heal played during a rescue window is
never itself interruptible).

## 5. Hand size and discard

- Starting hands: four cards for every seat except 2v2 seat 4 (five) —
  see §1.
- End-of-turn hand limit equals the active player's **current** HP, not
  their maximum HP.
- Damage taken on another player's turn does **not** immediately force a
  discard; the limit is only enforced at the end of the damaged player's
  own next turn (step 4 of §3).

## 6. Deck replenishment

- The server generates and cryptographically shuffles a fresh 64-card deck
  at match start.
- When the draw pile is exhausted mid-match, the server generates and
  shuffles a **completely new** 64-card deck — the existing discard pile
  is never recycled into the new draw pile.
- No limit on how many times replenishment can occur in one match.
- A single draw request that would cross the exhausted-deck boundary
  (e.g. Insight drawing 2 when only 1 card remains) must complete
  correctly: draw what remains, replenish, then draw the rest from the
  new deck, as one atomic draw.

## 7. Public information and privacy

Every successfully played card — proactive or defensive/responsive — is
immediately revealed to all participants and spectators: actor, card type,
and any targeted player(s).

Never disclosed to anyone except the owner:
- The contents of any player's unplayed hand.
- The current draw-deck's card order.
- A card at the moment it is privately drawn.
- **Which specific card** was taken via Seize (the event is public —
  "Seat 2 Seized from Seat 3" — but the card identity is private to the
  two players involved).

Disarm is the one exception to hidden-discard: a card discarded via Disarm
becomes publicly visible in the discard history (its identity is revealed
as part of the public event).

Eliminated players become read-only spectators: they see the public event
log and board state, never any surviving player's private hand.

All randomness (shuffles, Seize/Disarm target-card selection), state
transitions, target validation, and card effect resolution are
server-authoritative. No client ever computes or asserts a game outcome.

## 8. Architecture

- **Pure rule engine** (new `card-clash/` module, mirroring the existing
  `poker/` module's pattern): deck/card primitives, turn-state and
  pending-response-state types, and a single `applyAction` entry point
  that validates and resolves one action against an authoritative state
  snapshot. No HTTP, no SQLite, no randomness source baked in (injectable,
  as `poker/deck.ts` already demonstrates) — this makes it unit-testable
  without a database, exactly like the poker engine was.
- **Server-authoritative validation**: every action (play a card, respond,
  heal-or-decline during a rescue window) is re-validated against the
  current persisted state inside the transaction that applies it — never
  trusted from client-declared state, matching this project's existing
  `submitBettingAction` discipline.
- **Turn state and pending-response state** are distinct: "whose normal
  turn is it" and "who is currently being asked to respond to something"
  (a Dodge/Attack response, or a rescue-window Heal-or-decline) are
  different state machines that can be suspended/resumed independently —
  see §4's suspend/resume requirement.
- **Deterministic area-effect ordering**: both response collection and
  rescue-window processing for a multi-target effect proceed in a fixed,
  reproducible seat-order traversal (never Promise.all/unordered), so a
  replay or an audit can always reconstruct exactly what happened.
- **Interrupted action / rescue resumption**: the engine must represent
  "an effect is suspended pending a rescue outcome" as explicit state (not
  a call-stack-only suspension), so it survives a server restart — the
  same reason this project's poker hands are always re-derived from
  persisted JSON state rather than in-memory objects.
- **Card/deck ownership and hidden information**: mirrors `poker/`'s
  existing hole-card privacy pattern — a player's hand is a privacy-scoped
  query, never embedded in any payload a different identity could read.
- **SQLite transaction and persistence requirements**: one `BEGIN
  IMMEDIATE`/`COMMIT` per action, exactly like `submitBettingAction` —
  state is re-derived fresh from the database inside the transaction, not
  trusted from a prior in-memory read.
- **Match-version checking and idempotent actions**: reuse the existing
  `expected_version`/`request_id` content-aware idempotency contract
  (`poker_actions`'s `UNIQUE(hand_id, request_id)` pattern) rather than
  inventing a new mechanism.
- **Room creation and seat assignment**: 2–4 immutable seats assigned at
  join time, matching the existing `poker_seats` UNIQUE(table_id,
  seat_number)/UNIQUE(table_id, identity_id) pattern, generalized from 2
  seats to 2–4.
- **Disconnect/reconnect during a pending response**: see the explicit
  **proposed, not approved** policy below — this is the one area the
  human specification left open.
- **End-of-match checking**: evaluated after every elimination (including
  one caused by a declined rescue), not just at explicit "end turn."
- **Deck exhaustion across draw boundaries**: see §6's atomicity
  requirement.

### Proposed (unapproved) disconnect/reconnect policy

Not a frozen game rule — flagged explicitly as a proposal requiring human
sign-off before implementation, per the task's instruction not to silently
invent a timeout:

- A disconnected player's pending response (Dodge/Attack/Heal-or-decline)
  is **not** auto-resolved on any fixed timeout in v2.5 scope; the match
  waits indefinitely, consistent with this project's existing "server is
  authoritative for game state and time progression" principle and the
  absence of a human-approved timeout value.
- A reconnecting client re-fetches full authoritative state (own hand,
  public log, pending-response target) rather than assuming any
  client-side cached state — matching the existing poker `/live`
  fragment's re-fetch-on-reconnect behavior.
- If a timeout is later wanted (e.g. for abandoned matches), it must be
  proposed and approved as its own rule change to this document, not
  inferred from this architecture section.

## 9. Minimal vertical-slice implementation sequence

1. Pure rule engine (deck/cards/turn-state/action validation, no I/O).
2. Card effects and the dying/rescue protocol, fully covered by engine-only
   unit tests (no HTTP/SQLite yet) — mirrors how `poker/betting.ts` and
   `poker/settlement.ts` were built and audited before any persistence
   layer touched them.
3. Persistent lobby/API: room creation, 2–4 seat assignment, action
   submission routes, SQLite schema (additive migration, following the
   existing `poker_tables`/`poker_seats` precedent).
4. Real-time UI: server-rendered table view + SSE, reusing the existing
   content-free `publish`/`subscribe` hub and live-fragment-refresh
   pattern unchanged.
5. 2–4 player verification: all three modes (1v1, 1v2, 2v2) played to
   completion through the real HTTP routes, including at least one
   deck-exhaustion replenishment and one multi-target rescue window.

## 10. Explicitly out of scope for v2.5

No burgers, hunger, chips, betting, blinds, pots, poker hands, or any
gambling-adjacent mechanic. No real money. No more than 4 seats.
