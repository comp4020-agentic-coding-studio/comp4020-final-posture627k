// DISCARD-phase turn flow (D4C-2). Pure; composes the existing engine's
// endTurn/discardCards rather than reimplementing ownership, drawing or turn
// advancement. docs/card-clash-rules.md §11.

import { discardCards, endTurn } from "./engine.ts";
import { defaultRandomInt, type RandomInt } from "./deck.ts";
import type { MatchState, Seat } from "./types.ts";

export type FlowResult =
  | { readonly ok: true; readonly state: MatchState }
  | { readonly ok: false; readonly reason: string };

function clearPhase(state: MatchState): MatchState {
  const { turnPhase: _removed, ...rest } = state;
  return rest as MatchState;
}

// Ends MAIN (voluntarily or by timeout). Hand within the HP limit advances
// the turn immediately; otherwise the DISCARD phase begins.
export function endMainPhase(state: MatchState, seat: Seat, randomSource?: RandomInt): FlowResult {
  if (state.matchResult.status === "complete") return { ok: false, reason: "match_complete" };
  if (state.pending !== undefined) return { ok: false, reason: "response_pending" };
  if (seat !== state.activeSeat) return { ok: false, reason: "not_active_seat" };
  const player = state.players.get(seat)!;
  if (player.hand.length <= player.hp) {
    const next = endTurn(state, seat, randomSource);
    return next.ok ? { ok: true, state: clearPhase(next.state) } : next;
  }
  if (state.turnPhase === "discard") return { ok: false, reason: "hand_exceeds_hp_limit" };
  return { ok: true, state: { ...state, turnPhase: "discard", version: state.version + 1 } };
}

// Manual discard. During the DISCARD phase, reaching the limit advances the
// turn in the same transition.
export function discardAndMaybeAdvance(state: MatchState, seat: Seat, cardIds: readonly string[], randomSource?: RandomInt): FlowResult {
  const discarded = discardCards(state, seat, cardIds);
  if (!discarded.ok) return discarded;
  if (state.turnPhase !== "discard") return discarded;
  const player = discarded.state.players.get(seat)!;
  if (player.hand.length > player.hp) return discarded;
  const next = endTurn(discarded.state, seat, randomSource);
  return next.ok ? { ok: true, state: clearPhase(next.state) } : next;
}

// Timeout: removes exactly the excess, chosen uniformly without
// replacement via the injected RandomInt (secure default), then advances.
export function autoDiscardAndAdvance(state: MatchState, seat: Seat, randomSource: RandomInt = defaultRandomInt): FlowResult {
  const player = state.players.get(seat)!;
  const excess = Math.max(0, player.hand.length - Math.max(0, player.hp));
  const pool = player.hand.map((c) => c.id);
  const chosen: string[] = [];
  for (let i = 0; i < excess; i++) chosen.push(pool.splice(randomSource(pool.length), 1)[0]!);
  const discarded = excess > 0 ? discardCards(state, seat, chosen) : ({ ok: true, state } as const);
  if (!discarded.ok) return discarded;
  const next = endTurn(discarded.state, seat, randomSource);
  return next.ok ? { ok: true, state: clearPhase(next.state) } : next;
}
