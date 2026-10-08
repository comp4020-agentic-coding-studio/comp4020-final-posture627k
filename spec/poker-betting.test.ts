import { describe, expect, it } from "vitest";
import {
  advanceToNextStreet,
  applyBettingAction,
  getLegalActions,
  initializeHeadsUpBetting,
  type HeadsUpBettingState,
  type Seat,
} from "../poker/betting.ts";

// Standard 5/10 blinds, 1,000-chip stacks, button/small blind = seat 1,
// unless a test specifically needs something else. These numbers match the
// fixtures named in the brief (preflop min-raise to 20, etc.).
function standardStart(overrides?: { buttonSeat?: Seat; stacks?: Record<Seat, number> }): HeadsUpBettingState {
  return initializeHeadsUpBetting({
    buttonSeat: overrides?.buttonSeat ?? 1,
    smallBlind: 5,
    bigBlind: 10,
    stacks: overrides?.stacks ?? { 1: 1000, 2: 1000 },
  });
}

function totalChips(state: HeadsUpBettingState): number {
  return (
    state.seats[1].stack +
    state.seats[1].committedTotal +
    state.seats[2].stack +
    state.seats[2].committedTotal
  );
}

describe("blinds and heads-up action order", () => {
  it("1. the button posts the small blind", () => {
    const state = standardStart();
    expect(state.seats[1].committedThisStreet).toBe(5); // seat 1 is the button
  });

  it("2. the small blind acts first preflop", () => {
    const state = standardStart();
    expect(state.actingSeat).toBe(1);
  });

  it("3. the big blind acts first postflop", () => {
    let state = standardStart();
    // Get preflop to completion: SB calls, BB checks.
    state = applyBettingAction(state, 1, { type: "call" }).state;
    state = applyBettingAction(state, 2, { type: "check" }).state;
    expect(state.isBettingComplete).toBe(true);
    const flop = advanceToNextStreet(state, "flop");
    expect(flop.actingSeat).toBe(2); // big blind, not the button
  });

  it("4. posting 5/10 blinds", () => {
    const state = standardStart();
    expect(state.seats[1].committedThisStreet).toBe(5);
    expect(state.seats[2].committedThisStreet).toBe(10);
    expect(state.currentBet).toBe(10);
    expect(state.seats[1].stack).toBe(995);
    expect(state.seats[2].stack).toBe(990);
  });

  it("5. small blind calls, big blind still has the option (round not complete)", () => {
    let state = standardStart();
    const result = applyBettingAction(state, 1, { type: "call" });
    expect(result.ok).toBe(true);
    state = result.state;
    expect(state.seats[1].committedThisStreet).toBe(10);
    expect(state.isBettingComplete).toBe(false);
    expect(state.actingSeat).toBe(2); // the big blind option
  });

  it("6. big blind checks, the round completes", () => {
    let state = standardStart();
    state = applyBettingAction(state, 1, { type: "call" }).state;
    const result = applyBettingAction(state, 2, { type: "check" });
    expect(result.ok).toBe(true);
    state = result.state;
    expect(state.isBettingComplete).toBe(true);
    expect(state.actingSeat).toBeNull();
    expect(state.handOutcome).toBe("in_progress"); // more streets remain, nobody folded or is all-in
  });
});

describe("betting legality", () => {
  it("7. a valid opening bet postflop", () => {
    let state = standardStart();
    state = applyBettingAction(state, 1, { type: "call" }).state;
    state = applyBettingAction(state, 2, { type: "check" }).state;
    let flop = advanceToNextStreet(state, "flop");
    const result = applyBettingAction(flop, 2, { type: "bet", amount: 20 });
    expect(result.ok).toBe(true);
    flop = result.state;
    expect(flop.currentBet).toBe(20);
    expect(flop.actingSeat).toBe(1);
  });

  it("8. an invalid check facing a bet is rejected", () => {
    const state = standardStart(); // seat 1 faces a bet (the big blind) preflop
    const result = applyBettingAction(state, 1, { type: "check" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("action_not_legal");
    expect(result.state).toBe(state); // unchanged
  });

  it("9. an invalid call facing no bet is rejected", () => {
    let state = standardStart();
    state = applyBettingAction(state, 1, { type: "call" }).state;
    state = applyBettingAction(state, 2, { type: "check" }).state;
    const flop = advanceToNextStreet(state, "flop");
    const result = applyBettingAction(flop, 2, { type: "call" }); // nothing to call
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("action_not_legal");
  });

  it("10. a valid minimum raise, preflop min-raise to 20 with 5/10 blinds", () => {
    const state = standardStart();
    const legal = getLegalActions(state, 1);
    expect(legal.minRaiseTo).toBe(20); // currentBet(10) + lastFullRaiseSize(10)
    const result = applyBettingAction(state, 1, { type: "raise", amount: 20 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.currentBet).toBe(20);
      expect(result.state.lastFullRaiseSize).toBe(10);
      expect(result.state.bettingReopened).toBe(true);
    }
  });

  it("11. an invalid below-minimum non-all-in raise is rejected", () => {
    const state = standardStart({ stacks: { 1: 1000, 2: 1000 } });
    const result = applyBettingAction(state, 1, { type: "raise", amount: 15 }); // below the 20 minimum, not all-in
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("raise_below_minimum");
  });

  it("12. a valid full all-in raise", () => {
    const state = standardStart({ stacks: { 1: 1000, 2: 1000 } });
    const result = applyBettingAction(state, 1, { type: "all_in" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.seats[1].stack).toBe(0);
      expect(result.state.seats[1].allIn).toBe(true);
      expect(result.state.currentBet).toBe(1000);
      expect(result.state.bettingReopened).toBe(true); // 990 increment >> the 10 minimum
    }
  });

  it("13. a valid short all-in: a 10-chip big blind followed by a 15-chip short all-in total", () => {
    // Seat 1 (button/SB) has only 15 chips total; blinds are still 5/10.
    const state = standardStart({ stacks: { 1: 15, 2: 1000 } });
    expect(state.seats[2].committedThisStreet).toBe(10); // the 10-chip big blind
    const result = applyBettingAction(state, 1, { type: "all_in" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.seats[1].committedThisStreet).toBe(15); // the 15-chip short all-in total
      expect(result.state.seats[1].allIn).toBe(true);
      expect(result.state.currentBet).toBe(15);
      // 15 is only a 5-chip increment over the 10 current bet: short of the
      // 10-chip minimum full raise, so it never updates the raise baseline.
      expect(result.state.lastFullRaiseSize).toBe(10);
      // Seat 1 is now all-in, so seat 2 can never raise or bet further
      // regardless — there is nobody left able to call a further wager.
      const legalForSeat2 = getLegalActions(result.state, 2);
      expect(legalForSeat2.actions).not.toContain("raise");
      expect(legalForSeat2.actions).not.toContain("bet");
      expect(legalForSeat2.actions).toEqual(expect.arrayContaining(["call", "fold", "all_in"]));
    }
  });

  it("14. a short all-in does not incorrectly reopen a completed decision for a player who already acted", () => {
    // Seat 2 is the big blind and acts first postflop: checks. Seat 1
    // (button/small blind) then bets 10 — a full bet, and an action in its
    // own right. Seat 2, holding only 12 chips, raises all-in to 12: a
    // 2-chip increment over the 10 bet, short of the 10-chip minimum full
    // raise. Seat 1 — who seat 2's short all-in now faces — already acted
    // this street (by betting), so per TDA Rule 49-A they may only call or
    // fold, never raise again.
    let state = standardStart({ stacks: { 1: 1000, 2: 1000 } });
    state = applyBettingAction(state, 1, { type: "call" }).state;
    state = applyBettingAction(state, 2, { type: "check" }).state;
    const flop = advanceToNextStreet(state, "flop");
    expect(flop.actingSeat).toBe(2); // the big blind acts first postflop

    const shortStackFlop: HeadsUpBettingState = {
      ...flop,
      seats: { ...flop.seats, 2: { ...flop.seats[2], stack: 12 } },
    };

    const check = applyBettingAction(shortStackFlop, 2, { type: "check" });
    expect(check.ok).toBe(true);
    if (!check.ok) return;

    const bet = applyBettingAction(check.state, 1, { type: "bet", amount: 10 });
    expect(bet.ok).toBe(true);
    if (!bet.ok) return;

    const shortRaise = applyBettingAction(bet.state, 2, { type: "all_in" });
    expect(shortRaise.ok).toBe(true);
    if (!shortRaise.ok) return;

    expect(shortRaise.state.currentBet).toBe(12);
    expect(shortRaise.state.lastFullRaiseSize).toBe(10); // unchanged: 2 < 10, not a full raise
    expect(shortRaise.state.bettingReopened).toBe(false); // seat 1 had already acted (their own bet)

    const legalForSeat1 = getLegalActions(shortRaise.state, 1);
    expect(legalForSeat1.actions).not.toContain("raise");
    expect(legalForSeat1.actions).toEqual(expect.arrayContaining(["call", "fold", "all_in"]));
  });

  it("15. a player cannot wager more than their available chips", () => {
    const state = standardStart({ stacks: { 1: 1000, 2: 1000 } });
    const result = applyBettingAction(state, 1, { type: "raise", amount: 1001 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("amount_exceeds_available");
  });

  it("16. out-of-turn actions are rejected", () => {
    const state = standardStart(); // seat 1 (SB) to act
    const result = applyBettingAction(state, 2, { type: "check" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_your_turn");
    expect(result.state).toBe(state);
  });
});

describe("fold, all-in runout, and chip conservation", () => {
  it("17. fold produces an uncontested winner", () => {
    const state = standardStart();
    const result = applyBettingAction(state, 1, { type: "fold" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.handOutcome).toBe("uncontested");
      expect(result.state.uncontestedWinner).toBe(2);
      expect(result.state.isBettingComplete).toBe(true);
      expect(result.state.actingSeat).toBeNull();
    }
  });

  it("18. both players all-in produce a runout-required status", () => {
    let state = standardStart({ stacks: { 1: 500, 2: 500 } });
    state = applyBettingAction(state, 1, { type: "all_in" }).state;
    const result = applyBettingAction(state, 2, { type: "all_in" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.handOutcome).toBe("runout_required");
      expect(result.state.isBettingComplete).toBe(true);
      expect(result.state.actingSeat).toBeNull();
    }
  });

  it("19. unequal stacks preserve chip conservation throughout", () => {
    let state = standardStart({ stacks: { 1: 300, 2: 700 } });
    expect(totalChips(state)).toBe(1000);
    state = applyBettingAction(state, 1, { type: "raise", amount: 100 }).state;
    expect(totalChips(state)).toBe(1000);
    state = applyBettingAction(state, 2, { type: "call" }).state;
    expect(totalChips(state)).toBe(1000);
    expect(state.isBettingComplete).toBe(true);
  });

  it("20. uncalled excess is identified and handled without chip creation when one stack is covered for less", () => {
    // Two unequal stacks: seat 1 has 500, seat 2 has only 100. Seat 1 bets
    // all-in for 500; seat 2 can only call all-in for 100.
    let state = standardStart({ stacks: { 1: 500, 2: 100 } });
    // seat 2 (big blind) only has 100 total; posting the 10 blind leaves 90.
    state = applyBettingAction(state, 1, { type: "all_in" }).state; // seat 1 commits all 500
    expect(state.seats[1].committedTotal).toBe(500);
    const result = applyBettingAction(state, 2, { type: "all_in" }); // seat 2 can only call for 100
    expect(result.ok).toBe(true);
    if (result.ok) {
      const final = result.state;
      expect(final.seats[2].committedTotal).toBe(100);
      expect(final.seats[1].committedTotal).toBe(500);
      expect(final.uncalledExcess).toEqual({ seat: 1, amount: 400 });
      expect(totalChips(final)).toBe(600); // no chips created: 500 + 100
    }
  });

  it("21. short blind posting is handled correctly", () => {
    // Seat 1 (button/SB) only has 3 chips, less than the 5-chip small blind.
    const state = standardStart({ stacks: { 1: 3, 2: 1000 } });
    expect(state.seats[1].committedThisStreet).toBe(3);
    expect(state.seats[1].allIn).toBe(true);
    expect(state.seats[1].stack).toBe(0);
    expect(state.currentBet).toBe(10); // the full big blind still governs
    expect(totalChips(state)).toBe(1003);
  });
});

describe("state integrity", () => {
  it("22. an invalid action does not mutate the original state", () => {
    const state = standardStart();
    const before = JSON.parse(JSON.stringify(state));
    applyBettingAction(state, 1, { type: "check" }); // illegal: facing a bet
    applyBettingAction(state, 2, { type: "check" }); // illegal: out of turn
    applyBettingAction(state, 1, { type: "raise", amount: 1_000_000 }); // illegal: exceeds stack
    expect(JSON.parse(JSON.stringify(state))).toEqual(before);
  });

  it("23. equivalent deterministic inputs produce equivalent results", () => {
    const a = applyBettingAction(standardStart(), 1, { type: "raise", amount: 30 });
    const b = applyBettingAction(standardStart(), 1, { type: "raise", amount: 30 });
    expect(a).toEqual(b);
  });

  it("24. legal actions advance the state version; rejected actions do not", () => {
    const state = standardStart();
    const startVersion = state.version;

    const rejected = applyBettingAction(state, 2, { type: "check" }); // out of turn
    expect(rejected.ok).toBe(false);
    expect(rejected.state.version).toBe(startVersion);

    const accepted = applyBettingAction(state, 1, { type: "call" });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.state.version).toBe(startVersion + 1);
  });

  it("a stale expected version is rejected without mutating state", () => {
    const state = standardStart();
    const result = applyBettingAction(state, 1, { type: "call" }, { expectedVersion: state.version + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale_version");
    expect(result.state).toBe(state);
  });

  it("25. new-street initialization resets street commitments and action flags without losing total hand contributions", () => {
    let state = standardStart();
    state = applyBettingAction(state, 1, { type: "call" }).state;
    state = applyBettingAction(state, 2, { type: "check" }).state;
    const totalBefore1 = state.seats[1].committedTotal;
    const totalBefore2 = state.seats[2].committedTotal;

    const flop = advanceToNextStreet(state, "flop");
    expect(flop.street).toBe("flop");
    expect(flop.currentBet).toBe(0);
    expect(flop.seats[1].committedThisStreet).toBe(0);
    expect(flop.seats[2].committedThisStreet).toBe(0);
    expect(flop.seats[1].hasActedThisStreet).toBe(false);
    expect(flop.seats[2].hasActedThisStreet).toBe(false);
    // Total hand contributions (the blinds already posted) are preserved.
    expect(flop.seats[1].committedTotal).toBe(totalBefore1);
    expect(flop.seats[2].committedTotal).toBe(totalBefore2);
    expect(flop.bettingReopened).toBe(true);
  });

  it("advancing to a new street before betting completes throws rather than silently producing a bad state", () => {
    const state = standardStart(); // betting not complete: SB hasn't even acted
    expect(() => advanceToNextStreet(state, "flop")).toThrow(/not complete/);
  });

  it("once a street starts with an opponent already all-in, no further action is ever offered", () => {
    let state = standardStart({ stacks: { 1: 500, 2: 500 } });
    state = applyBettingAction(state, 1, { type: "all_in" }).state;
    state = applyBettingAction(state, 2, { type: "all_in" }).state;
    expect(state.handOutcome).toBe("runout_required");
    const flop = advanceToNextStreet(state, "flop");
    expect(flop.actingSeat).toBeNull();
    expect(flop.isBettingComplete).toBe(true);
    expect(flop.handOutcome).toBe("runout_required");
  });

  it("a short opening bet from a player who hasn't acted yet is flagged as reopened, per TDA Rule 49-A's literal scope", () => {
    // TDA Rule 49-A withholds reopening specifically from a player who has
    // "already acted" — a player facing their very first bet of the street
    // is not such a player, however short that bet is. The internal
    // bettingReopened flag reflects this correctly.
    //
    // Note: in pure heads-up this can never change which actions
    // getLegalActions actually offers, because the only way a bet can be
    // short in this engine is for it to be an all-in (see the "bet_below_minimum"
    // guard in applyBettingAction) — and the moment the bettor is all-in,
    // the facing seat can never bet/raise anyway, since there is nobody
    // left able to call it (see "opponentCanStillAct" in getLegalActions).
    // The two rules happen to always co-occur in a 2-player game; see
    // docs/poker-betting-rules.md for why this collapse is heads-up-specific
    // and will matter independently once a later slice adds more seats.
    const shortFlop = standardStart({ stacks: { 1: 1000, 2: 14 } });
    let state = applyBettingAction(shortFlop, 1, { type: "call" }).state;
    state = applyBettingAction(state, 2, { type: "check" }).state;
    const flop = advanceToNextStreet(state, "flop");

    const shortOpenAllIn = applyBettingAction(flop, 2, { type: "all_in" }); // 4 chips left, bets all-in for 4
    expect(shortOpenAllIn.ok).toBe(true);
    if (!shortOpenAllIn.ok) return;
    expect(shortOpenAllIn.state.bettingReopened).toBe(true); // seat 1 hadn't acted this street yet

    const legalForSeat1 = getLegalActions(shortOpenAllIn.state, 1);
    expect(legalForSeat1.actions).not.toContain("raise"); // blocked anyway: seat 2 is now all-in
    expect(legalForSeat1.actions).toEqual(expect.arrayContaining(["call", "fold", "all_in"]));
  });
});

// --- Slice 2 final audit: regression tests for properties that were only
// reasoned about, not yet directly verified ------------------------------

describe("final audit regressions", () => {
  it("chip conservation holds after every single legal action in a multi-street sequence, not just at the start and end", () => {
    let state = standardStart({ stacks: { 1: 300, 2: 700 } });
    const checkpoints: HeadsUpBettingState[] = [state];

    const record = (result: ReturnType<typeof applyBettingAction>) => {
      expect(result.ok).toBe(true);
      if (result.ok) {
        state = result.state;
        checkpoints.push(state);
      }
    };

    record(applyBettingAction(state, 1, { type: "raise", amount: 30 }));
    record(applyBettingAction(state, 2, { type: "call" }));
    let flop = advanceToNextStreet(state, "flop");
    checkpoints.push(flop);
    record(applyBettingAction(flop, 2, { type: "bet", amount: 40 }));
    record(applyBettingAction(state, 1, { type: "raise", amount: 120 }));
    record(applyBettingAction(state, 2, { type: "call" }));

    for (const checkpoint of checkpoints) {
      expect(totalChips(checkpoint)).toBe(1000);
    }
  });

  it("a short all-in call never deducts more than the calling seat's available stack", () => {
    // Seat 2 (big blind) has only 25 total; seat 1 raises to 100, well
    // beyond what seat 2 can ever match.
    const state = standardStart({ stacks: { 1: 1000, 2: 25 } });
    const raised = applyBettingAction(state, 1, { type: "raise", amount: 100 });
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;

    const called = applyBettingAction(raised.state, 2, { type: "call" });
    expect(called.ok).toBe(true);
    if (!called.ok) return;

    expect(called.state.seats[2].stack).toBe(0);
    expect(called.state.seats[2].committedTotal).toBe(25); // capped at their own stack, not the 100 facing them
    expect(called.state.seats[2].allIn).toBe(true);
    expect(totalChips(called.state)).toBe(1025);
  });

  it("a short stack whose blind alone already covers the only other seat's forced all-in settles immediately with no action", () => {
    // Seat 1 (button/small blind) can only post 3 of the 5-chip small
    // blind and is immediately all-in; seat 2's full 10-chip big blind
    // already exceeds that, so there is nothing for seat 2 to decide —
    // the round completes at initialization with zero actions taken.
    const state = standardStart({ stacks: { 1: 3, 2: 1000 } });
    expect(state.seats[1].allIn).toBe(true);
    expect(state.isBettingComplete).toBe(true);
    expect(state.actingSeat).toBeNull();
    expect(state.handOutcome).toBe("runout_required");
    expect(state.uncalledExcess).toEqual({ seat: 2, amount: 7 }); // seat 2 committed 10, seat 1 only 3
  });

  it("a short big-blind post does not skip the small blind's normal decision", () => {
    // Seat 2 (big blind) can only post 7 of the 10-chip big blind and is
    // immediately all-in, but seat 1 (small blind) has only posted 5 so
    // far — short of matching seat 2's 7 — so seat 1 still has a genuine
    // decision (call the extra 2, raise, or fold), not an auto-settlement.
    const state = standardStart({ stacks: { 1: 1000, 2: 7 } });
    expect(state.seats[2].allIn).toBe(true);
    expect(state.isBettingComplete).toBe(false);
    expect(state.actingSeat).toBe(1);
    const legal = getLegalActions(state, 1);
    expect(legal.amountToCall).toBe(2);
  });

  it("uncalled excess reflects the full hand's accumulated commitment difference across multiple streets, not just the final street", () => {
    // Both seats commit evenly through preflop and the flop, then seat 1
    // goes all-in on the turn for more than seat 2's remaining stack can
    // ever match.
    let state = standardStart({ stacks: { 1: 500, 2: 150 } });
    state = applyBettingAction(state, 1, { type: "call" }).state; // seat 1 to 10
    state = applyBettingAction(state, 2, { type: "check" }).state; // preflop complete, both at 10
    let flop = advanceToNextStreet(state, "flop");
    state = applyBettingAction(flop, 2, { type: "check" }).state;
    state = applyBettingAction(state, 1, { type: "check" }).state; // flop complete, no new chips
    const turn = advanceToNextStreet(state, "turn");

    state = applyBettingAction(turn, 2, { type: "bet", amount: 50 }).state; // seat 2 commits up to 60 total
    const allIn = applyBettingAction(state, 1, { type: "all_in" }); // seat 1 has 490 left, goes all-in
    expect(allIn.ok).toBe(true);
    if (!allIn.ok) return;

    const final = applyBettingAction(allIn.state, 2, { type: "all_in" }); // seat 2's remaining 90 is all they can add
    expect(final.ok).toBe(true);
    if (!final.ok) return;

    expect(final.state.seats[1].committedTotal).toBe(500);
    expect(final.state.seats[2].committedTotal).toBe(150);
    expect(final.state.uncalledExcess).toEqual({ seat: 1, amount: 350 });
    expect(totalChips(final.state)).toBe(650);
  });
});
