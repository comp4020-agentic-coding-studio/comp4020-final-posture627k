// Server-side (non-pure) glue between Card Clash's durable, versioned
// deadlines (db.ts, card-clash/timers.ts) and a lightweight in-process
// wake-up mechanism plus the existing room-scoped SSE hub
// (card-clash/realtime.ts). D4C-1.
//
// SQLite's card_clash_deadlines table (via db.ts) is the ONLY authoritative
// record of a match's next actionable deadline — everything in this module
// is just "wake up at roughly the right time and re-check it", never a
// second source of truth. A real `setTimeout` firing late, firing twice, or
// never firing at all (the process was asleep or the Fly machine was
// stopped — docs/card-clash-rules.md §11's own documented constraint) is
// always safe: db.ts's processCardClashTimeout only ever actually changes
// anything if the persisted deadline is still exactly the version it was
// scheduled for and is genuinely due as of the clock it's given.
import {
  getCardClashDeadline,
  getCardClashMatchById,
  listActiveCardClashDeadlineMatches,
  processCardClashTimeout,
  type PersistedCardClashMatch,
} from "../db.ts";
import { publishCardClashRoomEvent } from "./realtime.ts";
import type { Seat } from "./types.ts";

export interface ScheduledCardClashDeadline {
  readonly version: number;
  readonly expiresAt: number;
  readonly responderSeat: Seat;
}

// matchId -> the one live real timer for it. Never more than one per match:
// rescheduleCardClashTimer always cancels any existing timer first (docs
// §6 "clean up old timers when deadlines are replaced").
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function cancelCardClashTimer(matchId: number): void {
  const existing = timers.get(matchId);
  if (existing) clearTimeout(existing);
  timers.delete(matchId);
}

// Arms (or, if `deadline` is null, simply cancels) the single real
// wall-clock timer for `matchId` to match whatever the database now says is
// current. `nowMs` is the caller's own already-captured time — never
// re-read here — so a test driving this with a fake clock never races a
// real one, and the resulting `setTimeout` delay is always relative to
// whatever "now" the caller actually means.
export function rescheduleCardClashTimer(
  matchId: number,
  roomId: number,
  deadline: ScheduledCardClashDeadline | null,
  nowMs: number,
): void {
  cancelCardClashTimer(matchId);
  if (!deadline) return;

  const delayMs = Math.max(0, deadline.expiresAt - nowMs);
  const timer = setTimeout(() => {
    runCardClashTimeoutCheck(matchId, roomId, deadline.version, Date.now());
  }, delayMs);
  // Never keeps the process alive on its own — matches this project's
  // existing SSE heartbeat convention of being a pure convenience, not a
  // keep-alive. Not every Node timer type exposes unref (tests sometimes
  // run against mocked timers), so this is defensive.
  (timer as { unref?: () => void }).unref?.();
  timers.set(matchId, timer);
}

function toScheduled(
  match: PersistedCardClashMatch | undefined,
  deadline: { readonly responderSeat: Seat; readonly expiresAt: number } | null,
): ScheduledCardClashDeadline | null {
  return deadline && match ? { version: match.version, expiresAt: deadline.expiresAt, responderSeat: deadline.responderSeat } : null;
}

// The one entry point a real timer callback (or a test standing in for one)
// ever calls: re-reads authoritative state, applies the exact legal timeout
// transition if (and only if) the persisted deadline is still this exact
// version and genuinely due, publishes exactly one SSE invalidation if the
// match state actually changed, and re-arms the next real timer from
// whatever the database now says is current. Safe to call with a stale
// `expectedVersion` (a duplicate or obsolete callback) — db.ts's
// processCardClashTimeout treats that as a no-op and this never publishes
// or reports "applied" for a no-op.
export function runCardClashTimeoutCheck(matchId: number, roomId: number, expectedVersion: number, nowMs: number): boolean {
  const result = processCardClashTimeout(matchId, expectedVersion, nowMs);
  if (result.applied) {
    publishCardClashRoomEvent(roomId, "match");
  }
  rescheduleCardClashTimer(matchId, roomId, toScheduled(result.match, result.nextDeadline), nowMs);
  return result.applied;
}

export interface ReconcileResult {
  readonly applied: boolean;
  readonly match: PersistedCardClashMatch;
  readonly deadline: ScheduledCardClashDeadline | null;
}

// Loops applying processCardClashTimeout while the persisted deadline is
// still due as of `nowMs` — covers a match that fell behind while the
// process was stopped or asleep (docs §11 "reconcile any already-expired
// deadline... rather than leaving the match silently stuck"; the Fly
// machine may have been stopped entirely). Bounded by maxSteps so a genuine
// logic problem can never spin forever: a single real gap in wall-clock
// time, however long, is still just a short, finite chain of individual
// legal timeout transitions (one end-turn, one decline, etc.) applied in
// order. Never sets a new deadline merely because this was called — it
// only ever acts when the EXISTING persisted deadline is actually overdue.
export function reconcileCardClashMatchIfOverdue(matchId: number, roomId: number, nowMs: number, maxSteps = 20): ReconcileResult {
  let match = getCardClashMatchById(matchId)!;
  let deadline = getCardClashDeadline(matchId);
  let appliedAny = false;

  for (let step = 0; step < maxSteps && deadline !== undefined && deadline.expiresAt <= nowMs; step++) {
    const result = processCardClashTimeout(matchId, deadline.version, nowMs);
    if (result.match) match = result.match;
    if (!result.applied) {
      deadline = result.nextDeadline && result.match ? { ...result.nextDeadline, matchId, version: result.match.version } : undefined;
      break; // a no-op step means nothing further can change at this version — stop rather than loop forever
    }
    appliedAny = true;
    deadline = result.nextDeadline && result.match ? { ...result.nextDeadline, matchId, version: result.match.version } : undefined;
  }

  if (appliedAny) publishCardClashRoomEvent(roomId, "match");
  const scheduled = toScheduled(match, deadline ?? null);
  rescheduleCardClashTimer(matchId, roomId, scheduled, nowMs);
  return { applied: appliedAny, match, deadline: scheduled };
}

// Startup-only: re-arms every match that currently has a live deadline —
// whether it is already overdue (a full process restart, not just a
// stopped Fly machine) or still pending (a restart before any deadline
// expired, which otherwise would have no real timer at all until the next
// HTTP request happened to touch that match). docs §11 "on restart... the
// server must resume and reconcile any deadline that already expired".
export function reconcileAllCardClashMatchesOnStartup(nowMs: number = Date.now()): void {
  for (const { matchId, roomId } of listActiveCardClashDeadlineMatches()) {
    reconcileCardClashMatchIfOverdue(matchId, roomId, nowMs);
  }
}
