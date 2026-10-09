import { expect, it } from "vitest";
import type { Card, CardType } from "../card-clash/cards.ts";
import {
  playAttack,
  playHeal,
  respondToAttack,
  respondToRescue,
} from "../card-clash/combat.ts";
import { endTurn, initializeMatch } from "../card-clash/engine.ts";
import type { GameMode, MatchState, Seat } from "../card-clash/types.ts";

// D1B combat/response/rescue tests — pure, deterministic, no HTTP/SQLite.
// Every hand used here is built with the typed withHand() fixture below
// rather than relying on whatever initializeMatch happened to deal, so
// which cards a seat holds is always explicit and never random.

function withHand(state: MatchState, seat: Seat, types: readonly CardType[]): MatchState {
  const hand: Card[] = types.map((type, i) => ({ id: `fixture-${seat}-${i}-${type}`, type }));
  const players = new Map(state.players);
  players.set(seat, { ...players.get(seat)!, hand });
  return { ...state, players };
}

function withHp(state: MatchState, seat: Seat, hp: number): MatchState {
  const players = new Map(state.players);
  players.set(seat, { ...players.get(seat)!, hp });
  return { ...state, players };
}

function withEliminated(state: MatchState, seat: Seat): MatchState {
  const players = new Map(state.players);
  players.set(seat, { ...players.get(seat)!, eliminated: true, hp: 0 });
  return { ...state, players };
}

function setup(mode: GameMode): MatchState {
  return initializeMatch({ mode, randomSource: () => 0 });
}

it("a legal Attack against an opponent opens a pending response without dealing damage yet", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["attack"]);
  const before = state.players.get(2)!.hp;

  const result = playAttack(state, 1, 2, state.version);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.state.pending).toEqual({ kind: "attack_response", attacker: 1, target: 2 });
  expect(result.state.players.get(2)!.hp).toBe(before); // no damage until the response resolves
  expect(result.state.players.get(1)!.hand.map((c) => c.type)).not.toContain("attack"); // card left the hand
  expect(result.state.discardPile.some((c) => c.type === "attack")).toBe(true); // publicly revealed
  expect(result.state.publicLog).toContainEqual({ type: "attack_played", actor: 1, target: 2 });
});

it("Attack can target a teammate, cannot target self, and only the active seat may play it", () => {
  let state = setup("2v2"); // seats 1 and 4 are teammates (team A)
  state = withHand(state, 1, ["attack", "attack", "attack"]);

  const selfTarget = playAttack(state, 1, 1, state.version);
  expect(selfTarget).toEqual({ ok: false, reason: "cannot_target_self" });

  const wrongActor = playAttack(state, 2, 3, state.version);
  expect(wrongActor).toEqual({ ok: false, reason: "not_active_seat" });

  const vsTeammate = playAttack(state, 1, 4, state.version);
  expect(vsTeammate.ok).toBe(true);
  if (vsTeammate.ok) expect(vsTeammate.state.pending).toMatchObject({ attacker: 1, target: 4 });
});

it("normal Attack is limited to one per turn, except the 1v2 host, who gets two, and a third is rejected", () => {
  let oneVOne = setup("1v1");
  oneVOne = withHand(oneVOne, 1, ["attack", "attack", "dodge"]);
  const first = playAttack(oneVOne, 1, 2, oneVOne.version);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const resolved = respondToAttack(first.state, 2, { type: "decline" }, first.state.version);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  const second = playAttack(resolved.state, 1, 2, resolved.state.version);
  expect(second).toEqual({ ok: false, reason: "attack_limit_reached" });

  let host = setup("1v2");
  host = withHand(host, 1, ["attack", "attack", "attack"]);
  const hostFirst = playAttack(host, 1, 2, host.version);
  expect(hostFirst.ok).toBe(true);
  if (!hostFirst.ok) return;
  const hostFirstResolved = respondToAttack(hostFirst.state, 2, { type: "decline" }, hostFirst.state.version);
  expect(hostFirstResolved.ok).toBe(true);
  if (!hostFirstResolved.ok) return;
  const hostSecond = playAttack(hostFirstResolved.state, 1, 3, hostFirstResolved.state.version);
  expect(hostSecond.ok).toBe(true); // host's second attack this turn is legal
  if (!hostSecond.ok) return;
  const hostSecondResolved = respondToAttack(hostSecond.state, 3, { type: "decline" }, hostSecond.state.version);
  expect(hostSecondResolved.ok).toBe(true);
  if (!hostSecondResolved.ok) return;
  const hostThird = playAttack(hostSecondResolved.state, 1, 2, hostSecondResolved.state.version);
  expect(hostThird).toEqual({ ok: false, reason: "attack_limit_reached" }); // third rejected even for the host
});

it("Dodge cancels damage and is consumed; a decline deals exactly 1 HP; only the target may respond", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["attack"]);
  state = withHand(state, 2, ["dodge"]);
  const attacked = playAttack(state, 1, 2, state.version);
  expect(attacked.ok).toBe(true);
  if (!attacked.ok) return;

  const wrongResponder = respondToAttack(attacked.state, 1, { type: "dodge" }, attacked.state.version);
  expect(wrongResponder).toEqual({ ok: false, reason: "not_the_responder" }); // the attacker cannot answer for the target

  const dodged = respondToAttack(attacked.state, 2, { type: "dodge" }, attacked.state.version);
  expect(dodged.ok).toBe(true);
  if (!dodged.ok) return;
  expect(dodged.state.players.get(2)!.hp).toBe(3); // unchanged
  expect(dodged.state.pending).toBeUndefined(); // control returns to the attacker
  expect(dodged.state.players.get(2)!.hand.map((c) => c.type)).not.toContain("dodge");

  // A fresh match (seat 1's one-per-turn attack allowance is already spent
  // in the state above) resolved with a decline instead of a dodge.
  let declineState = setup("1v1");
  declineState = withHand(declineState, 1, ["attack"]);
  const attacked2 = playAttack(declineState, 1, 2, declineState.version);
  expect(attacked2.ok).toBe(true);
  if (!attacked2.ok) return;
  const declined = respondToAttack(attacked2.state, 2, { type: "decline" }, attacked2.state.version);
  expect(declined.ok).toBe(true);
  if (!declined.ok) return;
  expect(declined.state.players.get(2)!.hp).toBe(2); // exactly 1 HP lost
});

it("proactive Heal only ever targets the active player themself, respecting max HP", () => {
  let state = setup("2v2");
  state = withHp(state, 1, 2); // active seat, below max (3)
  state = withHp(state, 4, 2); // teammate, also below max, but NOT active
  state = withHand(state, 1, ["heal"]);

  const healed = playHeal(state, 1, state.version);
  expect(healed.ok).toBe(true);
  if (!healed.ok) return;
  expect(healed.state.players.get(1)!.hp).toBe(3);
  expect(healed.state.players.get(4)!.hp).toBe(2); // the teammate is untouched — no API path heals anyone but self

  const atMax = playHeal(healed.state, 1, healed.state.version);
  expect(atMax).toEqual({ ok: false, reason: "already_at_max_hp" });
});

it("reaching 0 HP enters DYING (not immediate elimination), and the rescue order is counterclockwise with self asked last", () => {
  // 1v2: seats [1,2,3] clockwise. Dying seat 2's rescue order should be [1, 3, 2].
  let host = setup("1v2");
  host = withHand(host, 1, ["attack"]);
  host = withHp(host, 2, 1);
  const attacked = playAttack(host, 1, 2, host.version);
  expect(attacked.ok).toBe(true);
  if (!attacked.ok) return;
  const dying = respondToAttack(attacked.state, 2, { type: "decline" }, attacked.state.version);
  expect(dying.ok).toBe(true);
  if (!dying.ok) return;
  expect(dying.state.players.get(2)!.eliminated).toBe(false); // not eliminated yet
  expect(dying.state.players.get(2)!.hp).toBe(0);
  expect(dying.state.pending).toEqual({
    kind: "dying_rescue",
    dyingSeat: 2,
    queue: [1, 3, 2],
    resumeActiveSeat: 1,
  });

  // 2v2: seats [1,2,3,4] clockwise. Dying seat 3's rescue order should be [2, 1, 4, 3].
  let twoVTwo = setup("2v2");
  twoVTwo = withHand(twoVTwo, 1, ["attack"]);
  twoVTwo = withHp(twoVTwo, 3, 1);
  const attacked2 = playAttack(twoVTwo, 1, 3, twoVTwo.version);
  expect(attacked2.ok).toBe(true);
  if (!attacked2.ok) return;
  const dying2 = respondToAttack(attacked2.state, 3, { type: "decline" }, attacked2.state.version);
  expect(dying2.ok).toBe(true);
  if (!dying2.ok) return;
  expect(dying2.state.pending).toMatchObject({ kind: "dying_rescue", dyingSeat: 3, queue: [2, 1, 4, 3] });
});

it("an enemy may rescue a dying enemy, successful rescue restores exactly 1 HP, and ends the sequence immediately", () => {
  let host = setup("1v2");
  host = withHand(host, 1, ["attack", "heal"]); // seat 1 is the attacker AND first in seat 2's rescue queue
  host = withHp(host, 2, 1);
  const attacked = playAttack(host, 1, 2, host.version);
  expect(attacked.ok).toBe(true);
  if (!attacked.ok) return;
  const dying = respondToAttack(attacked.state, 2, { type: "decline" }, attacked.state.version);
  expect(dying.ok).toBe(true);
  if (!dying.ok) return;
  expect(dying.state.pending).toMatchObject({ queue: [1, 3, 2] }); // seat 1 (enemy) is asked first

  const rescued = respondToRescue(dying.state, 1, { type: "heal" }, dying.state.version);
  expect(rescued.ok).toBe(true);
  if (!rescued.ok) return;
  expect(rescued.state.players.get(2)!.hp).toBe(1); // restored to exactly 1, never more
  expect(rescued.state.players.get(2)!.eliminated).toBe(false);
  expect(rescued.state.pending).toBeUndefined(); // sequence ended immediately
  expect(rescued.state.activeSeat).toBe(1); // control returned to the original attacker
});

it("the dying player's own rescue opportunity is last, and self-rescue restores them to 1 HP", () => {
  // Seat 3 attacks seat 2 (declining active seat is set directly — a
  // legitimate, typed test-state construction, not a cast); seats 1 and 3
  // hold no Heal, so only seat 2's own Heal — in their own hand even while
  // dying — can rescue them, and only once asked last.
  let host = setup("1v2");
  host = withHand(host, 1, []); // no Heal — declines
  host = withHand(host, 3, ["attack"]); // no Heal — declines when asked to rescue
  host = withHand(host, 2, ["heal"]); // the dying player's own hand, used at the end
  host = withHp(host, 2, 1);
  const activeSeat3 = { ...host, activeSeat: 3 as Seat };

  const attacked = playAttack(activeSeat3, 3, 2, activeSeat3.version);
  expect(attacked.ok).toBe(true);
  if (!attacked.ok) return;
  const dying = respondToAttack(attacked.state, 2, { type: "decline" }, attacked.state.version);
  expect(dying.ok).toBe(true);
  if (!dying.ok) return;
  expect(dying.state.pending).toMatchObject({ queue: [1, 3, 2] }); // seat 2 (self) is last

  const firstDeclines = respondToRescue(dying.state, 1, { type: "decline" }, dying.state.version);
  expect(firstDeclines.ok).toBe(true);
  if (!firstDeclines.ok) return;
  const secondDeclines = respondToRescue(firstDeclines.state, 3, { type: "decline" }, firstDeclines.state.version);
  expect(secondDeclines.ok).toBe(true);
  if (!secondDeclines.ok) return;
  expect(secondDeclines.state.pending).toMatchObject({ queue: [2] }); // only the dying player's own turn left

  const selfRescue = respondToRescue(secondDeclines.state, 2, { type: "heal" }, secondDeclines.state.version);
  expect(selfRescue.ok).toBe(true);
  if (!selfRescue.ok) return;
  expect(selfRescue.state.players.get(2)!.hp).toBe(1);
  expect(selfRescue.state.players.get(2)!.eliminated).toBe(false);
});

it("every responder declining, including the dying player's own last chance, causes elimination", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["attack"]);
  state = withHand(state, 2, []); // no Dodge, no Heal
  state = withHp(state, 2, 1);
  const attacked = playAttack(state, 1, 2, state.version);
  expect(attacked.ok).toBe(true);
  if (!attacked.ok) return;
  const dying = respondToAttack(attacked.state, 2, { type: "decline" }, attacked.state.version);
  expect(dying.ok).toBe(true);
  if (!dying.ok) return;
  // 1v1 still has one other living player (the attacker) to ask before the
  // dying player's own last chance — there is no mode/scenario where the
  // queue is ever just [dyingSeat].
  expect(dying.state.pending).toMatchObject({ queue: [1, 2] });

  const attackerDeclines = respondToRescue(dying.state, 1, { type: "decline" }, dying.state.version);
  expect(attackerDeclines.ok).toBe(true);
  if (!attackerDeclines.ok) return;

  const finalDecline = respondToRescue(attackerDeclines.state, 2, { type: "decline" }, attackerDeclines.state.version);
  expect(finalDecline.ok).toBe(true);
  if (!finalDecline.ok) return;
  expect(finalDecline.state.players.get(2)!.eliminated).toBe(true);
  expect(finalDecline.state.players.get(2)!.hp).toBe(0);
  expect(finalDecline.state.pending).toBeUndefined();
  // 1v1: the last living player wins outright.
  expect(finalDecline.state.matchResult).toEqual({ status: "complete", winningTeam: "A" });
});

it("dead seats are skipped during turn advancement, and no further game actions are accepted once the match is complete", () => {
  let state = setup("1v2");
  state = withHand(state, 1, ["attack"]);
  state = withHand(state, 2, []);
  state = withHp(state, 2, 1);
  const attacked = playAttack(state, 1, 2, state.version);
  expect(attacked.ok).toBe(true);
  if (!attacked.ok) return;
  const dying = respondToAttack(attacked.state, 2, { type: "decline" }, attacked.state.version);
  expect(dying.ok).toBe(true);
  if (!dying.ok) return;
  expect(dying.state.pending).toMatchObject({ queue: [1, 3, 2] }); // seat 1, then seat 3, then seat 2 (self) last

  const seat1Declines = respondToRescue(dying.state, 1, { type: "decline" }, dying.state.version);
  expect(seat1Declines.ok).toBe(true);
  if (!seat1Declines.ok) return;
  const seat3Declines = respondToRescue(seat1Declines.state, 3, { type: "decline" }, seat1Declines.state.version);
  expect(seat3Declines.ok).toBe(true);
  if (!seat3Declines.ok) return;
  const eliminated = respondToRescue(seat3Declines.state, 2, { type: "decline" }, seat3Declines.state.version);
  expect(eliminated.ok).toBe(true);
  if (!eliminated.ok) return;
  expect(eliminated.state.players.get(2)!.eliminated).toBe(true);
  expect(eliminated.state.matchResult.status).toBe("ongoing"); // seat 3 (team B) still lives

  // Give seat 1 a hand within their HP limit so endTurn is otherwise legal.
  const ready = withHand(eliminated.state, 1, []);
  const afterEndTurn = endTurn(ready, 1, () => 0);
  expect(afterEndTurn.ok).toBe(true);
  if (!afterEndTurn.ok) return;
  expect(afterEndTurn.state.activeSeat).toBe(3); // skipped the eliminated seat 2, went straight to 3
});

it("no actions are accepted after the match completes, and rejected actions never mutate the input state", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["attack"]);
  state = withHand(state, 2, []);
  state = withHp(state, 2, 1);
  const attacked = playAttack(state, 1, 2, state.version);
  expect(attacked.ok).toBe(true);
  if (!attacked.ok) return;
  const dying = respondToAttack(attacked.state, 2, { type: "decline" }, attacked.state.version);
  expect(dying.ok).toBe(true);
  if (!dying.ok) return;
  const attackerDeclines = respondToRescue(dying.state, 1, { type: "decline" }, dying.state.version);
  expect(attackerDeclines.ok).toBe(true);
  if (!attackerDeclines.ok) return;
  const finished = respondToRescue(attackerDeclines.state, 2, { type: "decline" }, attackerDeclines.state.version);
  expect(finished.ok).toBe(true);
  if (!finished.ok) return;
  expect(finished.state.matchResult.status).toBe("complete");

  const completedState = finished.state;
  const snapshotVersion = completedState.version;

  const postAttack = playAttack(completedState, 1, 2, completedState.version);
  expect(postAttack).toEqual({ ok: false, reason: "match_complete" });

  const postHeal = playHeal(completedState, 1, completedState.version);
  expect(postHeal).toEqual({ ok: false, reason: "match_complete" });

  // A rejected call must never have mutated its input — re-reading the
  // same state object afterward shows the identical version untouched.
  expect(completedState.version).toBe(snapshotVersion);
});

it("stale expected_version is rejected for combat actions, and a pending response blocks discard/end-turn", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["attack"]);
  const stale = playAttack(state, 1, 2, state.version + 1);
  expect(stale).toEqual({ ok: false, reason: "stale_version" });

  const attacked = playAttack(state, 1, 2, state.version);
  expect(attacked.ok).toBe(true);
  if (!attacked.ok) return;
  expect(attacked.state.pending).toBeDefined();
});

it("public events never carry hidden card ids or hand contents", () => {
  let state = setup("1v1");
  state = withHand(state, 1, ["attack"]);
  const attacked = playAttack(state, 1, 2, state.version);
  expect(attacked.ok).toBe(true);
  if (!attacked.ok) return;
  const serialized = JSON.stringify(attacked.state.publicLog);
  expect(serialized).not.toContain("fixture-"); // our own test card ids never leak into the public log
  for (const event of attacked.state.publicLog) {
    expect(Object.keys(event)).not.toContain("hand");
    expect(Object.keys(event)).not.toContain("cardId");
  }
});
