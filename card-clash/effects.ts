// Seize, Disarm, and Insight — the three D2A proactive hand effects for
// Card Clash. Builds on card-clash/engine.ts's drawInternal (reused
// exactly, not reimplemented) and follows card-clash/combat.ts's own
// MAIN-phase guard order precisely. See docs/card-clash-rules.md §2 for
// the rules.
//
// Deferred to a later D2 slice: War Cry, Arrow Volley, group response
// queues — none of that is implemented here.

import { randomInt } from "node:crypto";
import type { RandomInt } from "./deck.ts";
import { drawInternal } from "./engine.ts";
import type { MatchState, Seat } from "./types.ts";

const defaultRandomInt: RandomInt = (max) => randomInt(max);

type MainPhaseRejection = "match_complete" | "response_pending" | "not_active_seat" | "stale_version";

// The shared actor/phase/version guard every D2A proactive effect enforces
// first, in the same order card-clash/combat.ts's playAttack/playHeal
// already use — these three cards are proactive MAIN-phase cards exactly
// like Attack/Heal, just without a normal-Attack-allowance check.
function checkMainPhase(state: MatchState, seat: Seat, expectedVersion: number): MainPhaseRejection | undefined {
  if (state.matchResult.status === "complete") return "match_complete";
  if (state.pending !== undefined) return "response_pending";
  if (seat !== state.activeSeat) return "not_active_seat";
  if (expectedVersion !== state.version) return "stale_version";
  return undefined;
}

type TargetedRejection = MainPhaseRejection | "card_not_in_hand" | "cannot_target_self" | "invalid_target" | "target_hand_empty";

function checkTarget(state: MatchState, seat: Seat, target: Seat): TargetedRejection | undefined {
  if (target === seat) return "cannot_target_self";
  const targetPlayer = state.players.get(target);
  if (!targetPlayer || targetPlayer.eliminated) return "invalid_target";
  if (targetPlayer.hand.length === 0) return "target_hand_empty";
  return undefined;
}

export type PlaySeizeResult =
  | { readonly ok: true; readonly state: MatchState }
  | { readonly ok: false; readonly reason: TargetedRejection };

// Randomly transfers one physical card (the exact instance, same id) from
// `target`'s hand into `seat`'s hand. Teammates are valid targets (docs
// §2). The public event names only actor and target — never the stolen
// card's type or id, and never anything about the actor's own existing
// hand.
export function playSeize(
  state: MatchState,
  seat: Seat,
  target: Seat,
  expectedVersion: number,
  randomSource?: RandomInt,
): PlaySeizeResult {
  const mainPhaseIssue = checkMainPhase(state, seat, expectedVersion);
  if (mainPhaseIssue) return { ok: false, reason: mainPhaseIssue };
  const targetIssue = checkTarget(state, seat, target);
  if (targetIssue) return { ok: false, reason: targetIssue };

  const actor = state.players.get(seat)!;
  const seizeCard = actor.hand.find((c) => c.type === "seize");
  if (!seizeCard) return { ok: false, reason: "card_not_in_hand" };

  const targetPlayer = state.players.get(target)!;
  const stolenIndex = (randomSource ?? defaultRandomInt)(targetPlayer.hand.length);
  const stolenCard = targetPlayer.hand[stolenIndex]!;

  const players = new Map(state.players);
  players.set(target, { ...targetPlayer, hand: targetPlayer.hand.filter((c) => c.id !== stolenCard.id) });
  players.set(seat, { ...actor, hand: [...actor.hand.filter((c) => c.id !== seizeCard.id), stolenCard] });

  return {
    ok: true,
    state: {
      ...state,
      players,
      discardPile: [...state.discardPile, seizeCard],
      publicLog: [...state.publicLog, { type: "seize_played", actor: seat, target }],
      version: state.version + 1,
    },
  };
}

export type PlayDisarmResult =
  | { readonly ok: true; readonly state: MatchState }
  | { readonly ok: false; readonly reason: TargetedRejection };

// Randomly discards one physical card from `target`'s hand to the public
// discard pile. Unlike Seize, the discarded card's TYPE is publicly
// revealed (docs §3 — "Reveal the actual card discarded"), but the rest of
// the target's hand is not.
export function playDisarm(
  state: MatchState,
  seat: Seat,
  target: Seat,
  expectedVersion: number,
  randomSource?: RandomInt,
): PlayDisarmResult {
  const mainPhaseIssue = checkMainPhase(state, seat, expectedVersion);
  if (mainPhaseIssue) return { ok: false, reason: mainPhaseIssue };
  const targetIssue = checkTarget(state, seat, target);
  if (targetIssue) return { ok: false, reason: targetIssue };

  const actor = state.players.get(seat)!;
  const disarmCard = actor.hand.find((c) => c.type === "disarm");
  if (!disarmCard) return { ok: false, reason: "card_not_in_hand" };

  const targetPlayer = state.players.get(target)!;
  const discardIndex = (randomSource ?? defaultRandomInt)(targetPlayer.hand.length);
  const discardedCard = targetPlayer.hand[discardIndex]!;

  const players = new Map(state.players);
  players.set(target, { ...targetPlayer, hand: targetPlayer.hand.filter((c) => c.id !== discardedCard.id) });
  players.set(seat, { ...actor, hand: actor.hand.filter((c) => c.id !== disarmCard.id) });

  return {
    ok: true,
    state: {
      ...state,
      players,
      discardPile: [...state.discardPile, disarmCard, discardedCard],
      publicLog: [
        ...state.publicLog,
        { type: "disarm_played", actor: seat, target },
        { type: "disarm_card_revealed", target, cardType: discardedCard.type },
      ],
      version: state.version + 1,
    },
  };
}

export type PlayInsightResult =
  | { readonly ok: true; readonly state: MatchState }
  | { readonly ok: false; readonly reason: MainPhaseRejection | "card_not_in_hand" };

// Discards the played Insight card, then draws exactly 2 cards for the
// active seat via engine.ts's own drawInternal — reused verbatim, so
// deck-exhaustion replenishment (never recycling the discard pile) behaves
// identically to every other draw in the engine. No target; may be played
// repeatedly in one turn if multiple copies are held (no proactive-card
// limit exists — docs §3/§5).
export function playInsight(
  state: MatchState,
  seat: Seat,
  expectedVersion: number,
  randomSource?: RandomInt,
): PlayInsightResult {
  const mainPhaseIssue = checkMainPhase(state, seat, expectedVersion);
  if (mainPhaseIssue) return { ok: false, reason: mainPhaseIssue };

  const actor = state.players.get(seat)!;
  const insightCard = actor.hand.find((c) => c.type === "insight");
  if (!insightCard) return { ok: false, reason: "card_not_in_hand" };

  const players = new Map(state.players);
  players.set(seat, { ...actor, hand: actor.hand.filter((c) => c.id !== insightCard.id) });
  const afterDiscard: MatchState = { ...state, players, discardPile: [...state.discardPile, insightCard] };

  const afterDraw = drawInternal(afterDiscard, seat, 2, randomSource);

  return {
    ok: true,
    state: {
      ...afterDraw,
      publicLog: [...afterDraw.publicLog, { type: "insight_played", actor: seat, cardsDrawn: 2 }],
      version: state.version + 1,
    },
  };
}
