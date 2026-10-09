// Match/turn state types for Card Clash. Pure data only — no behavior lives
// here; see engine.ts for the state-transition functions that produce and
// consume these shapes. See docs/card-clash-rules.md §1 for the frozen
// mode/seat/team/HP table this module must stay faithful to.

import type { Card } from "./cards.ts";

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
}
