// Card primitives for Card Clash. Pure: no HTTP, no SQLite, no randomness.
// See docs/card-clash-rules.md §2 for the frozen card list/counts this
// module must never drift from.

export type CardType =
  | "attack"
  | "dodge"
  | "heal"
  | "seize"
  | "disarm"
  | "war_cry"
  | "arrow_volley"
  | "insight";

// A card's `id` is unique for the lifetime of a match, including across
// every deck a replenishment generates (see deck.ts's `generation` — the id
// embeds it so two cards from different generations can never collide, even
// though both decks independently number their cards 0..63).
export interface Card {
  readonly id: string;
  readonly type: CardType;
}

// The exact, frozen 64-card distribution (docs/card-clash-rules.md §2).
// A Readonly tuple list rather than a Record so CARD_DISTRIBUTION's own
// iteration order is fixed and deterministic (not dependent on object key
// enumeration order), which keeps deck generation reproducible for a given
// RNG sequence.
export const CARD_DISTRIBUTION: ReadonlyArray<readonly [CardType, number]> = [
  ["attack", 24],
  ["dodge", 14],
  ["heal", 6],
  ["seize", 5],
  ["disarm", 5],
  ["war_cry", 2],
  ["arrow_volley", 2],
  ["insight", 6],
];

export const DECK_SIZE = CARD_DISTRIBUTION.reduce((sum, [, count]) => sum + count, 0);

if (DECK_SIZE !== 64) {
  // Defensive: CARD_DISTRIBUTION is a hand-maintained literal; this catches
  // an arithmetic slip the moment the module loads rather than only once a
  // test happens to check the total.
  throw new Error(`card-clash CARD_DISTRIBUTION must total 64 cards, got ${DECK_SIZE}`);
}
