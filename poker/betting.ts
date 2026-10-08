// Pure, HTTP/SQLite/SSE-independent heads-up No-Limit Texas Hold'em betting
// engine (Slice 2). Every function here takes a state and returns a new
// state (or a typed rejection) — nothing touches a database, a clock, a
// cookie, or any process-global mutable state, and nothing here deals,
// reveals, or evaluates a single card. The caller persists whatever comes
// back transactionally; that persistence is a later slice's job, not this
// module's. See docs/poker-betting-rules.md for the authoritative rules
// basis (TDA rules 36-C, 45, 49) and the specific simplifications made for
// this web application.

export type Seat = 1 | 2;
export type Street = "preflop" | "flop" | "turn" | "river";

export interface SeatBettingState {
  readonly seat: Seat;
  readonly stack: number; // chips not yet committed to the pot this hand
  readonly committedThisStreet: number;
  readonly committedTotal: number; // across the whole hand so far
  readonly folded: boolean;
  readonly allIn: boolean;
  readonly hasActedThisStreet: boolean;
}

export type HandOutcome = "in_progress" | "uncontested" | "runout_required";

// Identifies chips one seat committed that the other seat was never able to
// match (because they folded as the short all-in they chose to make, or
// went all-in for less) — these must be returned to the over-committing
// seat at settlement, not awarded to anyone. Winner determination and the
// actual chip movement belong to a later slice; this only identifies the
// amount and who it belongs to.
export interface UncalledExcess {
  readonly seat: Seat;
  readonly amount: number;
}

export interface HeadsUpBettingState {
  readonly version: number; // bumped on every applied action, for stale-action checks
  readonly buttonSeat: Seat; // also the small blind, per TDA Rule 36-C
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly street: Street;
  // actingSeat / isBettingComplete / handOutcome / uncontestedWinner /
  // uncalledExcess are all derived purely from the fields above and from
  // each seat's own committed/folded/allIn/hasActedThisStreet state — never
  // set independently, so there is exactly one source of truth.
  readonly actingSeat: Seat | null;
  readonly currentBet: number; // total commitment level to match on this street
  readonly lastFullRaiseSize: number; // size of the last FULL bet/raise increment this street
  readonly bettingReopened: boolean; // can whoever faces currentBet currently raise, or only call/fold
  readonly seats: Readonly<Record<Seat, SeatBettingState>>;
  readonly isBettingComplete: boolean;
  readonly handOutcome: HandOutcome;
  readonly uncontestedWinner: Seat | null;
  readonly uncalledExcess: UncalledExcess | null;
}

export type BettingActionType = "fold" | "check" | "call" | "bet" | "raise" | "all_in";

export interface BettingAction {
  readonly type: BettingActionType;
  // Required for "bet"/"raise" only: the player's TARGET TOTAL commitment
  // for the current street, not the incremental amount being added. This
  // matches TDA Rule 45-B's own convention ("declaring raise and an amount
  // is the total bet"). Unused for fold/check/call/all_in — "all_in" always
  // means "commit everything remaining," an explicit named action rather
  // than a computed amount the client would otherwise have to supply.
  readonly amount?: number;
}

export type BettingActionRejectionReason =
  | "hand_not_in_progress"
  | "not_your_turn"
  | "stale_version"
  | "action_not_legal"
  | "amount_required"
  | "amount_not_allowed"
  | "amount_exceeds_available"
  | "bet_below_minimum"
  | "raise_below_minimum";

export type ApplyActionResult =
  | { readonly ok: true; readonly state: HeadsUpBettingState }
  | { readonly ok: false; readonly reason: BettingActionRejectionReason; readonly state: HeadsUpBettingState };

export interface LegalActionsForSeat {
  readonly canAct: boolean;
  readonly actions: readonly BettingActionType[];
  readonly amountToCall: number;
  readonly minBet: number;
  readonly minRaiseTo: number;
  readonly maxCommitment: number; // this seat's full possible total commitment this street (stack + already committed)
}

function otherSeat(seat: Seat): Seat {
  return seat === 1 ? 2 : 1;
}

// A non-folded seat has nothing further to decide this street when: it has
// no chips left (all-in); or it has already matched the current bet AND
// (it has had its own turn since the bet last changed, OR the opponent is
// all-in and so literally cannot be wagered against further, which is what
// lets a street that starts after someone is already all-in settle
// immediately instead of asking the funded seat to act pointlessly).
function isSettled(seat: SeatBettingState, opponent: SeatBettingState, currentBet: number): boolean {
  if (seat.allIn) return true;
  if (seat.committedThisStreet !== currentBet) return false;
  return seat.hasActedThisStreet || opponent.allIn;
}

function computeUncalledExcess(seats: Readonly<Record<Seat, SeatBettingState>>): UncalledExcess | null {
  const diff = seats[1].committedTotal - seats[2].committedTotal;
  if (diff === 0) return null;
  return diff > 0 ? { seat: 1, amount: diff } : { seat: 2, amount: -diff };
}

type DerivableFields = Omit<
  HeadsUpBettingState,
  "actingSeat" | "isBettingComplete" | "handOutcome" | "uncontestedWinner" | "uncalledExcess"
>;

// The single place actingSeat / isBettingComplete / handOutcome /
// uncontestedWinner / uncalledExcess are computed. Every function below that
// produces a new state funnels through here, so these fields are never set
// ad hoc and can never drift out of sync with the underlying seat state.
function deriveStatus(partial: DerivableFields): HeadsUpBettingState {
  const seatA = partial.seats[1];
  const seatB = partial.seats[2];

  if (seatA.folded || seatB.folded) {
    const winner: Seat = seatA.folded ? 2 : 1;
    return {
      ...partial,
      actingSeat: null,
      isBettingComplete: true,
      handOutcome: "uncontested",
      uncontestedWinner: winner,
      uncalledExcess: computeUncalledExcess(partial.seats),
    };
  }

  const settledA = isSettled(seatA, seatB, partial.currentBet);
  const settledB = isSettled(seatB, seatA, partial.currentBet);

  if (!(settledA && settledB)) {
    let nextActor: Seat;
    if (!settledA && !settledB) {
      // Nobody has acted yet this street: the street's own first-actor rule
      // decides (TDA 36-C: button/small blind first preflop, big blind
      // first on every later street).
      nextActor = partial.street === "preflop" ? partial.buttonSeat : otherSeat(partial.buttonSeat);
    } else {
      nextActor = !settledA ? 1 : 2;
    }
    return {
      ...partial,
      actingSeat: nextActor,
      isBettingComplete: false,
      handOutcome: "in_progress",
      uncontestedWinner: null,
      uncalledExcess: null,
    };
  }

  const anyAllIn = seatA.allIn || seatB.allIn;
  return {
    ...partial,
    actingSeat: null,
    isBettingComplete: true,
    handOutcome: anyAllIn ? "runout_required" : "in_progress",
    uncontestedWinner: null,
    uncalledExcess: anyAllIn ? computeUncalledExcess(partial.seats) : null,
  };
}

export interface InitializeHeadsUpBettingParams {
  readonly buttonSeat: Seat;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly stacks: Readonly<Record<Seat, number>>;
}

// Posts both blinds (capping each at the posting seat's own stack — a short
// stack posts a partial blind and is immediately all-in for that amount)
// and returns the initial preflop state. The button is the small blind and
// acts first preflop, per TDA Rule 36-C.
export function initializeHeadsUpBetting(params: InitializeHeadsUpBettingParams): HeadsUpBettingState {
  const { buttonSeat, smallBlind, bigBlind, stacks } = params;
  const sbSeat = buttonSeat;
  const bbSeat = otherSeat(buttonSeat);

  const sbPost = Math.min(smallBlind, stacks[sbSeat]);
  const bbPost = Math.min(bigBlind, stacks[bbSeat]);

  const seats = {
    [sbSeat]: {
      seat: sbSeat,
      stack: stacks[sbSeat] - sbPost,
      committedThisStreet: sbPost,
      committedTotal: sbPost,
      folded: false,
      allIn: stacks[sbSeat] - sbPost <= 0,
      hasActedThisStreet: false,
    },
    [bbSeat]: {
      seat: bbSeat,
      stack: stacks[bbSeat] - bbPost,
      committedThisStreet: bbPost,
      committedTotal: bbPost,
      folded: false,
      allIn: stacks[bbSeat] - bbPost <= 0,
      hasActedThisStreet: false,
    },
  } as Record<Seat, SeatBettingState>;

  return deriveStatus({
    version: 1,
    buttonSeat,
    smallBlind,
    bigBlind,
    street: "preflop",
    currentBet: Math.max(sbPost, bbPost),
    lastFullRaiseSize: bigBlind,
    bettingReopened: true,
    seats,
  });
}

export function getLegalActions(state: HeadsUpBettingState, seat: Seat): LegalActionsForSeat {
  if (state.actingSeat !== seat) {
    return { canAct: false, actions: [], amountToCall: 0, minBet: 0, minRaiseTo: 0, maxCommitment: 0 };
  }

  const self = state.seats[seat];
  const opponent = state.seats[otherSeat(seat)];
  const amountToCall = Math.max(0, state.currentBet - self.committedThisStreet);
  const maxCommitment = self.stack + self.committedThisStreet;
  const minBet = state.bigBlind;
  const minRaiseTo = state.currentBet + state.lastFullRaiseSize;

  const actions: BettingActionType[] = ["fold"];
  if (amountToCall === 0) actions.push("check");
  else actions.push("call");

  // No bet or raise is ever legal against an opponent with no chips left —
  // there is nobody able to call it.
  const opponentCanStillAct = !opponent.allIn;

  if (self.stack > 0) {
    actions.push("all_in");
    if (opponentCanStillAct) {
      if (state.currentBet === 0) actions.push("bet");
      else if (state.bettingReopened) actions.push("raise");
    }
  }

  return { canAct: true, actions, amountToCall, minBet, minRaiseTo, maxCommitment };
}

// Moves `seat` from its current committedThisStreet to `targetTotalThisStreet`,
// updates the shared betting-level fields if this is an aggressive action
// (a bet or a raise beyond the current level), and re-derives status. Used
// by every action that changes a commitment amount (call/bet/raise/all_in);
// fold/check go through commitSeatOnly() below instead, since they never
// change any amount.
function applyCommitment(state: HeadsUpBettingState, seat: Seat, targetTotalThisStreet: number): ApplyActionResult {
  const self = state.seats[seat];
  const opponentSeat = otherSeat(seat);
  const opponentBefore = state.seats[opponentSeat];
  const added = targetTotalThisStreet - self.committedThisStreet;

  const newSelf: SeatBettingState = {
    ...self,
    stack: self.stack - added,
    committedThisStreet: targetTotalThisStreet,
    committedTotal: self.committedTotal + added,
    allIn: self.stack - added <= 0,
    hasActedThisStreet: true,
  };

  const isAggression = targetTotalThisStreet > state.currentBet;
  let newCurrentBet = state.currentBet;
  let newLastFullRaiseSize = state.lastFullRaiseSize;
  let newBettingReopened = state.bettingReopened;
  let newOpponent = opponentBefore;

  if (isAggression) {
    const increment = targetTotalThisStreet - state.currentBet;
    const isFullRaise = increment >= state.lastFullRaiseSize;
    newCurrentBet = targetTotalThisStreet;
    if (isFullRaise) newLastFullRaiseSize = increment;
    // TDA Rule 49-A: an all-in wager less than a full bet/raise does not
    // reopen betting for a player who has ALREADY acted this street. A
    // player who hasn't had any turn yet this street always still gets
    // full normal options regardless of how small the wager facing them is.
    newBettingReopened = isFullRaise || !opponentBefore.hasActedThisStreet;
    // The opponent now faces a new, unmatched commitment level either way,
    // so their "already decided" status is invalidated regardless of
    // whether this was a full or short raise.
    newOpponent = { ...opponentBefore, hasActedThisStreet: false };
  }

  const newSeats = {
    ...state.seats,
    [seat]: newSelf,
    [opponentSeat]: newOpponent,
  } as Record<Seat, SeatBettingState>;

  const newState = deriveStatus({
    version: state.version + 1,
    buttonSeat: state.buttonSeat,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    street: state.street,
    currentBet: newCurrentBet,
    lastFullRaiseSize: newLastFullRaiseSize,
    bettingReopened: newBettingReopened,
    seats: newSeats,
  });

  return { ok: true, state: newState };
}

function commitSeatOnly(state: HeadsUpBettingState, seat: Seat, newSelf: SeatBettingState): ApplyActionResult {
  const newSeats = { ...state.seats, [seat]: newSelf } as Record<Seat, SeatBettingState>;
  const newState = deriveStatus({
    version: state.version + 1,
    buttonSeat: state.buttonSeat,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    street: state.street,
    currentBet: state.currentBet,
    lastFullRaiseSize: state.lastFullRaiseSize,
    bettingReopened: state.bettingReopened,
    seats: newSeats,
  });
  return { ok: true, state: newState };
}

export function applyBettingAction(
  state: HeadsUpBettingState,
  seat: Seat,
  action: BettingAction,
  options?: { readonly expectedVersion?: number },
): ApplyActionResult {
  if (state.handOutcome !== "in_progress" || state.isBettingComplete) {
    return { ok: false, reason: "hand_not_in_progress", state };
  }
  if (options?.expectedVersion !== undefined && options.expectedVersion !== state.version) {
    return { ok: false, reason: "stale_version", state };
  }
  if (state.actingSeat !== seat) {
    return { ok: false, reason: "not_your_turn", state };
  }

  const legal = getLegalActions(state, seat);
  if (!legal.actions.includes(action.type)) {
    return { ok: false, reason: "action_not_legal", state };
  }

  const self = state.seats[seat];

  switch (action.type) {
    case "fold":
      return commitSeatOnly(state, seat, { ...self, folded: true, hasActedThisStreet: true });

    case "check":
      return commitSeatOnly(state, seat, { ...self, hasActedThisStreet: true });

    case "call":
      return applyCommitment(state, seat, Math.min(state.currentBet, legal.maxCommitment));

    case "all_in":
      return applyCommitment(state, seat, legal.maxCommitment);

    case "bet":
    case "raise": {
      if (action.amount === undefined) return { ok: false, reason: "amount_required", state };
      if (!Number.isInteger(action.amount)) return { ok: false, reason: "amount_not_allowed", state };
      if (action.amount > legal.maxCommitment) return { ok: false, reason: "amount_exceeds_available", state };

      const isShortAllIn = action.amount === legal.maxCommitment;

      if (action.type === "bet") {
        if (action.amount < legal.minBet && !isShortAllIn) {
          return { ok: false, reason: "bet_below_minimum", state };
        }
      } else {
        if (action.amount <= state.currentBet) return { ok: false, reason: "amount_not_allowed", state };
        if (action.amount < legal.minRaiseTo && !isShortAllIn) {
          return { ok: false, reason: "raise_below_minimum", state };
        }
      }

      return applyCommitment(state, seat, action.amount);
    }
  }
}

// Resets street-specific commitments and action flags for a new street
// without losing total hand contributions, stacks, or fold/all-in status.
// Requires the current street's betting to already be complete. The new
// street's first actor is always the big blind (TDA Rule 36-C), unless one
// seat is already all-in, in which case no further betting is possible and
// no actingSeat is ever assigned (deriveStatus settles this automatically).
export function advanceToNextStreet(state: HeadsUpBettingState, nextStreet: Street): HeadsUpBettingState {
  if (!state.isBettingComplete) {
    throw new Error("cannot advance to the next street: betting on the current street is not complete");
  }

  const resetSeat = (seat: SeatBettingState): SeatBettingState => ({
    ...seat,
    committedThisStreet: 0,
    hasActedThisStreet: false,
  });

  const seats = {
    1: resetSeat(state.seats[1]),
    2: resetSeat(state.seats[2]),
  } as Record<Seat, SeatBettingState>;

  return deriveStatus({
    version: state.version + 1,
    buttonSeat: state.buttonSeat,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    street: nextStreet,
    currentBet: 0,
    lastFullRaiseSize: state.bigBlind,
    bettingReopened: true,
    seats,
  });
}
