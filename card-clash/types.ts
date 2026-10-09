// Match/turn state types for Card Clash. Pure data only — no behavior lives
// here; see engine.ts for the state-transition functions that produce and
// consume these shapes. See docs/card-clash-rules.md §1 for the frozen
// mode/seat/team/HP table this module must stay faithful to.

import type { Card, CardType } from "./cards.ts";

export type GameMode = "1v1" | "1v2" | "2v2";
export type Seat = 1 | 2 | 3 | 4;
export type Team = "A" | "B";

export interface PlayerState {
  readonly seat: Seat;
  readonly team: Team;
  readonly maxHp: number;
  readonly hp: number;
  // No elimination/combat logic exists yet (D1A scope) — this field exists
  // so turn advancement already has a stable, future-proof signal to skip
  // on, per docs/card-clash-rules.md §1's "eliminated seats are skipped".
  // Nothing in this slice ever sets it true.
  readonly eliminated: boolean;
  readonly hand: readonly Card[];
  // Consumed (flips to true) the first time this seat's own turn-start
  // draw phase runs — see engine.ts's drawCountForSeat, which is the only
  // place this flag changes meaning.
  readonly hasTakenFirstTurn: boolean;
}

// A single-target Attack awaiting the target's Dodge-or-decline response
// (docs/card-clash-rules.md §2 D1B scope), or a dying-rescue sequence in
// progress for one dying seat (§4). While either is set, MAIN-phase actions
// (playAttack/playHeal/discardCards/endTurn) are all rejected — only the
// specific action this pending state calls for may be submitted, and only
// by the one seat named as the current responder.
export type PendingResponse =
  | { readonly kind: "attack_response"; readonly attacker: Seat; readonly target: Seat }
  | {
      readonly kind: "dying_rescue";
      readonly dyingSeat: Seat;
      // Seats still to be asked, in order, with `dyingSeat` always last
      // (docs §4) — queue[0] is whoever must respond right now.
      readonly queue: readonly Seat[];
      // Whose MAIN-phase turn resumes once this rescue concludes (success
      // or elimination), provided the match isn't over — always the seat
      // whose Attack originally caused this rescue.
      readonly resumeActiveSeat: Seat;
    };

export type MatchResult =
  | { readonly status: "ongoing" }
  | { readonly status: "complete"; readonly winningTeam: Team };

// The smallest typed public-event record needed for D1B (docs §6): every
// successfully played Attack/Dodge/Heal, every declined response, every
// elimination, and match completion. Deliberately carries no hand contents
// or draw-pile order — only actor/target/outcome, which is all that is
// ever meant to be public.
export type PublicEvent =
  | { readonly type: "attack_played"; readonly actor: Seat; readonly target: Seat }
  | { readonly type: "dodge_played"; readonly actor: Seat }
  | { readonly type: "attack_response_declined"; readonly actor: Seat }
  | { readonly type: "heal_played"; readonly actor: Seat; readonly target: Seat }
  | { readonly type: "rescue_declined"; readonly actor: Seat }
  | { readonly type: "eliminated"; readonly seat: Seat }
  | { readonly type: "match_complete"; readonly winningTeam: Team }
  // D2A: Seize/Disarm never reveal which card moved — only Disarm's own
  // rule (docs/card-clash-rules.md §3 "Disarm") makes the discarded card's
  // type public, as its own separate `disarm_card_revealed` event.
  | { readonly type: "seize_played"; readonly actor: Seat; readonly target: Seat }
  | { readonly type: "disarm_played"; readonly actor: Seat; readonly target: Seat }
  | { readonly type: "disarm_card_revealed"; readonly target: Seat; readonly cardType: CardType }
  | { readonly type: "insight_played"; readonly actor: Seat; readonly cardsDrawn: number };

export interface MatchState {
  readonly mode: GameMode;
  // Keyed by seat; only the seats this mode actually uses are present
  // (docs/card-clash-rules.md §1 — e.g. 1v1 has no seat 3 or 4 entry).
  readonly players: ReadonlyMap<Seat, PlayerState>;
  readonly activeSeat: Seat;
  readonly drawPile: readonly Card[];
  // Publicly-visible discards only (docs/card-clash-rules.md §7/§9) — never
  // recycled into a replenished draw pile (§6).
  readonly discardPile: readonly Card[];
  // Incremented every time drawing exhausts the pile and a brand-new deck
  // is generated — see deck.ts's shuffleNewDeck for why this must never
  // repeat within one match (card id uniqueness across replenishments).
  readonly deckGeneration: number;
  // Monotonic, incremented on every successful transition (D1A's and
  // D1B's alike) — never on a rejected one. Callers that want optimistic
  // concurrency (an `expectedVersion` check) can read this back; D1B's new
  // combat/response/rescue actions enforce it, matching this project's
  // existing poker-engine convention.
  readonly version: number;
  // How many normal Attacks the CURRENT active seat has played so far this
  // turn — reset to 0 every time a new seat's turn begins (engine.ts's
  // beginTurnDraw). Only ever meaningful for the current activeSeat.
  readonly normalAttacksUsedThisTurn: number;
  readonly pending: PendingResponse | undefined;
  readonly matchResult: MatchResult;
  readonly publicLog: readonly PublicEvent[];
}
