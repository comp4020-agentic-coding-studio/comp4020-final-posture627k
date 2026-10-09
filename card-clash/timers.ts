// Pure server-authoritative deadline logic for Card Clash's v2.6 10-second
// action/response timers (docs/card-clash-rules.md §11). No HTTP, no
// SQLite, no real wall-clock access, no process-global state — exactly the
// same discipline as engine.ts/combat.ts/group-effects.ts: every exported
// function is a pure function of (MatchState, an already-captured `nowMs`),
// never `Date.now()` itself, so tests can simulate any elapsed time
// deterministically. See db.ts for how these are persisted durably and
// card-clash/scheduler.ts for the real-timer/SSE wiring built on top.
//
// Deliberately NOT here (D4C-1 scope, docs §11's own "Discard-phase
// timeout" note): any automatic/random discard when a MAIN timeout leaves
// the active player's hand over their current-HP limit. That case is
// recognized below (computeNextCardClashDeadline returns null for it, the
// same as a terminal match) but never resolved on its own — a human
// decision is still required before any such policy exists.

import { autoDiscardAndAdvance, endMainPhase } from "./turn-flow.ts";
import type { RandomInt } from "./deck.ts";
import { respondToAttack, respondToRescue } from "./combat.ts";
import { respondToGroupEffect } from "./group-effects.ts";
import type { MatchState, Seat } from "./types.ts";

export const CARD_CLASH_DEADLINE_MS = 10_000;

export interface CardClashDeadlineInfo {
  readonly responderSeat: Seat;
  readonly expiresAt: number;
}

// The single source of truth for "what deadline applies to this state right
// now" — called after EVERY successful transition (a normal action or a
// timeout's own follow-up), never only for one action type, so every case
// in docs §11 (fresh MAIN period after a resolved card, a response's own
//10s window, each group/rescue responder getting their own fresh window)
// falls out of this one rule rather than needing per-action special-casing.
// Returns null when no timer should run right now: the match is over, or
// the active player's hand already exceeds their current-HP limit (the
// unresolved DISCARD block above — docs §11's open decision).
export function computeNextCardClashDeadline(
  state: MatchState,
  nowMs: number,
  // Supplied only when a DISCARD phase continues across a transition
  // (partial manual discard): its single absolute deadline is preserved.
  preserveDiscardDeadline?: CardClashDeadlineInfo,
): CardClashDeadlineInfo | null {
  if (state.matchResult.status === "complete") return null;

  const pending = state.pending;
  if (pending === undefined) {
    if (state.turnPhase === "discard" && preserveDiscardDeadline && preserveDiscardDeadline.responderSeat === state.activeSeat) {
      return preserveDiscardDeadline;
    }
    return { responderSeat: state.activeSeat, expiresAt: nowMs + CARD_CLASH_DEADLINE_MS };
  }
  if (pending.kind === "attack_response") {
    return { responderSeat: pending.target, expiresAt: nowMs + CARD_CLASH_DEADLINE_MS };
  }
  if (pending.kind === "group_response") {
    return { responderSeat: pending.context.queue[0]!, expiresAt: nowMs + CARD_CLASH_DEADLINE_MS };
  }
  return { responderSeat: pending.queue[0]!, expiresAt: nowMs + CARD_CLASH_DEADLINE_MS };
}

export interface CardClashTimeoutOutcome {
  // Whether the engine's own MatchState actually changed. False for the
  // DISCARD-block no-op above (endTurn correctly refuses, nothing is
  // forced) — callers must treat `changed: false` as "nothing happened",
  // never apply damage/advance a turn, and never broadcast it as if it
  // were a real event.
  readonly changed: boolean;
  readonly state: MatchState;
}

// Executes the ONE legal automatic timeout transition for whatever phase
// `state` is currently in, as the specific decline/end-turn docs §11
// requires — never a client-authorized action, never a reimplementation of
// engine/combat/group-effects' own rules. `responderSeat` is the seat the
// persisted deadline names as the current responder (db.ts only calls this
// after confirming that deadline is still current for this exact state);
// if it has somehow drifted from the state's own authorized responder this
// is treated as a no-op rather than silently acting for the wrong seat.
export function applyCardClashTimeoutTransition(state: MatchState, responderSeat: Seat, randomSource?: RandomInt): CardClashTimeoutOutcome {
  if (state.matchResult.status === "complete") return { changed: false, state };

  const pending = state.pending;

  if (pending === undefined) {
    if (state.activeSeat !== responderSeat) return { changed: false, state };
    // MAIN timeout: end the action phase (advance, or enter DISCARD). DISCARD
    // timeout: randomly discard exactly the excess, then advance.
    const result =
      state.turnPhase === "discard"
        ? autoDiscardAndAdvance(state, state.activeSeat, randomSource)
        : endMainPhase(state, state.activeSeat, randomSource);
    return result.ok ? { changed: true, state: result.state } : { changed: false, state };
  }

  if (pending.kind === "attack_response") {
    if (pending.target !== responderSeat) return { changed: false, state };
    const result = respondToAttack(state, pending.target, { type: "decline" }, state.version);
    return result.ok ? { changed: true, state: result.state } : { changed: false, state };
  }

  if (pending.kind === "group_response") {
    const nextResponder = pending.context.queue[0]!;
    if (nextResponder !== responderSeat) return { changed: false, state };
    const result = respondToGroupEffect(state, nextResponder, { type: "decline" }, state.version);
    return result.ok ? { changed: true, state: result.state } : { changed: false, state };
  }

  const nextResponder = pending.queue[0]!;
  if (nextResponder !== responderSeat) return { changed: false, state };
  const result = respondToRescue(state, nextResponder, { type: "decline" }, state.version);
  return result.ok ? { changed: true, state: result.state } : { changed: false, state };
}
