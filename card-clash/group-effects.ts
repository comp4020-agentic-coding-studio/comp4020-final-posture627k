// War Cry and Arrow Volley — the two D2B group-response card effects for
// Card Clash. Builds on card-clash/combat.ts's dying-rescue machinery
// (reused exactly via computeRescueOrder — never duplicated) and
// card-clash/engine.ts's SEATS_BY_MODE. See docs/card-clash-rules.md §2/§3
// for the rules, and combat.ts's respondToRescue for how a dying rescue
// triggered mid-group-resolution resumes the suspended queue afterward.
//
// Deferred: any further group/area-effect cards, simultaneous responses,
// and arbitrary counterspell chains — none of that exists here.

import { computeRescueOrder } from "./combat.ts";
import { SEATS_BY_MODE } from "./engine.ts";
import type { GroupResponseContext, MatchState, Seat } from "./types.ts";

// Clockwise response order starting with the nearest OTHER living seat
// clockwise from `actor` (docs §2 step 3 / §4 examples) — the actor
// themself is never included. The mirror image of combat.ts's
// computeRescueOrder (which walks backward/counterclockwise and always
// appends the dying seat itself).
function computeClockwiseGroupQueue(state: MatchState, actor: Seat): Seat[] {
  const order = SEATS_BY_MODE[state.mode];
  const n = order.length;
  const actorIndex = order.indexOf(actor);
  const queue: Seat[] = [];
  for (let step = 1; step < n; step++) {
    const seat = order[(actorIndex + step) % n]!;
    if (!state.players.get(seat)!.eliminated) queue.push(seat);
  }
  return queue;
}

// Either re-arms the pending group response for the next queued target, or
// — once the queue is empty — clears pending entirely. activeSeat is left
// untouched here: it is already the group actor throughout ordinary
// resolution (nothing in this module ever changes it), and the one case
// where it legitimately needs restoring (after a rescue detour) is handled
// by combat.ts's own resumeAfterRescue, not here.
function continueOrFinishGroup(state: MatchState, context: GroupResponseContext): MatchState {
  return context.queue.length > 0 ? { ...state, pending: { kind: "group_response", context } } : { ...state, pending: undefined };
}

export type PlayGroupCardResult =
  | { readonly ok: true; readonly state: MatchState }
  | {
      readonly ok: false;
      readonly reason: "match_complete" | "response_pending" | "not_active_seat" | "stale_version" | "card_not_in_hand";
    };

// Plays War Cry or Arrow Volley: consumes and publicly reveals the card,
// then opens a pending group response naming every other living seat in
// clockwise order. Neither card consumes the normal-Attack allowance
// (docs §2/§3) — normalAttacksUsedThisTurn is never touched here.
export function playGroupCard(
  state: MatchState,
  seat: Seat,
  cardType: "war_cry" | "arrow_volley",
  expectedVersion: number,
): PlayGroupCardResult {
  if (state.matchResult.status === "complete") return { ok: false, reason: "match_complete" };
  if (state.pending !== undefined) return { ok: false, reason: "response_pending" };
  if (seat !== state.activeSeat) return { ok: false, reason: "not_active_seat" };
  if (expectedVersion !== state.version) return { ok: false, reason: "stale_version" };

  const actor = state.players.get(seat)!;
  const card = actor.hand.find((c) => c.type === cardType);
  if (!card) return { ok: false, reason: "card_not_in_hand" };

  const players = new Map(state.players);
  players.set(seat, { ...actor, hand: actor.hand.filter((c) => c.id !== card.id) });

  const context: GroupResponseContext = {
    actor: seat,
    cardType,
    requiredResponseType: cardType === "war_cry" ? "attack" : "dodge",
    queue: computeClockwiseGroupQueue(state, seat),
  };

  const afterPlay: MatchState = {
    ...state,
    players,
    discardPile: [...state.discardPile, card],
    publicLog: [...state.publicLog, { type: "group_card_played", actor: seat, cardType }],
    version: state.version + 1,
  };

  return { ok: true, state: continueOrFinishGroup(afterPlay, context) };
}

export type RespondToGroupEffectResult =
  | { readonly ok: true; readonly state: MatchState }
  | {
      readonly ok: false;
      readonly reason:
        | "match_complete"
        | "no_pending_group_response"
        | "not_the_responder"
        | "stale_version"
        | "wrong_response_type"
        | "card_not_in_hand";
    };

// Only the current queue[0] responder may act, and only with the specific
// card type this group effect requires (Attack for War Cry, Dodge for
// Arrow Volley) or an explicit decline — never the other card type (docs
// §2/§3: "every other living player must respond with Attack [or Dodge] or
// suffer 1 HP damage"). A response card is consumed purely as a response:
// it never triggers its own ordinary effect (no counter-attack, no further
// Dodge requirement) and never touches the responder's own future-turn
// normal-Attack allowance, since activeSeat (and therefore
// normalAttacksUsedThisTurn's scope) never changes during group
// resolution. A decline that brings the responder to 0 HP suspends this
// queue and opens the existing dying-rescue sequence (combat.ts), which
// resumes this exact queue — with the dying seat already removed —
// afterward; see combat.ts's respondToRescue.
export function respondToGroupEffect(
  state: MatchState,
  seat: Seat,
  action: { readonly type: "attack" } | { readonly type: "dodge" } | { readonly type: "decline" },
  expectedVersion: number,
): RespondToGroupEffectResult {
  if (state.matchResult.status === "complete") return { ok: false, reason: "match_complete" };
  if (state.pending?.kind !== "group_response") return { ok: false, reason: "no_pending_group_response" };
  const context = state.pending.context;
  if (seat !== context.queue[0]) return { ok: false, reason: "not_the_responder" };
  if (expectedVersion !== state.version) return { ok: false, reason: "stale_version" };

  const remainingContext: GroupResponseContext = { ...context, queue: context.queue.slice(1) };

  if (action.type !== "decline") {
    if (action.type !== context.requiredResponseType) return { ok: false, reason: "wrong_response_type" };

    const responder = state.players.get(seat)!;
    const card = responder.hand.find((c) => c.type === action.type);
    if (!card) return { ok: false, reason: "card_not_in_hand" };

    const players = new Map(state.players);
    players.set(seat, { ...responder, hand: responder.hand.filter((c) => c.id !== card.id) });

    const afterResponse: MatchState = {
      ...state,
      players,
      discardPile: [...state.discardPile, card],
      publicLog: [...state.publicLog, { type: "group_response_played", actor: seat, responseType: action.type }],
      version: state.version + 1,
    };
    return { ok: true, state: continueOrFinishGroup(afterResponse, remainingContext) };
  }

  const responder = state.players.get(seat)!;
  const newHp = responder.hp - 1;
  const players = new Map(state.players);
  players.set(seat, { ...responder, hp: Math.max(newHp, 0) });

  const afterDecline: MatchState = {
    ...state,
    players,
    publicLog: [...state.publicLog, { type: "group_response_declined", actor: seat }],
    version: state.version + 1,
  };

  if (newHp <= 0) {
    return {
      ok: true,
      state: {
        ...afterDecline,
        pending: {
          kind: "dying_rescue",
          dyingSeat: seat,
          queue: computeRescueOrder(afterDecline, seat),
          resumeActiveSeat: context.actor,
          // Already advanced past the now-dying seat — see this module's
          // own continueOrFinishGroup for why an empty queue here means
          // "resume straight to the actor's MAIN phase" once rescue ends.
          resumingGroupContext: remainingContext,
        },
      },
    };
  }

  return { ok: true, state: continueOrFinishGroup(afterDecline, remainingContext) };
}
