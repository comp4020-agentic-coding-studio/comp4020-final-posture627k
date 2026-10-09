// Pure turn-progression engine for Card Clash: initialization, drawing
// (with automatic deck replenishment), manual discarding, and turn
// advancement. No HTTP, no SQLite, no SSE, no card effects, no pending
// responses, no rescue logic, no timers — see docs/card-clash-rules.md
// (D1A scope note at the top) for what is deliberately not here yet.
//
// Every exported function is a pure state transition: given a MatchState
// (and, for functions that may shuffle, an optional injectable
// RandomInt), it returns a brand-new MatchState rather than mutating its
// input — there is no process-global mutable match state anywhere in this
// module.

import type { Card } from "./cards.ts";
import { shuffleNewDeck, type RandomInt } from "./deck.ts";
import type { GameMode, MatchState, PlayerState, Seat, Team } from "./types.ts";

// Fixed, clockwise seat order per mode — docs/card-clash-rules.md §1.
export const SEATS_BY_MODE: Readonly<Record<GameMode, readonly Seat[]>> = {
  "1v1": [1, 2],
  "1v2": [1, 2, 3],
  "2v2": [1, 2, 3, 4],
};

export function teamForSeat(mode: GameMode, seat: Seat): Team {
  if (mode === "2v2") return seat === 1 || seat === 4 ? "A" : "B";
  return seat === 1 ? "A" : "B"; // 1v1: 1 vs 2; 1v2: host(1) vs allies(2,3)
}

export function maxHpForSeat(mode: GameMode, seat: Seat): number {
  return mode === "1v2" && seat === 1 ? 5 : 3;
}

export function initialHandSizeForSeat(mode: GameMode, seat: Seat): number {
  return mode === "2v2" && seat === 4 ? 5 : 4;
}

// How many cards `seat` draws at the start of their OWN turn.
// `isFirstTurn` is that seat's own (negated) hasTakenFirstTurn flag — the
// only seat/mode combination this changes is 2v2 seat 1's one-time
// exception (docs/card-clash-rules.md §1).
export function drawCountForSeat(mode: GameMode, seat: Seat, isFirstTurn: boolean): number {
  if (mode === "1v2" && seat === 1) return 3; // host always draws 3
  if (mode === "2v2" && seat === 1 && isFirstTurn) return 1;
  return 2;
}

function nextLivingSeat(state: MatchState, from: Seat): Seat {
  const order = SEATS_BY_MODE[state.mode];
  const startIndex = order.indexOf(from);
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(startIndex + step) % order.length]!;
    if (!state.players.get(candidate)!.eliminated) return candidate;
  }
  // Unreachable while at least two players remain, which every real match
  // always has in this slice (no elimination logic exists yet) — surfaced
  // loudly rather than silently looping forever if that invariant is ever
  // violated by a future slice.
  throw new Error("nextLivingSeat found no living seat to advance to");
}

// Draws `count` cards for `seat`, replenishing with a completely new,
// freshly shuffled 64-card deck (never recycling the discard pile) as many
// times as needed to satisfy the request in one atomic step — see
// docs/card-clash-rules.md §6's "a multi-card draw crossing the deck
// boundary must complete correctly".
function drawInternal(state: MatchState, seat: Seat, count: number, randomSource?: RandomInt): MatchState {
  const drawPile = [...state.drawPile];
  let deckGeneration = state.deckGeneration;
  const drawn: Card[] = [];

  for (let i = 0; i < count; i++) {
    if (drawPile.length === 0) {
      deckGeneration += 1;
      drawPile.push(...shuffleNewDeck(deckGeneration, randomSource));
    }
    drawn.push(drawPile.shift()!);
  }

  const player = state.players.get(seat)!;
  const players = new Map(state.players);
  players.set(seat, { ...player, hand: [...player.hand, ...drawn] });

  return { ...state, players, drawPile, deckGeneration };
}

// Performs `seat`'s own turn-start draw phase and marks their first-turn
// flag consumed. Internal: only initializeMatch (bootstrapping seat 1) and
// endTurn (advancing to the next seat) ever call this, and always for the
// seat that is becoming active right now.
function beginTurnDraw(state: MatchState, seat: Seat, randomSource?: RandomInt): MatchState {
  const before = state.players.get(seat)!;
  const drawn = drawInternal(state, seat, drawCountForSeat(state.mode, seat, !before.hasTakenFirstTurn), randomSource);
  const players = new Map(drawn.players);
  players.set(seat, { ...players.get(seat)!, hasTakenFirstTurn: true });
  return { ...drawn, players, activeSeat: seat };
}

export interface InitializeMatchOptions {
  readonly mode: GameMode;
  readonly randomSource?: RandomInt;
}

// Builds a brand-new match: deals each seat its initial hand (docs §1),
// then immediately performs seat 1's own first-turn draw phase, so the
// returned state is already "seat 1's turn, cards drawn, ready to act" —
// the same shape every subsequent endTurn() call produces for whichever
// seat it advances to.
export function initializeMatch(options: InitializeMatchOptions): MatchState {
  const { mode, randomSource } = options;
  const seats = SEATS_BY_MODE[mode];

  let drawPile = shuffleNewDeck(1, randomSource);
  const players = new Map<Seat, PlayerState>();

  for (const seat of seats) {
    const handSize = initialHandSizeForSeat(mode, seat);
    const hand = drawPile.slice(0, handSize);
    drawPile = drawPile.slice(handSize);
    const maxHp = maxHpForSeat(mode, seat);
    players.set(seat, {
      seat,
      team: teamForSeat(mode, seat),
      maxHp,
      hp: maxHp,
      eliminated: false,
      hand,
      hasTakenFirstTurn: false,
    });
  }

  const dealt: MatchState = {
    mode,
    players,
    activeSeat: seats[0]!, // seat 1 (host) is always first — docs §1
    drawPile,
    discardPile: [],
    deckGeneration: 1,
  };

  return beginTurnDraw(dealt, seats[0]!, randomSource);
}

export type DiscardResult =
  | { readonly ok: true; readonly state: MatchState }
  | { readonly ok: false; readonly reason: "not_active_seat" | "card_not_in_hand" };

// Voluntary discard by the active player (docs §3 step 4 / §5) — never
// automatic or random; see docs §11's open discard-timeout decision for
// why no timed/forced variant exists. Every named card id must actually be
// in the acting seat's own current hand, or nothing is discarded.
export function discardCards(state: MatchState, seat: Seat, cardIds: readonly string[]): DiscardResult {
  if (seat !== state.activeSeat) {
    return { ok: false, reason: "not_active_seat" };
  }
  const player = state.players.get(seat)!;
  const handIds = new Set(player.hand.map((c) => c.id));
  if (!cardIds.every((id) => handIds.has(id))) {
    return { ok: false, reason: "card_not_in_hand" };
  }

  const idsToDiscard = new Set(cardIds);
  const players = new Map(state.players);
  players.set(seat, { ...player, hand: player.hand.filter((c) => !idsToDiscard.has(c.id)) });
  const discarded = player.hand.filter((c) => idsToDiscard.has(c.id));

  return { ok: true, state: { ...state, players, discardPile: [...state.discardPile, ...discarded] } };
}

export type EndTurnResult =
  | { readonly ok: true; readonly state: MatchState }
  | { readonly ok: false; readonly reason: "not_active_seat" | "hand_exceeds_hp_limit" };

// Ends `seat`'s turn: enforces the end-of-turn hand-size limit (current
// HP, not max HP — docs §5), advances to the next living seat, and
// performs that seat's own draw phase — one call fully transitions one
// turn boundary. Rejects, with no mutation, if the hand limit isn't met;
// the caller must discardCards() first.
export function endTurn(state: MatchState, seat: Seat, randomSource?: RandomInt): EndTurnResult {
  if (seat !== state.activeSeat) {
    return { ok: false, reason: "not_active_seat" };
  }
  const player = state.players.get(seat)!;
  if (player.hand.length > player.hp) {
    return { ok: false, reason: "hand_exceeds_hp_limit" };
  }

  return { ok: true, state: beginTurnDraw(state, nextLivingSeat(state, seat), randomSource) };
}
