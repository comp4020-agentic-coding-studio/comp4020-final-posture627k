import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertValidCards, cardKey, type Card, RANKS, SUITS } from "../poker/cards.ts";
import { createDeck, shuffleDeck } from "../poker/deck.ts";
import {
  compareHands,
  evaluateFiveCardHand,
  evaluateSevenCardHand,
  fiveCardCombinations,
  HAND_CATEGORY,
} from "../poker/hand-evaluator.ts";

// Shorthand for building fixtures concisely and legibly below.
function c(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

// --- Deck -------------------------------------------------------------------

describe("deck", () => {
  it("has exactly 52 unique cards", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(cardKey)).size).toBe(52);
  });

  it("has four suits and thirteen ranks, each fully represented", () => {
    const deck = createDeck();
    for (const suit of SUITS) {
      expect(deck.filter((card) => card.suit === suit)).toHaveLength(13);
    }
    for (const rank of RANKS) {
      expect(deck.filter((card) => card.rank === rank)).toHaveLength(4);
    }
  });

  it("source uses cryptographically secure randomness, never Math.random()", () => {
    // A direct behavioural assertion on `Math.random()` usage would be
    // fragile to mock reliably; checking the actual module source is a
    // precise, non-flaky way to enforce that production shuffling never
    // falls back to it and always comes from node:crypto.
    const source = readFileSync(new URL("../poker/deck.ts", import.meta.url), "utf8");
    expect(source).toContain('from "node:crypto"');
    expect(source).not.toContain("Math.random(");
  });

  it("a secure shuffle produces a valid permutation: same 52 cards, no duplication or omission", () => {
    const deck = createDeck();
    const shuffled = shuffleDeck(deck);
    expect(shuffled).toHaveLength(52);
    expect([...shuffled].map(cardKey).sort()).toEqual([...deck].map(cardKey).sort());
  });

  it("shuffling does not mutate the input deck", () => {
    const deck = createDeck();
    const before = deck.map(cardKey);
    shuffleDeck(deck);
    expect(deck.map(cardKey)).toEqual(before);
  });

  it("the Fisher-Yates swap mechanics are correct, verified with an injected deterministic source", () => {
    // Not a statistical/bias test (explicitly avoided per the brief) — this
    // verifies the swap logic itself against a hand-traced expected result.
    // A four-card deck [c0, c1, c2, c3] with randomUpTo always returning 0
    // traces to: swap(3,0) -> [c3,c1,c2,c0]; swap(2,0) -> [c2,c1,c3,c0];
    // swap(1,0) -> [c1,c2,c3,c0].
    const miniDeck: Card[] = [c(2, "clubs"), c(3, "clubs"), c(4, "clubs"), c(5, "clubs")];
    const alwaysZero = () => 0;
    const result = shuffleDeck(miniDeck, alwaysZero);
    expect(result).toEqual([c(3, "clubs"), c(4, "clubs"), c(5, "clubs"), c(2, "clubs")]);
  });
});

// --- Five-card hand ranking, strongest to weakest ---------------------------

describe("five-card hand categories", () => {
  it("recognizes a straight flush", () => {
    const hand = evaluateFiveCardHand([c(5, "hearts"), c(6, "hearts"), c(7, "hearts"), c(8, "hearts"), c(9, "hearts")]);
    expect(hand.category).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
  });

  it("recognizes four of a kind", () => {
    const hand = evaluateFiveCardHand([c(9, "clubs"), c(9, "diamonds"), c(9, "hearts"), c(9, "spades"), c(2, "clubs")]);
    expect(hand.category).toBe(HAND_CATEGORY.FOUR_OF_A_KIND);
  });

  it("recognizes a full house", () => {
    const hand = evaluateFiveCardHand([c(8, "clubs"), c(8, "diamonds"), c(8, "hearts"), c(3, "spades"), c(3, "clubs")]);
    expect(hand.category).toBe(HAND_CATEGORY.FULL_HOUSE);
  });

  it("recognizes a flush", () => {
    const hand = evaluateFiveCardHand([c(2, "spades"), c(5, "spades"), c(9, "spades"), c(11, "spades"), c(13, "spades")]);
    expect(hand.category).toBe(HAND_CATEGORY.FLUSH);
  });

  it("recognizes a straight", () => {
    const hand = evaluateFiveCardHand([c(4, "clubs"), c(5, "diamonds"), c(6, "hearts"), c(7, "spades"), c(8, "clubs")]);
    expect(hand.category).toBe(HAND_CATEGORY.STRAIGHT);
  });

  it("recognizes three of a kind", () => {
    const hand = evaluateFiveCardHand([c(6, "clubs"), c(6, "diamonds"), c(6, "hearts"), c(2, "spades"), c(9, "clubs")]);
    expect(hand.category).toBe(HAND_CATEGORY.THREE_OF_A_KIND);
  });

  it("recognizes two pair", () => {
    const hand = evaluateFiveCardHand([c(10, "clubs"), c(10, "diamonds"), c(4, "hearts"), c(4, "spades"), c(2, "clubs")]);
    expect(hand.category).toBe(HAND_CATEGORY.TWO_PAIR);
  });

  it("recognizes one pair", () => {
    const hand = evaluateFiveCardHand([c(13, "clubs"), c(13, "diamonds"), c(2, "hearts"), c(5, "spades"), c(9, "clubs")]);
    expect(hand.category).toBe(HAND_CATEGORY.ONE_PAIR);
  });

  it("recognizes high card", () => {
    const hand = evaluateFiveCardHand([c(2, "clubs"), c(5, "diamonds"), c(9, "hearts"), c(11, "spades"), c(13, "clubs")]);
    expect(hand.category).toBe(HAND_CATEGORY.HIGH_CARD);
  });
});

// --- Edge cases --------------------------------------------------------------

describe("hand evaluation edge cases", () => {
  it("1. recognizes an ace-high straight", () => {
    const hand = evaluateFiveCardHand([c(10, "clubs"), c(11, "diamonds"), c(12, "hearts"), c(13, "spades"), c(14, "clubs")]);
    expect(hand.category).toBe(HAND_CATEGORY.STRAIGHT);
    expect(hand.tiebreakers).toEqual([14]);
  });

  it("2. recognizes an ace-low straight (A-2-3-4-5, the wheel)", () => {
    const hand = evaluateFiveCardHand([c(14, "clubs"), c(2, "diamonds"), c(3, "hearts"), c(4, "spades"), c(5, "clubs")]);
    expect(hand.category).toBe(HAND_CATEGORY.STRAIGHT);
    expect(hand.tiebreakers).toEqual([5]); // 5-high, not ace-high
  });

  it("3. a six-high straight beats a five-high (wheel) straight", () => {
    const sixHigh = evaluateFiveCardHand([c(2, "clubs"), c(3, "diamonds"), c(4, "hearts"), c(5, "spades"), c(6, "clubs")]);
    const wheel = evaluateFiveCardHand([c(14, "clubs"), c(2, "diamonds"), c(3, "hearts"), c(4, "spades"), c(5, "clubs")]);
    expect(compareHands(sixHigh, wheel)).toBeGreaterThan(0);
  });

  it("4. a Royal Flush is represented as an ace-high Straight Flush, not a separate category", () => {
    const hand = evaluateFiveCardHand([c(10, "spades"), c(11, "spades"), c(12, "spades"), c(13, "spades"), c(14, "spades")]);
    expect(hand.category).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
    expect(hand.tiebreakers).toEqual([14]);
  });

  it("5. full house comparison uses the triplet rank first", () => {
    const kingsFullOfTwos = evaluateFiveCardHand([c(13, "clubs"), c(13, "diamonds"), c(13, "hearts"), c(2, "spades"), c(2, "clubs")]);
    const queensFullOfAces = evaluateFiveCardHand([c(12, "clubs"), c(12, "diamonds"), c(12, "hearts"), c(14, "spades"), c(14, "clubs")]);
    expect(compareHands(kingsFullOfTwos, queensFullOfAces)).toBeGreaterThan(0);
  });

  it("6. two pair comparison uses the higher pair, then the lower pair, then the kicker", () => {
    const acesAndKings = evaluateFiveCardHand([c(14, "clubs"), c(14, "diamonds"), c(13, "hearts"), c(13, "spades"), c(12, "clubs")]);
    const acesAndQueens = evaluateFiveCardHand([c(14, "hearts"), c(14, "spades"), c(12, "diamonds"), c(12, "hearts"), c(13, "diamonds")]);
    // Same higher pair (aces); the lower pair (kings vs queens) decides.
    expect(compareHands(acesAndKings, acesAndQueens)).toBeGreaterThan(0);
  });

  it("7. one pair comparison uses the remaining kickers in order", () => {
    const sevensWithQueenKicker = evaluateFiveCardHand([c(7, "clubs"), c(7, "diamonds"), c(14, "hearts"), c(13, "spades"), c(12, "clubs")]);
    const sevensWithJackKicker = evaluateFiveCardHand([c(7, "hearts"), c(7, "spades"), c(14, "clubs"), c(13, "diamonds"), c(11, "hearts")]);
    // Same pair, same top two kickers (A, K); the third kicker (Q vs J) decides.
    expect(compareHands(sevensWithQueenKicker, sevensWithJackKicker)).toBeGreaterThan(0);
  });

  it("8. flush comparison uses all five ranked cards", () => {
    const higherFlush = evaluateFiveCardHand([c(14, "clubs"), c(13, "clubs"), c(12, "clubs"), c(11, "clubs"), c(9, "clubs")]);
    const lowerFlush = evaluateFiveCardHand([c(14, "hearts"), c(13, "hearts"), c(12, "hearts"), c(11, "hearts"), c(8, "hearts")]);
    expect(compareHands(higherFlush, lowerFlush)).toBeGreaterThan(0);
  });

  it("9. equal-ranked hands of different suits tie", () => {
    const hand1 = evaluateFiveCardHand([c(13, "clubs"), c(12, "diamonds"), c(11, "hearts"), c(9, "spades"), c(7, "clubs")]);
    const hand2 = evaluateFiveCardHand([c(13, "hearts"), c(12, "spades"), c(11, "clubs"), c(9, "diamonds"), c(7, "hearts")]);
    expect(compareHands(hand1, hand2)).toBe(0);
  });

  it("10. both players play the five-card board and tie", () => {
    // A board strong enough that neither player's hole cards improve on it,
    // and the hole cards themselves share no rank with the board or with
    // each other's winning five.
    const board: Card[] = [c(14, "spades"), c(13, "spades"), c(12, "spades"), c(11, "spades"), c(10, "spades")]; // royal flush on the board
    const playerA = evaluateSevenCardHand([...board, c(2, "clubs"), c(3, "diamonds")]);
    const playerB = evaluateSevenCardHand([...board, c(4, "hearts"), c(5, "clubs")]);
    expect(compareHands(playerA, playerB)).toBe(0);
    expect(playerA.category).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
    expect([...playerA.bestFive].map(cardKey).sort()).toEqual([...playerB.bestFive].map(cardKey).sort());
  });

  it("11. seven cards containing multiple possible straights select the strongest", () => {
    const sevenCardRun: Card[] = [
      c(3, "clubs"),
      c(4, "diamonds"),
      c(5, "hearts"),
      c(6, "spades"),
      c(7, "clubs"),
      c(8, "diamonds"),
      c(9, "hearts"),
    ];
    const hand = evaluateSevenCardHand(sevenCardRun);
    expect(hand.category).toBe(HAND_CATEGORY.STRAIGHT);
    expect(hand.tiebreakers).toEqual([9]); // 5-9 straight, not 3-7
  });

  it("12. seven cards containing two three-of-a-kind groups select the correct full house", () => {
    const twoTrips: Card[] = [
      c(14, "clubs"),
      c(14, "diamonds"),
      c(14, "hearts"),
      c(13, "clubs"),
      c(13, "diamonds"),
      c(13, "hearts"),
      c(2, "spades"),
    ];
    const hand = evaluateSevenCardHand(twoTrips);
    expect(hand.category).toBe(HAND_CATEGORY.FULL_HOUSE);
    // Aces full of kings, not kings full of aces: the higher trip leads.
    expect(hand.tiebreakers).toEqual([14, 13]);
  });

  it("13. seven-card evaluation correctly prefers a flush over a straight", () => {
    const flushAndStraight: Card[] = [
      c(2, "hearts"),
      c(4, "hearts"),
      c(6, "hearts"),
      c(8, "hearts"),
      c(10, "hearts"),
      c(5, "clubs"),
      c(7, "clubs"),
    ];
    // Contains a 4-5-6-7-8 straight (8-high) and a 2-4-6-8-10 flush (10-high).
    const hand = evaluateSevenCardHand(flushAndStraight);
    expect(hand.category).toBe(HAND_CATEGORY.FLUSH);
  });

  it("14. a duplicate input card is rejected", () => {
    expect(() =>
      evaluateFiveCardHand([c(5, "clubs"), c(5, "clubs"), c(9, "hearts"), c(11, "spades"), c(13, "clubs")]),
    ).toThrow(/duplicate card/);
  });

  it("15. evaluator results are independent of input-card order", () => {
    const ordered: Card[] = [c(8, "clubs"), c(8, "diamonds"), c(8, "hearts"), c(3, "spades"), c(3, "clubs")];
    const shuffled: Card[] = [c(3, "clubs"), c(8, "hearts"), c(3, "spades"), c(8, "clubs"), c(8, "diamonds")];
    const a = evaluateFiveCardHand(ordered);
    const b = evaluateFiveCardHand(shuffled);
    expect(a.category).toBe(b.category);
    expect(a.tiebreakers).toEqual(b.tiebreakers);
    expect(compareHands(a, b)).toBe(0);
  });
});

// --- Input validation ---------------------------------------------------------

describe("input validation", () => {
  it("rejects an incorrect card count for a five-card hand", () => {
    expect(() => evaluateFiveCardHand([c(2, "clubs"), c(3, "clubs")])).toThrow(/expected exactly 5/);
  });

  it("rejects an incorrect card count for a seven-card hand", () => {
    expect(() => evaluateSevenCardHand([c(2, "clubs"), c(3, "clubs")])).toThrow(/expected exactly 7/);
  });

  it("rejects an invalid rank", () => {
    expect(() => evaluateFiveCardHand([{ rank: 1, suit: "clubs" }, c(3, "clubs"), c(4, "clubs"), c(5, "clubs"), c(6, "clubs")])).toThrow(
      /not a valid card/,
    );
  });

  it("rejects an invalid suit", () => {
    expect(() =>
      evaluateFiveCardHand([{ rank: 2, suit: "stars" }, c(3, "clubs"), c(4, "clubs"), c(5, "clubs"), c(6, "clubs")]),
    ).toThrow(/not a valid card/);
  });

  it("assertValidCards accepts a well-formed hand silently", () => {
    const hand = [c(2, "clubs"), c(3, "diamonds"), c(4, "hearts"), c(5, "spades"), c(6, "clubs")];
    expect(() => assertValidCards(hand, 5)).not.toThrow();
  });
});

// --- Seven-card combination coverage -----------------------------------------

describe("seven-card combination coverage", () => {
  it("examines exactly 21 five-card subsets of 7 items, each one unique", () => {
    const sevenItems = [0, 1, 2, 3, 4, 5, 6];
    const combos = [...fiveCardCombinations(sevenItems)];
    expect(combos).toHaveLength(21); // C(7, 5) = 21

    const asKeys = combos.map((combo) => [...combo].sort((a, b) => a - b).join(","));
    expect(new Set(asKeys).size).toBe(21); // all 21 are distinct subsets

    for (const combo of combos) {
      expect(combo).toHaveLength(5);
      expect(new Set(combo).size).toBe(5); // every subset has 5 distinct elements
      for (const item of combo) expect(sevenItems).toContain(item);
    }
  });

  it("evaluateSevenCardHand actually exercises all 21 subsets, not a shortcut subset", () => {
    // Indirect but concrete: construct a 7-card hand whose single best
    // 5-card subset is a very specific, unlikely-to-be-found-by-accident
    // combination (a straight flush using cards scattered through the
    // input, not contiguous in input order), and confirm it's still found.
    const scattered: Card[] = [
      c(9, "hearts"), // part of the straight flush
      c(2, "clubs"), // noise
      c(10, "hearts"), // part of the straight flush
      c(5, "diamonds"), // noise
      c(11, "hearts"), // part of the straight flush
      c(12, "hearts"), // part of the straight flush
      c(13, "hearts"), // part of the straight flush
    ];
    const hand = evaluateSevenCardHand(scattered);
    expect(hand.category).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
    expect(hand.tiebreakers).toEqual([13]);
  });
});
