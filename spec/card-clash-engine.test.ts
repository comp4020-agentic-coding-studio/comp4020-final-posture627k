import { expect, it } from "vitest";
import { CARD_DISTRIBUTION, DECK_SIZE, type Card } from "../card-clash/cards.ts";
import { createDeck, shuffle, shuffleNewDeck, type RandomInt } from "../card-clash/deck.ts";
import {
  discardCards,
  drawCountForSeat,
  endTurn,
  initializeMatch,
  initialHandSizeForSeat,
  maxHpForSeat,
  SEATS_BY_MODE,
  teamForSeat,
} from "../card-clash/engine.ts";
import type { GameMode, MatchState, Seat } from "../card-clash/types.ts";

// Pure engine tests, deliberately independent of HTTP/SQLite — these run
// under spec/ only because vitest.config.ts scopes all tests there, not
// because this module has any HTTP dependency. A simple counter-based
// RandomInt (never node:crypto) makes every test deterministic.
function counterRandom(): RandomInt {
  let i = 0;
  return (max) => {
    const value = i % max;
    i++;
    return value;
  };
}

function cardIds(cards: readonly Card[]): string[] {
  return cards.map((c) => c.id);
}

it("createDeck produces exactly 64 cards matching the frozen distribution, all unique ids", () => {
  const deck = createDeck(1);
  expect(deck).toHaveLength(64);
  expect(DECK_SIZE).toBe(64);
  expect(new Set(cardIds(deck)).size).toBe(64); // every id unique within one deck

  for (const [type, count] of CARD_DISTRIBUTION) {
    expect(deck.filter((c) => c.type === type)).toHaveLength(count);
  }
});

it("shuffle uses the injected random source, not Math.random or crypto, and is reproducible", () => {
  const deck = createDeck(1);
  const shuffledA = shuffle(deck, counterRandom());
  const shuffledB = shuffle(deck, counterRandom());
  expect(cardIds(shuffledA)).toEqual(cardIds(shuffledB)); // same source -> same order
  expect(shuffledA).toHaveLength(64);
  expect(new Set(cardIds(shuffledA)).size).toBe(64); // still a genuine permutation, no card lost/duplicated

  const shuffledReal = shuffleNewDeck(1); // default (crypto) source
  // Astronomically unlikely to coincidentally match the deterministic
  // order above across all 64 positions — a real behavioral difference,
  // not merely "different object identity".
  expect(cardIds(shuffledReal)).not.toEqual(cardIds(shuffledA));
});

it("card ids never collide across deck generations", () => {
  const gen1 = createDeck(1);
  const gen2 = createDeck(2);
  const combinedIds = new Set([...cardIds(gen1), ...cardIds(gen2)]);
  expect(combinedIds.size).toBe(128);
});

const MODES: readonly GameMode[] = ["1v1", "1v2", "2v2"];

it("initializeMatch seats, teams, and HP match the frozen mode table", () => {
  const oneVOne = initializeMatch({ mode: "1v1", randomSource: counterRandom() });
  expect([...oneVOne.players.keys()].sort()).toEqual([1, 2]);
  expect(teamForSeat("1v1", 1)).toBe("A");
  expect(teamForSeat("1v1", 2)).toBe("B");
  expect(maxHpForSeat("1v1", 1)).toBe(3);
  expect(maxHpForSeat("1v1", 2)).toBe(3);

  const oneVTwo = initializeMatch({ mode: "1v2", randomSource: counterRandom() });
  expect([...oneVTwo.players.keys()].sort()).toEqual([1, 2, 3]);
  expect(maxHpForSeat("1v2", 1)).toBe(5); // host
  expect(maxHpForSeat("1v2", 2)).toBe(3);
  expect(maxHpForSeat("1v2", 3)).toBe(3);
  expect(teamForSeat("1v2", 1)).toBe("A");
  expect(teamForSeat("1v2", 2)).toBe("B");
  expect(teamForSeat("1v2", 3)).toBe("B");

  const twoVTwo = initializeMatch({ mode: "2v2", randomSource: counterRandom() });
  expect([...twoVTwo.players.keys()].sort()).toEqual([1, 2, 3, 4]);
  expect(teamForSeat("2v2", 1)).toBe("A");
  expect(teamForSeat("2v2", 4)).toBe("A");
  expect(teamForSeat("2v2", 2)).toBe("B");
  expect(teamForSeat("2v2", 3)).toBe("B");
  for (const seat of [1, 2, 3, 4] as const) expect(maxHpForSeat("2v2", seat)).toBe(3);
});

it("initial hand sizes match the frozen table, including the 2v2 seat-4 and seat-1-first-turn exceptions", () => {
  expect(initialHandSizeForSeat("1v1", 1)).toBe(4);
  expect(initialHandSizeForSeat("2v2", 4)).toBe(5);
  expect(initialHandSizeForSeat("2v2", 1)).toBe(4);
  expect(initialHandSizeForSeat("1v2", 1)).toBe(4);

  // Draw counts for each seat's OWN first turn.
  expect(drawCountForSeat("2v2", 1, true)).toBe(1); // one-time exception
  expect(drawCountForSeat("2v2", 1, false)).toBe(2); // every later turn
  expect(drawCountForSeat("1v2", 1, true)).toBe(3); // host, every turn including first
  expect(drawCountForSeat("1v2", 1, false)).toBe(3);
  expect(drawCountForSeat("1v1", 1, true)).toBe(2);
  expect(drawCountForSeat("2v2", 4, true)).toBe(2); // only seat 1 gets the first-turn exception
});

it("initializeMatch performs seat 1's first-turn draw immediately: hand size reflects initial deal + first draw", () => {
  const oneVOne = initializeMatch({ mode: "1v1", randomSource: counterRandom() });
  expect(oneVOne.activeSeat).toBe(1);
  expect(oneVOne.players.get(1)!.hand).toHaveLength(4 + 2); // initial 4 + normal first-turn draw of 2
  expect(oneVOne.players.get(1)!.hasTakenFirstTurn).toBe(true);
  expect(oneVOne.players.get(2)!.hasTakenFirstTurn).toBe(false); // untouched until their own turn

  const oneVTwo = initializeMatch({ mode: "1v2", randomSource: counterRandom() });
  expect(oneVTwo.players.get(1)!.hand).toHaveLength(4 + 3); // host draws 3

  const twoVTwo = initializeMatch({ mode: "2v2", randomSource: counterRandom() });
  expect(twoVTwo.players.get(1)!.hand).toHaveLength(4 + 1); // seat 1's one-time exception
  expect(twoVTwo.players.get(4)!.hand).toHaveLength(5); // seat 4's larger initial deal, untouched yet
});

function endTurnAfterDiscarding(state: MatchState, seat: Seat): MatchState {
  // Discards down to exactly the seat's current HP (the end-of-turn
  // limit), then ends the turn — the minimal valid sequence a real caller
  // would perform every turn in this test file.
  const player = state.players.get(seat)!;
  const excess = Math.max(0, player.hand.length - player.hp);
  const toDiscard = player.hand.slice(0, excess).map((c) => c.id);
  const afterDiscard = toDiscard.length > 0 ? discardCards(state, seat, toDiscard) : { ok: true as const, state };
  expect(afterDiscard.ok).toBe(true);
  if (!afterDiscard.ok) throw new Error("unreachable");
  const result = endTurn(afterDiscard.state, seat, counterRandom());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.state;
}

it("turn order cycles clockwise through exactly each mode's seats and wraps around", () => {
  for (const mode of MODES) {
    let state = initializeMatch({ mode, randomSource: counterRandom() });
    const order = SEATS_BY_MODE[mode];
    const seenActiveSeats: Seat[] = [state.activeSeat];
    for (let i = 0; i < order.length; i++) {
      state = endTurnAfterDiscarding(state, state.activeSeat);
      seenActiveSeats.push(state.activeSeat);
    }
    expect(seenActiveSeats).toEqual([...order, order[0]]); // full cycle back to seat 1
  }
});

it("endTurn rejects a non-active seat and a hand exceeding the current HP limit", () => {
  const state = initializeMatch({ mode: "1v1", randomSource: counterRandom() });
  expect(state.activeSeat).toBe(1);

  const wrongSeat = endTurn(state, 2, counterRandom());
  expect(wrongSeat).toEqual({ ok: false, reason: "not_active_seat" });

  // Seat 1's hand is 6 cards against 3 HP — over the limit until discarded.
  expect(state.players.get(1)!.hand.length).toBeGreaterThan(state.players.get(1)!.hp);
  const overLimit = endTurn(state, 1, counterRandom());
  expect(overLimit).toEqual({ ok: false, reason: "hand_exceeds_hp_limit" });
});

it("discardCards rejects a non-active seat and a card id not in that seat's hand", () => {
  const state = initializeMatch({ mode: "1v1", randomSource: counterRandom() });

  const wrongSeat = discardCards(state, 2, [state.players.get(2)!.hand[0]!.id]);
  expect(wrongSeat).toEqual({ ok: false, reason: "not_active_seat" });

  const badId = discardCards(state, 1, ["not-a-real-card-id"]);
  expect(badId).toEqual({ ok: false, reason: "card_not_in_hand" });

  const cardId = state.players.get(1)!.hand[0]!.id;
  const result = discardCards(state, 1, [cardId]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.state.players.get(1)!.hand.map((c) => c.id)).not.toContain(cardId);
  expect(result.state.discardPile.map((c) => c.id)).toContain(cardId);
});

it("deck replenishment never recycles the discard pile, keeps ids unique, and completes a boundary-crossing draw atomically", () => {
  // A 1v1 match's draw pile after initial deal + seat 1's first draw:
  // 64 - 4 - 4 - 2 = 54 cards left.
  let state = initializeMatch({ mode: "1v1", randomSource: counterRandom() });
  expect(state.drawPile).toHaveLength(54);
  expect(state.deckGeneration).toBe(1);

  // Discard a card first so it's sitting in the public discard pile before
  // the pile empties — this is the card that must NOT reappear in the
  // replenished deck.
  const discardedId = state.players.get(1)!.hand[0]!.id;
  const afterDiscard = discardCards(state, 1, [discardedId]);
  expect(afterDiscard.ok).toBe(true);
  if (!afterDiscard.ok) return;
  state = afterDiscard.state;

  // Drain the draw pile down to 1 card by cycling full turns (each 1v1
  // turn draws 2), then force a final endTurn whose draw must cross the
  // exhaustion boundary (pile has fewer cards left than the draw needs).
  while (state.drawPile.length > 1) {
    state = endTurnAfterDiscarding(state, state.activeSeat);
  }
  expect(state.drawPile.length).toBeLessThan(2); // next draw of 2 must cross the boundary

  const beforeGeneration = state.deckGeneration;
  const afterBoundary = endTurnAfterDiscarding(state, state.activeSeat);
  expect(afterBoundary.deckGeneration).toBe(beforeGeneration + 1); // a fresh deck was generated
  expect(afterBoundary.drawPile.length).toBeGreaterThan(0); // the draw completed, not left half-done

  const allCardIds = [
    ...afterBoundary.drawPile,
    ...afterBoundary.discardPile,
    ...[...afterBoundary.players.values()].flatMap((p) => p.hand),
  ].map((c) => c.id);
  expect(new Set(allCardIds).size).toBe(allCardIds.length); // no id collision across generations

  // The discarded card is still only in the discard pile — never recycled
  // back into the new draw pile or anyone's hand.
  expect(afterBoundary.discardPile.map((c) => c.id)).toContain(discardedId);
  expect(afterBoundary.drawPile.map((c) => c.id)).not.toContain(discardedId);
});
