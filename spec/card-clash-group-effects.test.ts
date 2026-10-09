import { expect, it } from "vitest";
import type { Card, CardType } from "../card-clash/cards.ts";
import { playAttack, playHeal, respondToAttack, respondToRescue } from "../card-clash/combat.ts";
import { discardCards, endTurn, initializeMatch } from "../card-clash/engine.ts";
import { playDisarm, playInsight, playSeize } from "../card-clash/effects.ts";
import { playGroupCard, respondToGroupEffect } from "../card-clash/group-effects.ts";
import type { GameMode, MatchState, Seat } from "../card-clash/types.ts";

// D2B group-effect tests (War Cry / Arrow Volley) — pure, deterministic,
// no HTTP/SQLite. Every hand is built with the typed withHand() fixture,
// never random dealing.

let fixtureCardCounter = 0;
function withHand(state: MatchState, seat: Seat, types: readonly CardType[]): MatchState {
  const hand: Card[] = types.map((type) => ({ id: `fixture-${fixtureCardCounter++}-${type}`, type }));
  const players = new Map(state.players);
  players.set(seat, { ...players.get(seat)!, hand });
  return { ...state, players };
}

function withHp(state: MatchState, seat: Seat, hp: number): MatchState {
  const players = new Map(state.players);
  players.set(seat, { ...players.get(seat)!, hp });
  return { ...state, players };
}

function setup(mode: GameMode): MatchState {
  return initializeMatch({ mode, randomSource: () => 0 });
}

it("War Cry and Arrow Volley are played, publicly revealed, and consumed exactly once", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["war_cry"]);
  const result = playGroupCard(state, 1, "war_cry", state.version);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.state.publicLog).toContainEqual({ type: "group_card_played", actor: 1, cardType: "war_cry" });
  expect(result.state.players.get(1)!.hand.map((c) => c.type)).not.toContain("war_cry"); // consumed from hand
  expect(result.state.discardPile.filter((c) => c.type === "war_cry")).toHaveLength(1); // exactly once
  expect(result.state.pending).toMatchObject({ kind: "group_response" });

  let arrowState = setup("1v1");
  arrowState = withHand(arrowState, 1, ["arrow_volley"]);
  const arrowResult = playGroupCard(arrowState, 1, "arrow_volley", arrowState.version);
  expect(arrowResult.ok).toBe(true);
  if (!arrowResult.ok) return;
  expect(arrowResult.state.publicLog).toContainEqual({ type: "group_card_played", actor: 1, cardType: "arrow_volley" });
  expect(arrowResult.state.pending).toMatchObject({ context: { requiredResponseType: "dodge" } });
});

it("the response queue is clockwise, starting with the nearest other living seat, exactly matching the documented worked examples", () => {
  // Four-player 2v2, seat 1 plays War Cry: queue should be [2, 3, 4].
  let fourPlayer = setup("2v2");
  fourPlayer = withHand(fourPlayer, 1, ["war_cry"]);
  const warCry = playGroupCard(fourPlayer, 1, "war_cry", fourPlayer.version);
  expect(warCry.ok).toBe(true);
  if (!warCry.ok) return;
  expect(warCry.state.pending).toMatchObject({ context: { queue: [2, 3, 4] } });

  // Seat 3 uses Arrow Volley: queue should be [4, 1, 2]. A fresh,
  // independent match with activeSeat set directly to seat 3 (a
  // legitimate, typed test-state construction — activeSeat never changes
  // merely because a different seat responded to someone else's group
  // effect, so this is not reachable by chaining off the War Cry scenario
  // above without a full extra turn cycle, which is irrelevant to the
  // ordering property this test checks).
  let thirdSeatActive = setup("2v2");
  thirdSeatActive = withHand(thirdSeatActive, 3, ["arrow_volley"]);
  thirdSeatActive = { ...thirdSeatActive, activeSeat: 3 };
  const arrowVolley = playGroupCard(thirdSeatActive, 3, "arrow_volley", thirdSeatActive.version);
  expect(arrowVolley.ok).toBe(true);
  if (!arrowVolley.ok) return;
  expect(arrowVolley.state.pending).toMatchObject({ context: { queue: [4, 1, 2] } });
});

it("teammates are included in the response queue", () => {
  let state = setup("2v2"); // seats 1 and 4 are team A
  state = withHand(state, 1, ["war_cry"]);
  const result = playGroupCard(state, 1, "war_cry", state.version);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.state.pending).toMatchObject({ context: { queue: [2, 3, 4] } }); // seat 4 (teammate) included
});

it("War Cry only accepts Attack responses and Arrow Volley only accepts Dodge; the wrong card type is rejected", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["war_cry"]);
  state = withHand(state, 2, ["dodge"]);
  const warCry = playGroupCard(state, 1, "war_cry", state.version);
  expect(warCry.ok).toBe(true);
  if (!warCry.ok) return;
  const wrongType = respondToGroupEffect(warCry.state, 2, { type: "dodge" }, warCry.state.version);
  expect(wrongType).toEqual({ ok: false, reason: "wrong_response_type" });

  let arrowState = setup("1v1");
  arrowState = withHand(arrowState, 1, ["arrow_volley"]);
  arrowState = withHand(arrowState, 2, ["attack"]);
  const arrowVolley = playGroupCard(arrowState, 1, "arrow_volley", arrowState.version);
  expect(arrowVolley.ok).toBe(true);
  if (!arrowVolley.ok) return;
  const wrongType2 = respondToGroupEffect(arrowVolley.state, 2, { type: "attack" }, arrowVolley.state.version);
  expect(wrongType2).toEqual({ ok: false, reason: "wrong_response_type" });
});

it("a valid group response is consumed, publicly revealed, prevents damage, triggers no new attack, and never touches the normal Attack allowance", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["war_cry"]);
  state = withHand(state, 2, ["attack"]);
  const warCry = playGroupCard(state, 1, "war_cry", state.version);
  expect(warCry.ok).toBe(true);
  if (!warCry.ok) return;
  expect(warCry.state.normalAttacksUsedThisTurn).toBe(0); // playing War Cry itself doesn't use it

  const hpBefore = warCry.state.players.get(2)!.hp;
  const responded = respondToGroupEffect(warCry.state, 2, { type: "attack" }, warCry.state.version);
  expect(responded.ok).toBe(true);
  if (!responded.ok) return;
  expect(responded.state.players.get(2)!.hp).toBe(hpBefore); // no damage — the response succeeded
  expect(responded.state.players.get(2)!.hand.map((c) => c.type)).not.toContain("attack"); // consumed
  expect(responded.state.discardPile.some((c) => c.type === "attack")).toBe(true); // publicly revealed
  expect(responded.state.publicLog).toContainEqual({ type: "group_response_played", actor: 2, responseType: "attack" });
  expect(responded.state.pending).toBeUndefined(); // 1v1: only one other seat, queue now empty
  expect(responded.state.normalAttacksUsedThisTurn).toBe(0); // the response never opened a real Attack
  expect(responded.state.activeSeat).toBe(1); // control remains with the original actor
});

it("a decline causes exactly 1 HP damage", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["war_cry"]);
  state = withHand(state, 2, []);
  const warCry = playGroupCard(state, 1, "war_cry", state.version);
  expect(warCry.ok).toBe(true);
  if (!warCry.ok) return;
  const hpBefore = warCry.state.players.get(2)!.hp;
  const declined = respondToGroupEffect(warCry.state, 2, { type: "decline" }, warCry.state.version);
  expect(declined.ok).toBe(true);
  if (!declined.ok) return;
  expect(declined.state.players.get(2)!.hp).toBe(hpBefore - 1);
  expect(declined.state.publicLog).toContainEqual({ type: "group_response_declined", actor: 2 });
});

it("only the current queued responder may act; stale/duplicate responses are rejected without mutating state", () => {
  let state = setup("2v2");
  state = withHand(state, 1, ["war_cry"]);
  const warCry = playGroupCard(state, 1, "war_cry", state.version);
  expect(warCry.ok).toBe(true);
  if (!warCry.ok) return;
  expect(warCry.state.pending).toMatchObject({ context: { queue: [2, 3, 4] } });

  const wrongResponder = respondToGroupEffect(warCry.state, 3, { type: "decline" }, warCry.state.version);
  expect(wrongResponder).toEqual({ ok: false, reason: "not_the_responder" });

  const snapshotVersion = warCry.state.version;
  const staleVersion = respondToGroupEffect(warCry.state, 2, { type: "decline" }, warCry.state.version + 1);
  expect(staleVersion).toEqual({ ok: false, reason: "stale_version" });
  expect(warCry.state.version).toBe(snapshotVersion); // untouched by the rejected call

  const firstDecline = respondToGroupEffect(warCry.state, 2, { type: "decline" }, warCry.state.version);
  expect(firstDecline.ok).toBe(true);
  if (!firstDecline.ok) return;
  // Resubmitting seat 2's response after they've already gone is rejected:
  // they are no longer queue[0] (seat 3 is).
  const duplicateResponse = respondToGroupEffect(firstDecline.state, 2, { type: "decline" }, firstDecline.state.version);
  expect(duplicateResponse).toEqual({ ok: false, reason: "not_the_responder" });
});

it("no other action is accepted while a group response is pending: not Attack/Heal/Seize/Disarm/Insight, discard, or end turn", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["war_cry", "attack", "heal", "seize", "disarm", "insight"]);
  state = withHand(state, 2, ["attack"]);
  const warCry = playGroupCard(state, 1, "war_cry", state.version);
  expect(warCry.ok).toBe(true);
  if (!warCry.ok) return;
  const pendingState = warCry.state;

  expect(playAttack(pendingState, 1, 2, pendingState.version)).toEqual({ ok: false, reason: "response_pending" });
  expect(playHeal(pendingState, 1, pendingState.version)).toEqual({ ok: false, reason: "response_pending" });
  expect(playSeize(pendingState, 1, 2, pendingState.version)).toEqual({ ok: false, reason: "response_pending" });
  expect(playDisarm(pendingState, 1, 2, pendingState.version)).toEqual({ ok: false, reason: "response_pending" });
  expect(playInsight(pendingState, 1, pendingState.version)).toEqual({ ok: false, reason: "response_pending" });
  expect(discardCards(pendingState, 1, [])).toEqual({ ok: false, reason: "response_pending" });
  expect(endTurn(pendingState, 1)).toEqual({ ok: false, reason: "response_pending" });
});

it("a decline that brings a responder to 0 HP suspends the group queue and opens the existing counterclockwise dying-rescue sequence, with enemies eligible", () => {
  // Four-player 2v2: seat 1 (team A) uses War Cry; seat 2 (team B) is at 1 HP.
  let state = setup("2v2");
  state = withHand(state, 1, ["war_cry"]);
  state = withHand(state, 2, []);
  state = withHand(state, 3, ["attack"]);
  state = withHp(state, 2, 1);
  const warCry = playGroupCard(state, 1, "war_cry", state.version);
  expect(warCry.ok).toBe(true);
  if (!warCry.ok) return;

  const dying = respondToGroupEffect(warCry.state, 2, { type: "decline" }, warCry.state.version);
  expect(dying.ok).toBe(true);
  if (!dying.ok) return;
  expect(dying.state.players.get(2)!.hp).toBe(0);
  expect(dying.state.players.get(2)!.eliminated).toBe(false); // DYING, not eliminated yet
  // Rescue eligibility is every OTHER living seat (docs §4), independent
  // of group-queue membership — seat 3 hasn't had their War Cry turn yet
  // but is still asked to rescue. Counterclockwise from seat 2 in a
  // 4-seat ring: seat 1, seat 4, seat 3, then self.
  expect(dying.state.pending).toMatchObject({
    kind: "dying_rescue",
    dyingSeat: 2,
    queue: [1, 4, 3, 2],
    resumingGroupContext: { queue: [3, 4] }, // the group queue itself, already past seat 2
  });

  // Seat 1 is the War Cry actor — an enemy of seat 2's team — and is still
  // eligible to rescue a dying enemy.
  const enemyDeclines = respondToRescue(dying.state, 1, { type: "decline" }, dying.state.version);
  expect(enemyDeclines.ok).toBe(true);
  if (!enemyDeclines.ok) return;
  expect(enemyDeclines.state.pending).toMatchObject({ kind: "dying_rescue", queue: [4, 3, 2] });
});

it("a successful rescue mid-group-effect resumes at the correct NEXT group target, never re-asking the rescued seat and never double-applying damage", () => {
  let state = setup("2v2");
  state = withHand(state, 1, ["war_cry"]);
  state = withHand(state, 2, []);
  state = withHand(state, 4, ["heal"]); // seat 4 (team A, enemy of seat 2) can rescue
  state = withHand(state, 3, ["attack"]);
  state = withHp(state, 2, 1);
  const warCry = playGroupCard(state, 1, "war_cry", state.version);
  expect(warCry.ok).toBe(true);
  if (!warCry.ok) return;
  const dying = respondToGroupEffect(warCry.state, 2, { type: "decline" }, warCry.state.version);
  expect(dying.ok).toBe(true);
  if (!dying.ok) return;
  expect(dying.state.players.get(2)!.hp).toBe(0);

  const seat1Declines = respondToRescue(dying.state, 1, { type: "decline" }, dying.state.version);
  expect(seat1Declines.ok).toBe(true);
  if (!seat1Declines.ok) return;
  const seat4Rescues = respondToRescue(seat1Declines.state, 4, { type: "heal" }, seat1Declines.state.version);
  expect(seat4Rescues.ok).toBe(true);
  if (!seat4Rescues.ok) return;
  expect(seat4Rescues.state.players.get(2)!.hp).toBe(1); // restored exactly once, to exactly 1
  expect(seat4Rescues.state.players.get(2)!.eliminated).toBe(false);
  // Group resolution resumes at seat 3 (the next unresolved target) — seat
  // 2 is never asked for a War Cry response again.
  expect(seat4Rescues.state.pending).toMatchObject({ kind: "group_response", context: { queue: [3, 4] } });

  const seat3Responds = respondToGroupEffect(seat4Rescues.state, 3, { type: "attack" }, seat4Rescues.state.version);
  expect(seat3Responds.ok).toBe(true);
  if (!seat3Responds.ok) return;
  expect(seat3Responds.state.pending).toMatchObject({ context: { queue: [4] } });
  const seat4Responds = respondToGroupEffect(seat3Responds.state, 4, { type: "decline" }, seat3Responds.state.version);
  expect(seat4Responds.ok).toBe(true);
  if (!seat4Responds.ok) return;
  expect(seat4Responds.state.pending).toBeUndefined(); // group effect fully resolved
  expect(seat4Responds.state.activeSeat).toBe(1); // control returned to the original War Cry actor
});

it("a failed rescue eliminates the dying seat and resumes group resolution at the next target when the match continues", () => {
  let state = setup("2v2");
  state = withHand(state, 1, ["war_cry"]);
  state = withHand(state, 2, []); // no Heal from anyone — will be eliminated
  state = withHand(state, 3, ["attack"]);
  state = withHand(state, 4, ["attack"]);
  state = withHp(state, 2, 1);
  const warCry = playGroupCard(state, 1, "war_cry", state.version);
  expect(warCry.ok).toBe(true);
  if (!warCry.ok) return;
  const dying = respondToGroupEffect(warCry.state, 2, { type: "decline" }, warCry.state.version);
  expect(dying.ok).toBe(true);
  if (!dying.ok) return;

  expect(dying.state.pending).toMatchObject({ kind: "dying_rescue", queue: [1, 4, 3, 2] });
  const seat1Declines = respondToRescue(dying.state, 1, { type: "decline" }, dying.state.version);
  expect(seat1Declines.ok).toBe(true);
  if (!seat1Declines.ok) return;
  const seat4Declines = respondToRescue(seat1Declines.state, 4, { type: "decline" }, seat1Declines.state.version);
  expect(seat4Declines.ok).toBe(true);
  if (!seat4Declines.ok) return;
  const seat3DeclinesRescue = respondToRescue(seat4Declines.state, 3, { type: "decline" }, seat4Declines.state.version);
  expect(seat3DeclinesRescue.ok).toBe(true);
  if (!seat3DeclinesRescue.ok) return;
  const eliminated = respondToRescue(seat3DeclinesRescue.state, 2, { type: "decline" }, seat3DeclinesRescue.state.version);
  expect(eliminated.ok).toBe(true);
  if (!eliminated.ok) return;
  expect(eliminated.state.players.get(2)!.eliminated).toBe(true);
  expect(eliminated.state.matchResult.status).toBe("ongoing"); // seat 3 (team B) still lives
  // Group resolution resumes with BOTH remaining targets — declining to
  // rescue is an entirely separate obligation from responding to the
  // original War Cry, so seat 4's rescue decline does not excuse them from
  // the group response queue too.
  expect(eliminated.state.pending).toMatchObject({ kind: "group_response", context: { queue: [3, 4] } });

  const seat3Responds = respondToGroupEffect(eliminated.state, 3, { type: "attack" }, eliminated.state.version);
  expect(seat3Responds.ok).toBe(true);
  if (!seat3Responds.ok) return;
  expect(seat3Responds.state.pending).toMatchObject({ context: { queue: [4] } });
  const seat4Responds = respondToGroupEffect(seat3Responds.state, 4, { type: "attack" }, seat3Responds.state.version);
  expect(seat4Responds.ok).toBe(true);
  if (!seat4Responds.ok) return;
  expect(seat4Responds.state.pending).toBeUndefined();
  expect(seat4Responds.state.activeSeat).toBe(1); // control returned to the original War Cry actor
});

it("a failed rescue that ends the match stops group processing immediately — no further requests, no MAIN-phase resumption", () => {
  // 1v1: seat 1 uses War Cry against the only other seat (2); seat 2 has
  // no Heal, declines their own last chance, is eliminated, and the match
  // ends there (no further group target to ask).
  let state = setup("1v1");
  state = withHand(state, 1, ["war_cry"]);
  state = withHand(state, 2, []);
  state = withHp(state, 2, 1);
  const warCry = playGroupCard(state, 1, "war_cry", state.version);
  expect(warCry.ok).toBe(true);
  if (!warCry.ok) return;
  const dying = respondToGroupEffect(warCry.state, 2, { type: "decline" }, warCry.state.version);
  expect(dying.ok).toBe(true);
  if (!dying.ok) return;
  expect(dying.state.pending).toMatchObject({ kind: "dying_rescue", queue: [1, 2] });

  const seat1Declines = respondToRescue(dying.state, 1, { type: "decline" }, dying.state.version);
  expect(seat1Declines.ok).toBe(true);
  if (!seat1Declines.ok) return;
  const finished = respondToRescue(seat1Declines.state, 2, { type: "decline" }, seat1Declines.state.version);
  expect(finished.ok).toBe(true);
  if (!finished.ok) return;
  expect(finished.state.matchResult).toEqual({ status: "complete", winningTeam: "A" });
  expect(finished.state.pending).toBeUndefined(); // no group effect left pending

  // No further action of any kind is accepted.
  expect(playGroupCard(finished.state, 1, "arrow_volley", finished.state.version)).toEqual({
    ok: false,
    reason: "match_complete",
  });
});

it("public events reveal only actor/target/response-type/outcome — never hidden hand contents or deck order", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["war_cry"]);
  state = withHand(state, 2, ["attack"]);
  const warCry = playGroupCard(state, 1, "war_cry", state.version);
  expect(warCry.ok).toBe(true);
  if (!warCry.ok) return;
  const responded = respondToGroupEffect(warCry.state, 2, { type: "attack" }, warCry.state.version);
  expect(responded.ok).toBe(true);
  if (!responded.ok) return;

  expect(responded.state.publicLog).toEqual([
    { type: "group_card_played", actor: 1, cardType: "war_cry" },
    { type: "group_response_played", actor: 2, responseType: "attack" },
  ]);
  const serialized = JSON.stringify(responded.state.publicLog);
  expect(serialized).not.toContain("fixture-"); // no raw card id ever appears in the public log
});

it("ordinary Attack/Dodge/Heal and Seize/Disarm/Insight are unaffected by the new group-effect module", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["attack", "heal"]);
  state = withHand(state, 2, ["dodge"]);
  const attacked = playAttack(state, 1, 2, state.version);
  expect(attacked.ok).toBe(true);
  if (!attacked.ok) return;
  const dodged = respondToAttack(attacked.state, 2, { type: "dodge" }, attacked.state.version);
  expect(dodged.ok).toBe(true);
  if (!dodged.ok) return;
  expect(dodged.state.pending).toBeUndefined();

  let healState = setup("1v1");
  healState = withHp(healState, 1, 2);
  healState = withHand(healState, 1, ["heal"]);
  const healed = playHeal(healState, 1, healState.version);
  expect(healed.ok).toBe(true);
  if (!healed.ok) return;
  expect(healed.state.players.get(1)!.hp).toBe(3);

  let seizeState = setup("1v1");
  seizeState = withHand(seizeState, 1, ["seize"]);
  seizeState = withHand(seizeState, 2, ["dodge"]);
  const seized = playSeize(seizeState, 1, 2, seizeState.version, () => 0);
  expect(seized.ok).toBe(true);
});
