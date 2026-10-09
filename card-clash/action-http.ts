// HTTP-facing action parsing and dispatch for Card Clash (D4A). This module
// never implements a game rule itself — it only validates the shape of an
// incoming JSON action request and builds the one trusted pure-engine
// transition function db.ts's applyCardClashTransition (D3A) expects. See
// card-clash/combat.ts, effects.ts, and group-effects.ts for the actual
// rules; this module is purely a typed adapter in front of them.
//
// Deliberate design note: NONE of the engine's play* functions take a
// specific card id — Attack/Heal/Seize/Disarm/Insight/War Cry/Arrow Volley
// cards are fungible within their own type (the engine finds a matching
// card in the actor's hand itself), so this action schema never accepts or
// forwards a `cardId` field for those actions — accepting one the engine
// would silently ignore would be misleading. `discard_cards` is the one
// action that genuinely needs specific card identities (the player chooses
// which of their own cards to discard), so only it carries `cardIds`.

import { playAttack, respondToAttack, playHeal, respondToRescue } from "./combat.ts";
import { playSeize, playDisarm, playInsight } from "./effects.ts";
import { playGroupCard, respondToGroupEffect } from "./group-effects.ts";
import { discardCards, endTurn } from "./engine.ts";
import type { MatchState, Seat } from "./types.ts";

export const CARD_CLASH_ACTION_TYPES = [
  "play_attack",
  "respond_dodge",
  "decline_attack_response",
  "play_heal",
  "play_seize",
  "play_disarm",
  "play_insight",
  "play_war_cry",
  "play_arrow_volley",
  "respond_group_attack",
  "respond_group_dodge",
  "decline_group_response",
  "rescue_heal",
  "decline_rescue",
  "end_turn",
  "discard_cards",
] as const;

export type CardClashActionType = (typeof CARD_CLASH_ACTION_TYPES)[number];

const SEAT_TARGETED_ACTIONS: ReadonlySet<CardClashActionType> = new Set(["play_attack", "play_seize", "play_disarm"]);

export type ParsedCardClashAction =
  | { readonly type: "play_attack"; readonly targetSeat: Seat }
  | { readonly type: "respond_dodge" }
  | { readonly type: "decline_attack_response" }
  | { readonly type: "play_heal" }
  | { readonly type: "play_seize"; readonly targetSeat: Seat }
  | { readonly type: "play_disarm"; readonly targetSeat: Seat }
  | { readonly type: "play_insight" }
  | { readonly type: "play_war_cry" }
  | { readonly type: "play_arrow_volley" }
  | { readonly type: "respond_group_attack" }
  | { readonly type: "respond_group_dodge" }
  | { readonly type: "decline_group_response" }
  | { readonly type: "rescue_heal" }
  | { readonly type: "decline_rescue" }
  | { readonly type: "end_turn" }
  | { readonly type: "discard_cards"; readonly cardIds: readonly string[] };

export interface CardClashActionEnvelope {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly action: ParsedCardClashAction;
}

function isValidSeat(value: unknown): value is Seat {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4;
}

function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isValidVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isValidCardId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(value);
}

// Strictly validates one incoming JSON body into a typed action envelope —
// rejects (returns undefined) on any unknown top-level field, a missing or
// malformed common field (type/requestId/expectedVersion), a missing
// required action-specific field, or an action-specific field present when
// it is NOT required for that action type ("Reject unexpected state-
// changing fields" — docs/card-clash-rules.md's own engine already
// enforces game legality; this is the HTTP-shape gate in front of it).
export function parseCardClashActionEnvelope(body: unknown): CardClashActionEnvelope | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const { type, requestId, expectedVersion, targetSeat, cardIds, ...rest } = record;
  if (Object.keys(rest).length > 0) return undefined;

  if (typeof type !== "string" || !(CARD_CLASH_ACTION_TYPES as readonly string[]).includes(type)) return undefined;
  if (!isValidRequestId(requestId)) return undefined;
  if (!isValidVersion(expectedVersion)) return undefined;
  const actionType = type as CardClashActionType;

  if (actionType === "discard_cards") {
    if (targetSeat !== undefined) return undefined; // forbidden for this action
    if (!Array.isArray(cardIds) || cardIds.length === 0 || cardIds.length > 20 || !cardIds.every(isValidCardId)) {
      return undefined;
    }
    return { requestId, expectedVersion, action: { type: "discard_cards", cardIds } };
  }
  if (cardIds !== undefined) return undefined; // forbidden for every other action

  if (SEAT_TARGETED_ACTIONS.has(actionType)) {
    if (!isValidSeat(targetSeat)) return undefined;
    return { requestId, expectedVersion, action: { type: actionType, targetSeat } as ParsedCardClashAction };
  }
  if (targetSeat !== undefined) return undefined; // forbidden when not required

  return { requestId, expectedVersion, action: { type: actionType } as ParsedCardClashAction };
}

export type CardClashTransitionResult = { readonly ok: true; readonly state: MatchState } | { readonly ok: false; readonly reason: unknown };
export type CardClashTransitionFn = (state: MatchState) => CardClashTransitionResult;

// Builds the ONE trusted transition function for this request — the only
// thing db.ts's applyCardClashTransition ever calls to compute the next
// state. `seat` is always the caller's own, server-resolved seat (never
// client-supplied); every engine call below is the exact existing
// function, never duplicated or reimplemented.
export function buildCardClashTransition(action: ParsedCardClashAction, seat: Seat, expectedVersion: number): CardClashTransitionFn {
  switch (action.type) {
    case "play_attack":
      return (state) => playAttack(state, seat, action.targetSeat, expectedVersion);
    case "respond_dodge":
      return (state) => respondToAttack(state, seat, { type: "dodge" }, expectedVersion);
    case "decline_attack_response":
      return (state) => respondToAttack(state, seat, { type: "decline" }, expectedVersion);
    case "play_heal":
      return (state) => playHeal(state, seat, expectedVersion);
    case "play_seize":
      return (state) => playSeize(state, seat, action.targetSeat, expectedVersion);
    case "play_disarm":
      return (state) => playDisarm(state, seat, action.targetSeat, expectedVersion);
    case "play_insight":
      return (state) => playInsight(state, seat, expectedVersion);
    case "play_war_cry":
      return (state) => playGroupCard(state, seat, "war_cry", expectedVersion);
    case "play_arrow_volley":
      return (state) => playGroupCard(state, seat, "arrow_volley", expectedVersion);
    case "respond_group_attack":
      return (state) => respondToGroupEffect(state, seat, { type: "attack" }, expectedVersion);
    case "respond_group_dodge":
      return (state) => respondToGroupEffect(state, seat, { type: "dodge" }, expectedVersion);
    case "decline_group_response":
      return (state) => respondToGroupEffect(state, seat, { type: "decline" }, expectedVersion);
    case "rescue_heal":
      return (state) => respondToRescue(state, seat, { type: "heal" }, expectedVersion);
    case "decline_rescue":
      return (state) => respondToRescue(state, seat, { type: "decline" }, expectedVersion);
    case "end_turn":
      // endTurn/discardCards take no expectedVersion parameter of their
      // own (a D1A design predating this convention) — this is safe
      // because db.ts's applyCardClashTransition already checks
      // expectedVersion against the persisted row BEFORE ever invoking
      // this transition, so stale requests are rejected uniformly across
      // every action type regardless of this engine-level difference.
      return (state) => endTurn(state, seat);
    case "discard_cards":
      return (state) => discardCards(state, seat, action.cardIds);
  }
}
