// Deck generation and shuffling for Card Clash. Mirrors poker/deck.ts's own
// established pattern in this repo: a cryptographically-secure default
// shuffle, with the random source injectable only so tests can supply a
// deterministic sequence — no real caller ever overrides it.

import { randomInt } from "node:crypto";
import { CARD_DISTRIBUTION, type Card } from "./cards.ts";

export type RandomInt = (max: number) => number; // uniform in [0, max)

export const defaultRandomInt: RandomInt = (max) => randomInt(max);

// Builds one fresh, unshuffled 64-card deck for deck `generation` (see
// shuffleNewDeck below for why the generation number is embedded in each
// card's id). Exported mainly for tests that want to assert on composition
// before shuffling.
export function createDeck(generation: number): Card[] {
  const deck: Card[] = [];
  let index = 0;
  for (const [type, count] of CARD_DISTRIBUTION) {
    for (let i = 0; i < count; i++) {
      deck.push({ id: `g${generation}-${index}`, type });
      index++;
    }
  }
  return deck;
}

// Fisher-Yates, using the injected uniform source — never Math.random.
export function shuffle(cards: readonly Card[], randomSource: RandomInt = defaultRandomInt): Card[] {
  const result = [...cards];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomSource(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Generates and shuffles one brand-new 64-card deck for the given
// generation number. Every replenishment (docs/card-clash-rules.md §6/§7)
// calls this with a freshly-incremented generation, so a card from deck
// generation 2 can never collide with one still held from generation 1 —
// ids are never reused, which matters because old cards can still be live
// in players' hands or the public discard pile when a replenishment
// happens.
export function shuffleNewDeck(generation: number, randomSource: RandomInt = defaultRandomInt): Card[] {
  return shuffle(createDeck(generation), randomSource);
}
