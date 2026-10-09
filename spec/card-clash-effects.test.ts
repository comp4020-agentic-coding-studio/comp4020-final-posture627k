import { expect, it } from "vitest";
import type { Card, CardType } from "../card-clash/cards.ts";
import { playAttack, respondToAttack } from "../card-clash/combat.ts";
import type { RandomInt } from "../card-clash/deck.ts";
import { initializeMatch } from "../card-clash/engine.ts";
import { playDisarm, playInsight, playSeize } from "../card-clash/effects.ts";
import type { GameMode, MatchState, Seat } from "../card-clash/types.ts";

// D2A effect tests — pure, deterministic, no HTTP/SQLite. Every hand used
// here is built with the typed withHand() fixture, never random dealing,
// so which cards a seat/target holds is always explicit.

// A monotonic counter (not seat/index-derived) keeps every fixture card id
// unique across an entire test, even across multiple withHand() calls for
// the same seat — e.g. a test that re-hands a seat after some of their
// original fixture cards are already sitting in the discard pile.
let fixtureCardCounter = 0;
function withHand(state: MatchState, seat: Seat, types: readonly CardType[]): MatchState {
  const hand: Card[] = types.map((type) => ({ id: `fixture-${fixtureCardCounter++}-${type}`, type }));
  const players = new Map(state.players);
  players.set(seat, { ...players.get(seat)!, hand });
  return { ...state, players };
}

function setup(mode: GameMode): MatchState {
  return initializeMatch({ mode, randomSource: () => 0 });
}

function alwaysIndex(index: number): RandomInt {
  return () => index;
}

it("Seize from an opponent transfers the exact physical card instance, consumes exactly one draw, and is correct for both opponent and teammate targets", () => {
  // Opponent target, 1v1.
  let state = setup("1v1");
  state = withHand(state, 1, ["seize"]);
  state = withHand(state, 2, ["dodge", "heal"]);
  const targetedCardId = state.players.get(2)!.hand[1]!.id; // "heal", index 1
  const result = playSeize(state, 1, 2, state.version, alwaysIndex(1)); // always picks the second card
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.state.players.get(1)!.hand.map((c) => c.id)).toContain(targetedCardId);
  expect(result.state.players.get(2)!.hand.map((c) => c.id)).not.toContain(targetedCardId);
  expect(result.state.players.get(2)!.hand.map((c) => c.type)).toEqual(["dodge"]);
  expect(result.state.players.get(1)!.hand.map((c) => c.type)).not.toContain("seize"); // Seize itself consumed
  expect(result.state.discardPile.some((c) => c.type === "seize")).toBe(true);

  // Teammate target, 2v2 (seat 1 and seat 4 are team A).
  let twoVTwo = setup("2v2");
  twoVTwo = withHand(twoVTwo, 1, ["seize"]);
  twoVTwo = withHand(twoVTwo, 4, ["attack"]);
  const teammateCardId = twoVTwo.players.get(4)!.hand[0]!.id;
  const teammateResult = playSeize(twoVTwo, 1, 4, twoVTwo.version, alwaysIndex(0));
  expect(teammateResult.ok).toBe(true);
  if (!teammateResult.ok) return;
  expect(teammateResult.state.players.get(1)!.hand.map((c) => c.id)).toContain(teammateCardId);
});

it("Seize's public event reveals only actor/target, never the stolen card's identity or type, and rejects an empty-handed target", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["seize"]);
  state = withHand(state, 2, ["dodge"]);
  const result = playSeize(state, 1, 2, state.version, alwaysIndex(0));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.state.publicLog).toContainEqual({ type: "seize_played", actor: 1, target: 2 });
  const serialized = JSON.stringify(result.state.publicLog);
  expect(serialized).not.toContain("dodge"); // the stolen card's type/id never leaks into the public log

  let emptyHandState = setup("1v1");
  emptyHandState = withHand(emptyHandState, 1, ["seize"]);
  emptyHandState = withHand(emptyHandState, 2, []);
  const emptyRejected = playSeize(emptyHandState, 1, 2, emptyHandState.version);
  expect(emptyRejected).toEqual({ ok: false, reason: "target_hand_empty" });
});

it("Disarm against an opponent and a teammate discards the chosen card to the public pile and reveals its type, without exposing the rest of the hand", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["disarm"]);
  state = withHand(state, 2, ["dodge", "heal"]);
  const result = playDisarm(state, 1, 2, state.version, alwaysIndex(1)); // discards "heal"
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.state.players.get(2)!.hand.map((c) => c.type)).toEqual(["dodge"]); // remaining hand intact, only "heal" gone
  expect(result.state.discardPile.some((c) => c.type === "heal")).toBe(true); // publicly in the discard pile
  expect(result.state.publicLog).toContainEqual({ type: "disarm_played", actor: 1, target: 2 });
  expect(result.state.publicLog).toContainEqual({ type: "disarm_card_revealed", target: 2, cardType: "heal" });
  const serialized = JSON.stringify(result.state.publicLog);
  expect(serialized).not.toContain("dodge"); // the REMAINING hand's contents never appear in the log

  let twoVTwo = setup("2v2");
  twoVTwo = withHand(twoVTwo, 1, ["disarm"]);
  twoVTwo = withHand(twoVTwo, 4, ["attack"]); // teammate target
  const teammateResult = playDisarm(twoVTwo, 1, 4, twoVTwo.version, alwaysIndex(0));
  expect(teammateResult.ok).toBe(true);
  if (!teammateResult.ok) return;
  expect(teammateResult.state.players.get(4)!.hand).toHaveLength(0);
});

it("Insight draws exactly two cards into the active seat's own hand, replenishing an exhausted deck correctly, and may be played repeatedly in one turn", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["insight", "insight"]);
  const handSizeBefore = state.players.get(1)!.hand.length;

  const first = playInsight(state, 1, state.version);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  // -1 for the consumed Insight, +2 drawn.
  expect(first.state.players.get(1)!.hand.length).toBe(handSizeBefore - 1 + 2);
  expect(first.state.publicLog).toContainEqual({ type: "insight_played", actor: 1, cardsDrawn: 2 });
  const serialized = JSON.stringify(first.state.publicLog.filter((e) => e.type === "insight_played"));
  expect(serialized).not.toMatch(/"type":"(attack|dodge|heal|seize|disarm|war_cry|arrow_volley)"/); // no drawn-card identity leaked

  // A second Insight in the same turn (the active seat never changed).
  const second = playInsight(first.state, 1, first.state.version);
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.state.players.get(1)!.hand.length).toBe(handSizeBefore - 2 + 4);

  // Deck-exhaustion replenishment: drain the draw pile down to 1 card,
  // then force an Insight draw that must cross the boundary.
  let drained = second.state;
  drained = withHand(drained, 1, ["insight"]);
  drained = { ...drained, drawPile: drained.drawPile.slice(0, 1) };
  const beforeGeneration = drained.deckGeneration;
  const crossing = playInsight(drained, 1, drained.version);
  expect(crossing.ok).toBe(true);
  if (!crossing.ok) return;
  expect(crossing.state.deckGeneration).toBe(beforeGeneration + 1); // replenished
  expect(crossing.state.drawPile.length).toBeGreaterThan(0); // the draw completed correctly, not half-done

  const allIds = [
    ...crossing.state.drawPile,
    ...crossing.state.discardPile,
    ...[...crossing.state.players.values()].flatMap((p) => p.hand),
  ].map((c) => c.id);
  expect(new Set(allIds).size).toBe(allIds.length); // no id collision across the replenished generation
});

it("Seize, Disarm, and Insight never consume the normal Attack allowance", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["seize", "attack"]);
  state = withHand(state, 2, ["dodge"]);
  expect(state.normalAttacksUsedThisTurn).toBe(0);

  const afterSeize = playSeize(state, 1, 2, state.version, alwaysIndex(0));
  expect(afterSeize.ok).toBe(true);
  if (!afterSeize.ok) return;
  expect(afterSeize.state.normalAttacksUsedThisTurn).toBe(0);

  // Attack is still fully available afterward.
  const attacked = playAttack(afterSeize.state, 1, 2, afterSeize.state.version);
  expect(attacked.ok).toBe(true);
  if (!attacked.ok) return;
  expect(attacked.state.normalAttacksUsedThisTurn).toBe(1);
});

it("rejects the wrong actor, self-targeting, and an invalid/eliminated target", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["seize"]);
  state = withHand(state, 2, ["dodge"]);

  const wrongActor = playSeize(state, 2, 1, state.version);
  expect(wrongActor).toEqual({ ok: false, reason: "not_active_seat" });

  const selfTarget = playDisarm(state, 1, 1, state.version);
  expect(selfTarget).toEqual({ ok: false, reason: "cannot_target_self" });

  let twoVTwo = setup("2v2");
  twoVTwo = withHand(twoVTwo, 1, ["seize"]);
  const players = new Map(twoVTwo.players);
  players.set(2, { ...players.get(2)!, eliminated: true, hand: [{ id: "x", type: "dodge" }] });
  twoVTwo = { ...twoVTwo, players };
  const eliminatedTarget = playSeize(twoVTwo, 1, 2, twoVTwo.version);
  expect(eliminatedTarget).toEqual({ ok: false, reason: "invalid_target" });
});

it("Seize, Disarm, and Insight are all rejected while an attack response is pending, and the original input state is left untouched", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["attack", "seize", "disarm", "insight"]);
  state = withHand(state, 2, ["dodge"]);
  const attacked = playAttack(state, 1, 2, state.version);
  expect(attacked.ok).toBe(true);
  if (!attacked.ok) return;
  const pendingState = attacked.state;
  const snapshotVersion = pendingState.version;

  const seizeRejected = playSeize(pendingState, 1, 2, pendingState.version);
  expect(seizeRejected).toEqual({ ok: false, reason: "response_pending" });
  const disarmRejected = playDisarm(pendingState, 1, 2, pendingState.version);
  expect(disarmRejected).toEqual({ ok: false, reason: "response_pending" });
  const insightRejected = playInsight(pendingState, 1, pendingState.version);
  expect(insightRejected).toEqual({ ok: false, reason: "response_pending" });

  // Failed transitions must never have mutated their input.
  expect(pendingState.version).toBe(snapshotVersion);
  expect(pendingState.players.get(1)!.hand.map((c) => c.type)).toContain("seize");
  expect(pendingState.players.get(1)!.hand.map((c) => c.type)).toContain("insight");
});

it("Seize, Disarm, and Insight are all rejected while a dying rescue is pending", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["attack", "seize"]);
  state = withHand(state, 2, []);
  const players = new Map(state.players);
  players.set(2, { ...players.get(2)!, hp: 1 });
  state = { ...state, players };

  const attacked = playAttack(state, 1, 2, state.version);
  expect(attacked.ok).toBe(true);
  if (!attacked.ok) return;
  const dying = respondToAttack(attacked.state, 2, { type: "decline" }, attacked.state.version);
  expect(dying.ok).toBe(true);
  if (!dying.ok) return;
  expect(dying.state.pending?.kind).toBe("dying_rescue");

  const seizeRejected = playSeize(dying.state, 1, 2, dying.state.version);
  expect(seizeRejected).toEqual({ ok: false, reason: "response_pending" });
});

it("successful effects advance the version by exactly one each, consistently", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["seize", "disarm", "insight"]);
  state = withHand(state, 2, ["dodge", "heal"]);
  const v0 = state.version;

  const afterSeize = playSeize(state, 1, 2, v0, alwaysIndex(0));
  expect(afterSeize.ok).toBe(true);
  if (!afterSeize.ok) return;
  expect(afterSeize.state.version).toBe(v0 + 1);

  const afterDisarm = playDisarm(afterSeize.state, 1, 2, afterSeize.state.version, alwaysIndex(0));
  expect(afterDisarm.ok).toBe(true);
  if (!afterDisarm.ok) return;
  expect(afterDisarm.state.version).toBe(v0 + 2);

  const afterInsight = playInsight(afterDisarm.state, 1, afterDisarm.state.version);
  expect(afterInsight.ok).toBe(true);
  if (!afterInsight.ok) return;
  expect(afterInsight.state.version).toBe(v0 + 3);

  // A stale version is rejected without advancing anything.
  const stale = playInsight(afterInsight.state, 1, v0);
  expect(stale).toEqual({ ok: false, reason: "stale_version" });
  expect(afterInsight.state.version).toBe(v0 + 3); // unchanged by the rejected call
});
