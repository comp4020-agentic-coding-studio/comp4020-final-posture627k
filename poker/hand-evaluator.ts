import { assertValidCards, type Card, type Rank } from "./cards.ts";

// Higher number = stronger category, matching the standard ranking from
// weakest to strongest. A Royal Flush is not a separate category — it's an
// Ace-high Straight Flush, produced by the same STRAIGHT_FLUSH case below.
export const HAND_CATEGORY = {
  HIGH_CARD: 1,
  ONE_PAIR: 2,
  TWO_PAIR: 3,
  THREE_OF_A_KIND: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  STRAIGHT_FLUSH: 9,
} as const;

export type HandCategory = (typeof HAND_CATEGORY)[keyof typeof HAND_CATEGORY];

export const HAND_CATEGORY_NAME: Record<HandCategory, string> = {
  [HAND_CATEGORY.HIGH_CARD]: "High Card",
  [HAND_CATEGORY.ONE_PAIR]: "One Pair",
  [HAND_CATEGORY.TWO_PAIR]: "Two Pair",
  [HAND_CATEGORY.THREE_OF_A_KIND]: "Three of a Kind",
  [HAND_CATEGORY.STRAIGHT]: "Straight",
  [HAND_CATEGORY.FLUSH]: "Flush",
  [HAND_CATEGORY.FULL_HOUSE]: "Full House",
  [HAND_CATEGORY.FOUR_OF_A_KIND]: "Four of a Kind",
  [HAND_CATEGORY.STRAIGHT_FLUSH]: "Straight Flush",
};

export interface HandResult {
  readonly category: HandCategory;
  readonly categoryName: string;
  // Lexicographically comparable: compare element by element, first
  // difference decides. Only ever meaningfully compared between two results
  // of the same category — compareHands() checks category first — so the
  // differing tiebreaker lengths across categories are never compared
  // against each other.
  readonly tiebreakers: readonly number[];
  readonly bestFive: readonly Card[];
}

function rankCounts(cards: readonly Card[]): Map<Rank, number> {
  const counts = new Map<Rank, number>();
  for (const card of cards) {
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  }
  return counts;
}

// The one straight whose comparable "high card" (5) is lower than its own
// highest-ranked card (Ace = 14) — handled as a specific, named case rather
// than by giving Ace a second, low-valued representation anywhere else in
// this module.
const WHEEL_RANKS: ReadonlySet<Rank> = new Set<Rank>([14, 5, 4, 3, 2]);

function straightHigh(uniqueRanksDesc: readonly Rank[]): Rank | undefined {
  if (uniqueRanksDesc.length !== 5) return undefined;
  if (uniqueRanksDesc[0]! - uniqueRanksDesc[4]! === 4) return uniqueRanksDesc[0];
  if (uniqueRanksDesc.every((r) => WHEEL_RANKS.has(r))) return 5; // the wheel: 5-high
  return undefined;
}

// Assumes `cards` is already exactly 5 valid, distinct cards. Callers that
// haven't already validated that must go through evaluateFiveCardHand
// instead, which does. Kept separate so evaluateSevenCardHand can call this
// directly for each of its 21 five-card subsets without re-validating an
// already-validated 7-card hand's own subsets 21 times over.
function scoreFiveCards(cards: readonly Card[]): HandResult {
  const ranksDesc = [...cards].map((c) => c.rank).sort((a, b) => b - a) as Rank[];
  const uniqueRanksDesc = [...new Set(ranksDesc)] as Rank[];
  const isFlush = cards.every((c) => c.suit === cards[0]!.suit);
  const straightTop = straightHigh(uniqueRanksDesc);

  const counts = rankCounts(cards);
  // Ranks grouped by how many of that rank are present, each group sorted
  // descending — e.g. for a full house, byCount.get(3) is the trip rank and
  // byCount.get(2) is the pair rank.
  const byCount = new Map<number, Rank[]>();
  for (const [rank, count] of counts) {
    const group = byCount.get(count) ?? [];
    group.push(rank);
    byCount.set(count, group);
  }
  for (const group of byCount.values()) group.sort((a, b) => b - a);

  const quads = byCount.get(4) ?? [];
  const trips = byCount.get(3) ?? [];
  const pairs = byCount.get(2) ?? [];
  const singles = byCount.get(1) ?? [];

  const bestFive = [...cards].sort((a, b) => b.rank - a.rank);
  const name = (category: HandCategory) => HAND_CATEGORY_NAME[category];

  if (straightTop !== undefined && isFlush) {
    return {
      category: HAND_CATEGORY.STRAIGHT_FLUSH,
      categoryName: name(HAND_CATEGORY.STRAIGHT_FLUSH),
      tiebreakers: [straightTop],
      bestFive,
    };
  }
  if (quads.length === 1) {
    return {
      category: HAND_CATEGORY.FOUR_OF_A_KIND,
      categoryName: name(HAND_CATEGORY.FOUR_OF_A_KIND),
      tiebreakers: [quads[0]!, singles[0]!],
      bestFive,
    };
  }
  if (trips.length === 1 && pairs.length === 1) {
    return {
      category: HAND_CATEGORY.FULL_HOUSE,
      categoryName: name(HAND_CATEGORY.FULL_HOUSE),
      tiebreakers: [trips[0]!, pairs[0]!],
      bestFive,
    };
  }
  if (isFlush) {
    return {
      category: HAND_CATEGORY.FLUSH,
      categoryName: name(HAND_CATEGORY.FLUSH),
      tiebreakers: ranksDesc,
      bestFive,
    };
  }
  if (straightTop !== undefined) {
    return {
      category: HAND_CATEGORY.STRAIGHT,
      categoryName: name(HAND_CATEGORY.STRAIGHT),
      tiebreakers: [straightTop],
      bestFive,
    };
  }
  if (trips.length === 1) {
    return {
      category: HAND_CATEGORY.THREE_OF_A_KIND,
      categoryName: name(HAND_CATEGORY.THREE_OF_A_KIND),
      tiebreakers: [trips[0]!, ...singles],
      bestFive,
    };
  }
  if (pairs.length === 2) {
    return {
      category: HAND_CATEGORY.TWO_PAIR,
      categoryName: name(HAND_CATEGORY.TWO_PAIR),
      tiebreakers: [pairs[0]!, pairs[1]!, singles[0]!],
      bestFive,
    };
  }
  if (pairs.length === 1) {
    return {
      category: HAND_CATEGORY.ONE_PAIR,
      categoryName: name(HAND_CATEGORY.ONE_PAIR),
      tiebreakers: [pairs[0]!, ...singles],
      bestFive,
    };
  }
  return {
    category: HAND_CATEGORY.HIGH_CARD,
    categoryName: name(HAND_CATEGORY.HIGH_CARD),
    tiebreakers: ranksDesc,
    bestFive,
  };
}

export function evaluateFiveCardHand(cards: readonly unknown[]): HandResult {
  assertValidCards(cards, 5);
  return scoreFiveCards(cards);
}

// Yields every 5-element combination of `items`, in increasing index order,
// via the standard "revolving door" combination-index advance: find the
// rightmost index not yet at its maximum allowed value, bump it, and reset
// every index after it to run immediately afterward. For 7 items this
// yields exactly C(7, 5) = 21 combinations. Exported so its coverage can be
// tested directly (see spec/poker-rules.test.ts), independent of whether a
// particular hand's evaluation happens to expose a combination-count bug.
export function* fiveCardCombinations<T>(items: readonly T[]): Generator<T[]> {
  const n = items.length;
  const indices = [0, 1, 2, 3, 4];
  for (;;) {
    yield indices.map((i) => items[i]!);
    let i = 4;
    while (i >= 0 && indices[i] === i + (n - 5)) i--;
    if (i < 0) return;
    indices[i]!++;
    for (let j = i + 1; j < 5; j++) indices[j] = indices[j - 1]! + 1;
  }
}

// Given exactly 7 distinct cards, returns the strongest possible 5-card
// poker hand: every one of the 21 five-card subsets is evaluated and the
// strongest is returned, using the same comparator the rest of this module
// uses. For a two-player P0 game this exhaustive approach is small (21
// evaluations) and easy to audit; a lookup-table approach is not warranted
// at this scale.
export function evaluateSevenCardHand(cards: readonly unknown[]): HandResult {
  assertValidCards(cards, 7);
  let best: HandResult | undefined;
  for (const combo of fiveCardCombinations(cards)) {
    const result = scoreFiveCards(combo);
    if (!best || compareHands(result, best) > 0) best = result;
  }
  return best!;
}

// Positive: `a` wins. Negative: `b` wins. Zero: equal strength. Suits are
// never consulted — ties are resolved purely on category and rank, which is
// what makes two different players' hands correctly tie when, for example,
// both play the same five-card community board.
export function compareHands(a: HandResult, b: HandResult): number {
  if (a.category !== b.category) return a.category - b.category;
  const length = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < length; i++) {
    const diff = (a.tiebreakers[i] ?? 0) - (b.tiebreakers[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
