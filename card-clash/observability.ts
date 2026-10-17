// Server-only, allowlisted operational records. Never serialize a request,
// response, match, hand, token, or arbitrary extra fields into logs.
import type { CardClashActionType } from "./action-http.ts";

export interface CardClashAuditEvent {
  readonly actor: "player" | "system";
  readonly participant?: string | null;
  readonly room?: string | null;
  readonly roomId?: number | null;
  readonly matchId?: number | null;
  readonly seat?: number | null;
  readonly action: CardClashActionType | "create_room" | "join_room" | "set_ready" | "start_match" | "action" | "timeout";
  readonly outcome: "accepted" | "duplicate" | "rejected" | "error";
  readonly status?: number | null;
  readonly reason?: string | null;
  readonly versionBefore?: number | null;
  readonly versionAfter?: number | null;
  readonly ready?: boolean | null;
  readonly source?: "http" | "timer" | "reconcile";
}

export function logCardClashEvent(event: CardClashAuditEvent): void {
  // Explicit projection prevents accidental leakage through spread arguments.
  // A failed log sink must not turn an already committed action into an error.
  try {
    console.info(JSON.stringify({
      event: "card_clash_action",
      at: new Date().toISOString(),
      actor: event.actor,
      participant: event.participant ?? null,
      room: event.room ?? null,
      roomId: event.roomId ?? null,
      matchId: event.matchId ?? null,
      seat: event.seat ?? null,
      action: event.action,
      outcome: event.outcome,
      status: event.status ?? null,
      reason: event.reason ?? null,
      versionBefore: event.versionBefore ?? null,
      versionAfter: event.versionAfter ?? null,
      ready: event.ready ?? null,
      source: event.source ?? "http",
    }));
  } catch { /* Logging cannot change game outcomes. */ }
}
