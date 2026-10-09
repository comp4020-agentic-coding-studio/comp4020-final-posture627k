// Combat, defensive responses, and dying rescue for Card Clash (D1B).
// Builds on card-clash/engine.ts's turn/draw/discard foundation without
// rewriting it — every function here is a pure MatchState -> MatchState
// transition, exactly like engine.ts's own. See docs/card-clash-rules.md
// §2-§4 (and their v2.6 timer notes in §11, deliberately NOT implemented
// here — see that file's own disclaimer) for the rules this must match.
//
// Deferred to D2, not implemented here: Seize, Disarm, War Cry, Arrow
// Volley, Insight, and any multi-target response queue.

import { normalAttackLimitForSeat, SEATS_BY_MODE } from "./engine.ts";
import type { MatchState, PublicEvent, Seat, Team } from "./types.ts";

// Counterclockwise rescue order for a seat that just reached 0 HP: the
// nearest living counterclockwise neighbor first, continuing
// counterclockwise through every other living seat, with the dying seat
// itself always last (docs/card-clash-rules.md §4). "Counterclockwise" is
// simply the reverse of SEATS_BY_MODE's fixed clockwise order.
function computeRescueOrder(state: MatchState, dyingSeat: Seat): Seat[] {
  const order = SEATS_BY_MODE[state.mode];
  const n = order.length;
  const dyingIndex = order.indexOf(dyingSeat);
  const others: Seat[] = [];
  for (let step = 1; step < n; step++) {
    const seat = order[(((dyingIndex - step) % n) + n) % n]!;
    if (!state.players.get(seat)!.eliminated) others.push(seat);
  }
  return [...others, dyingSeat];
}

// A team wins the instant every OTHER team still has at least one living
// member and exactly one team's living-member set remains — this single
// rule, applied uniformly, is "last player standing" for 1v1 (each seat is
// its own team), "host vs the other two" for 1v2, and "both teammates
// eliminated" for 2v2 (docs/card-clash-rules.md §5), with no mode-specific
// branching needed.
function winningTeamIfOver(state: MatchState): Team | undefined {
  const livingTeams = new Set<Team>();
  for (const player of state.players.values()) {
    if (!player.eliminated) livingTeams.add(player.team);
  }
  return livingTeams.size === 1 ? [...livingTeams][0] : undefined;
}

// Marks `seat` eliminated (hp clamped to 0, `eliminated: true`) and, if
// that leaves only one team with living members, sets the terminal
// matchResult — both logged publicly. Never called for a seat that is
// already eliminated (dying/rescue only ever targets a currently-living
// seat whose hp just reached 0).
function eliminateSeat(state: MatchState, seat: Seat): MatchState {
  const players = new Map(state.players);
  players.set(seat, { ...players.get(seat)!, eliminated: true, hp: 0 });

  const log: PublicEvent[] = [...state.publicLog, { type: "eliminated", seat }];
  let next: MatchState = { ...state, players, publicLog: log };

  const winningTeam = winningTeamIfOver(next);
  if (winningTeam) {
    next = {
      ...next,
      matchResult: { status: "complete", winningTeam },
      publicLog: [...next.publicLog, { type: "match_complete", winningTeam }],
    };
  }
  return next;
}

// --- Attack -----------------------------------------------------------

export type PlayAttackResult =
  | { readonly ok: true; readonly state: MatchState }
  | {
      readonly ok: false;
      readonly reason:
        | "match_complete"
        | "response_pending"
        | "not_active_seat"
        | "stale_version"
        | "card_not_in_hand"
        | "cannot_target_self"
        | "invalid_target"
        | "attack_limit_reached";
    };

// Plays a normal Attack: removes it from the attacker's hand, reveals it
// publicly, and opens a pending attack-response for `target` — damage is
// NOT applied yet (docs §1/§2: "do not immediately damage the target
// before the response is resolved"). The attacker cannot act again until
// respondToAttack (and, if it goes that far, the dying-rescue sequence)
// resolves.
export function playAttack(state: MatchState, seat: Seat, target: Seat, expectedVersion: number): PlayAttackResult {
  if (state.matchResult.status === "complete") return { ok: false, reason: "match_complete" };
  if (state.pending !== undefined) return { ok: false, reason: "response_pending" };
  if (seat !== state.activeSeat) return { ok: false, reason: "not_active_seat" };
  if (expectedVersion !== state.version) return { ok: false, reason: "stale_version" };
  if (target === seat) return { ok: false, reason: "cannot_target_self" };

  const targetPlayer = state.players.get(target);
  if (!targetPlayer || targetPlayer.eliminated) return { ok: false, reason: "invalid_target" };

  if (state.normalAttacksUsedThisTurn >= normalAttackLimitForSeat(state.mode, seat)) {
    return { ok: false, reason: "attack_limit_reached" };
  }

  const attacker = state.players.get(seat)!;
  const attackCard = attacker.hand.find((c) => c.type === "attack");
  if (!attackCard) return { ok: false, reason: "card_not_in_hand" };

  const players = new Map(state.players);
  players.set(seat, { ...attacker, hand: attacker.hand.filter((c) => c.id !== attackCard.id) });

  return {
    ok: true,
    state: {
      ...state,
      players,
      discardPile: [...state.discardPile, attackCard],
      normalAttacksUsedThisTurn: state.normalAttacksUsedThisTurn + 1,
      pending: { kind: "attack_response", attacker: seat, target },
      publicLog: [...state.publicLog, { type: "attack_played", actor: seat, target }],
      version: state.version + 1,
    },
  };
}

// --- Attack response: Dodge or decline ---------------------------------

export type RespondToAttackResult =
  | { readonly ok: true; readonly state: MatchState }
  | {
      readonly ok: false;
      readonly reason: "match_complete" | "no_pending_attack_response" | "not_the_responder" | "stale_version" | "card_not_in_hand";
    };

// Only the targeted seat may respond, and only with Dodge (consuming a
// Dodge card, no damage) or an explicit decline (1 damage). A decline that
// brings the target to 0 HP opens the dying-rescue sequence instead of
// eliminating them immediately (docs §1/§4); otherwise control returns to
// the attacker's MAIN phase (pending cleared, activeSeat already theirs).
export function respondToAttack(
  state: MatchState,
  seat: Seat,
  action: { readonly type: "dodge" } | { readonly type: "decline" },
  expectedVersion: number,
): RespondToAttackResult {
  if (state.matchResult.status === "complete") return { ok: false, reason: "match_complete" };
  if (state.pending?.kind !== "attack_response") return { ok: false, reason: "no_pending_attack_response" };
  if (seat !== state.pending.target) return { ok: false, reason: "not_the_responder" };
  if (expectedVersion !== state.version) return { ok: false, reason: "stale_version" };

  const { attacker, target } = state.pending;
  const defender = state.players.get(target)!;

  if (action.type === "dodge") {
    const dodgeCard = defender.hand.find((c) => c.type === "dodge");
    if (!dodgeCard) return { ok: false, reason: "card_not_in_hand" };

    const players = new Map(state.players);
    players.set(target, { ...defender, hand: defender.hand.filter((c) => c.id !== dodgeCard.id) });

    return {
      ok: true,
      state: {
        ...state,
        players,
        discardPile: [...state.discardPile, dodgeCard],
        pending: undefined,
        publicLog: [...state.publicLog, { type: "dodge_played", actor: target }],
        version: state.version + 1,
      },
    };
  }

  const newHp = defender.hp - 1;
  const players = new Map(state.players);
  players.set(target, { ...defender, hp: Math.max(newHp, 0) });

  let next: MatchState = {
    ...state,
    players,
    publicLog: [...state.publicLog, { type: "attack_response_declined", actor: target }],
    version: state.version + 1,
  };

  next =
    newHp <= 0
      ? { ...next, pending: { kind: "dying_rescue", dyingSeat: target, queue: computeRescueOrder(next, target), resumeActiveSeat: attacker } }
      : { ...next, pending: undefined };

  return { ok: true, state: next };
}

// --- Proactive Heal (self only) -----------------------------------------

export type PlayHealResult =
  | { readonly ok: true; readonly state: MatchState }
  | {
      readonly ok: false;
      readonly reason: "match_complete" | "response_pending" | "not_active_seat" | "stale_version" | "card_not_in_hand" | "already_at_max_hp";
    };

// The active player may only proactively Heal themself (docs §3 — a
// living teammate at 1-2 HP cannot be proactively healed by someone else;
// the only path to healing another player is the dying-rescue Heal below).
export function playHeal(state: MatchState, seat: Seat, expectedVersion: number): PlayHealResult {
  if (state.matchResult.status === "complete") return { ok: false, reason: "match_complete" };
  if (state.pending !== undefined) return { ok: false, reason: "response_pending" };
  if (seat !== state.activeSeat) return { ok: false, reason: "not_active_seat" };
  if (expectedVersion !== state.version) return { ok: false, reason: "stale_version" };

  const player = state.players.get(seat)!;
  if (player.hp >= player.maxHp) return { ok: false, reason: "already_at_max_hp" };
  const healCard = player.hand.find((c) => c.type === "heal");
  if (!healCard) return { ok: false, reason: "card_not_in_hand" };

  const players = new Map(state.players);
  players.set(seat, {
    ...player,
    hp: Math.min(player.hp + 1, player.maxHp),
    hand: player.hand.filter((c) => c.id !== healCard.id),
  });

  return {
    ok: true,
    state: {
      ...state,
      players,
      discardPile: [...state.discardPile, healCard],
      publicLog: [...state.publicLog, { type: "heal_played", actor: seat, target: seat }],
      version: state.version + 1,
    },
  };
}

// --- Dying rescue response: Heal or decline -----------------------------

export type RespondToRescueResult =
  | { readonly ok: true; readonly state: MatchState }
  | {
      readonly ok: false;
      readonly reason: "match_complete" | "no_pending_rescue" | "not_the_responder" | "stale_version" | "card_not_in_hand";
    };

// Only the current queue[0] responder may act (docs §4) — enemies and
// teammates alike are eligible, and the dying seat is always asked last,
// including the option to self-rescue. A successful Heal restores exactly
// 1 HP (to 1, since the dying player is always at exactly 0) and ends the
// sequence immediately; a decline (or no Heal card, submitted as an
// explicit decline) advances to the next queued responder, or — if the
// dying seat itself was last and declined — eliminates them and checks for
// match completion.
export function respondToRescue(
  state: MatchState,
  seat: Seat,
  action: { readonly type: "heal" } | { readonly type: "decline" },
  expectedVersion: number,
): RespondToRescueResult {
  if (state.matchResult.status === "complete") return { ok: false, reason: "match_complete" };
  if (state.pending?.kind !== "dying_rescue") return { ok: false, reason: "no_pending_rescue" };
  const { dyingSeat, queue, resumeActiveSeat } = state.pending;
  if (seat !== queue[0]) return { ok: false, reason: "not_the_responder" };
  if (expectedVersion !== state.version) return { ok: false, reason: "stale_version" };

  if (action.type === "heal") {
    const responder = state.players.get(seat)!;
    const healCard = responder.hand.find((c) => c.type === "heal");
    if (!healCard) return { ok: false, reason: "card_not_in_hand" };

    const players = new Map(state.players);
    if (seat === dyingSeat) {
      // Self-rescue: one record takes both the HP restore and the spent card.
      players.set(dyingSeat, { ...responder, hp: 1, hand: responder.hand.filter((c) => c.id !== healCard.id) });
    } else {
      players.set(dyingSeat, { ...players.get(dyingSeat)!, hp: 1 });
      players.set(seat, { ...responder, hand: responder.hand.filter((c) => c.id !== healCard.id) });
    }

    return {
      ok: true,
      state: {
        ...state,
        players,
        discardPile: [...state.discardPile, healCard],
        pending: undefined,
        activeSeat: resumeActiveSeat,
        publicLog: [...state.publicLog, { type: "heal_played", actor: seat, target: dyingSeat }],
        version: state.version + 1,
      },
    };
  }

  const afterDecline: MatchState = {
    ...state,
    publicLog: [...state.publicLog, { type: "rescue_declined", actor: seat }],
    version: state.version + 1,
  };

  const remaining = queue.slice(1);
  if (remaining.length > 0) {
    return {
      ok: true,
      state: { ...afterDecline, pending: { kind: "dying_rescue", dyingSeat, queue: remaining, resumeActiveSeat } },
    };
  }

  // The dying seat's own last chance (always the final queue entry) was
  // declined: nobody rescued them.
  const eliminated = eliminateSeat({ ...afterDecline, pending: undefined }, dyingSeat);
  const matchStillOngoing = eliminated.matchResult.status === "ongoing";
  return { ok: true, state: matchStillOngoing ? { ...eliminated, activeSeat: resumeActiveSeat } : eliminated };
}
