// Minimal, explicit card representation for the poker rules engine. A card
// is plain data; every function here is a pure function over that data.
// Nothing in this module depends on HTTP, SQLite, SSE, or the browser.

export type Suit = "clubs" | "diamonds" | "hearts" | "spades";

// 11 = Jack, 12 = Queen, 13 = King, 14 = Ace. Ace is always represented as
// 14 (high) — there is no second, low-valued representation. The one place
// an Ace counts low (the A-2-3-4-5 straight, the "wheel") is handled as a
// named special case inside the evaluator, not by changing how a card
// itself is represented.
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  readonly rank: Rank;
  readonly suit: Suit;
}

export const SUITS: readonly Suit[] = ["clubs", "diamonds", "hearts", "spades"];
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

// A stable, unambiguous identity for a card, used to detect duplicates: two
// Card values with the same rank and suit always produce the same key,
// regardless of how or where they were constructed.
export function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`;
}

export function isValidRank(value: unknown): value is Rank {
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 14;
}

export function isValidSuit(value: unknown): value is Suit {
  return typeof value === "string" && (SUITS as readonly string[]).includes(value);
}

export function isValidCard(value: unknown): value is Card {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { rank?: unknown; suit?: unknown };
  return isValidRank(candidate.rank) && isValidSuit(candidate.suit);
}

// Throws with a specific, descriptive reason on the first problem found,
// rather than silently producing a plausible-looking hand from malformed
// input. Evaluators call this once, at their own boundary — evaluateSevenCardHand
// validates its 7 input cards exactly once, not on each of its 21 five-card
// subsets, since a validated 7-card hand can only ever produce valid,
// duplicate-free 5-card subsets of itself.
export function assertValidCards(cards: readonly unknown[], expectedCount: number): asserts cards is Card[] {
  if (cards.length !== expectedCount) {
    throw new Error(`expected exactly ${expectedCount} cards, got ${cards.length}`);
  }
  const seen = new Set<string>();
  for (const [index, card] of cards.entries()) {
    if (!isValidCard(card)) {
      throw new Error(`card at index ${index} is not a valid card: ${JSON.stringify(card)}`);
    }
    const key = cardKey(card);
    if (seen.has(key)) {
      throw new Error(`duplicate card: ${key}`);
    }
    seen.add(key);
  }
}
