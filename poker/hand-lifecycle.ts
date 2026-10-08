// Pure decision helpers for progressing a hand through its lifecycle, built
// on top of poker/betting.ts and poker/settlement.ts without duplicating
// either's rules. No HTTP, SQLite, deck, or clock dependency — card
// revelation itself stays a read-time reconstruction from a persisted deck
// order plus street (see db.ts's getCommunityCards), not this module's
// concern.
//
// This module answers exactly two questions a transactional persistence
// layer needs after applying a betting action: "should the hand
// automatically move to the next street right now?" and "is the hand now
// ready to be settled?" — both purely from the betting engine's own state,
// which already distinguishes a completed betting ROUND from a completed
// HAND (see poker/betting.ts's isBettingComplete vs. handOutcome).

import type { HeadsUpBettingState, Street } from "./betting.ts";
import { isHandTerminal } from "./settlement.ts";

const STREET_ORDER: readonly Street[] = ["preflop", "flop", "turn", "river"];

export function nextStreet(current: Street): Street | undefined {
  return STREET_ORDER[STREET_ORDER.indexOf(current) + 1];
}

// True exactly when the current street's betting is finished, the hand
// wasn't ended by a fold, and there is a further street left to deal. This
// is the same condition whether the round ended normally (everyone acted
// and matched) or because an all-in capped further betting entirely (a
// "runout") — either way, the next street must be dealt automatically,
// with no extra player action required and no phantom betting round
// created for a street nobody can actually bet on.
export function shouldAdvanceStreet(state: HeadsUpBettingState): boolean {
  return state.isBettingComplete && state.handOutcome !== "uncontested" && nextStreet(state.street) !== undefined;
}

// Re-exported under the lifecycle-facing name used by callers that are
// asking "is this hand done," rather than importing settlement-specific
// vocabulary directly — the underlying rule is owned by poker/settlement.ts
// and is never duplicated here.
export const isReadyForSettlement = isHandTerminal;
