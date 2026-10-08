import { randomInt } from "node:crypto";
import { RANKS, SUITS, type Card } from "./cards.ts";

// A fresh, ordered 52-card deck: every rank paired with every suit, exactly
// once. Order is deterministic (suit-major) — callers that need a random
// order call shuffleDeck() on the result, separately, below.
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

// Fisher-Yates, cryptographically secure by default: node:crypto's
// randomInt, never the insecure Math random generator. The optional second
// parameter exists only so this module's own tests can inject a controlled
// integer source to verify the shuffle's swap mechanics deterministically
// (see spec/poker-rules.test.ts) — every real caller gets the secure
// default, and nothing in the application ever overrides it. Does not
// mutate the input array.
export function shuffleDeck(
  deck: readonly Card[],
  randomUpTo: (exclusiveMax: number) => number = randomInt,
): Card[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomUpTo(i + 1);
    const temp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = temp;
  }
  return shuffled;
}
