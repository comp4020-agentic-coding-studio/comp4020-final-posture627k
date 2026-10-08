# Poker betting rules — Slice 2 basis

This records the authoritative rules basis for the pure heads-up betting
engine in `poker/betting.ts`, and the specific simplifications made for this
web application. It is written before the hand state machine and UI that
will use this engine, following the same before-code discipline as the
other architecture decisions in this repository.

## Source and rules version

**Source:** [Poker TDA Rules](https://www.pokertda.com/view-poker-tda-rules/)
("2026 Rules, Version 1.0, Sept 7 2026" per the page itself, plus a
Recommended Procedures section dated October 2024 and a September 6 2026
Illustration Addendum).

**Re-checked for a later "v1.1" release**, since a Slice 2 audit asked
specifically: as of this check, the live page and the TDA forum show no
version beyond **2026 Rules, Version 1.0** — no v1.1, no changelog, no
revision history is published anywhere on the site. This document and the
implementation follow **2026 Rules, Version 1.0 (Sept 7, 2026)** exactly;
no code changes were made on account of a "later release," because none
exists to check against. If the TDA publishes a v1.1 in the future, this
section is the place to record what, if anything, it changes here.

**Correction to the task brief's rule numbers.** The task brief cited Rule
34 (heads-up action order), Rule 43 (raise amounts), and Rule 47
(reopening the bet). Fetching the actual current page shows those numbers
do not correspond to that content:

- Rule 34 in the live document is "Dead Button" (unrelated).
- Rule 43 in the live document is "Methods of Calling" (unrelated).
- Rule 47 in the live document is "Multiple Chip Betting" (related, but not
  the reopening rule itself).

The content the brief actually meant is at:

- **Rule 36-C** — heads-up play: "the small blind is the button, is dealt
  the last card, and acts first pre-flop and last on all other betting
  rounds."
- **Rule 45** — Raise Amounts. 45-A: "A raise must be at least equal to the
  largest prior full bet or raise of the current betting round." 45-B:
  "Without other clarifying information, declaring raise and an amount is
  the total bet."
- **Rule 49** — Re-Opening the Bet. 49-A: an all-in wager "totaling less
  than a full bet or raise will not reopen betting" for a player who is
  not "facing at least a full bet or raise when the action returns to
  them" — i.e., a player who has **already acted** this betting round.

This document and the implementation use the correct rule numbers (36-C,
45, 49) throughout, not the ones given in the brief. Per instruction, no
rule is invented where the reference is unclear — where the fetched rules
page did not explicitly codify something (the big blind's preflop option,
specifically), that is called out below as a standard convention rather
than attributed to a specific numbered rule it was not found at.

## Chosen bet/raise amount convention

Every `bet`/`raise` action's `amount` is the player's **target total
commitment for the current street**, not the incremental amount being
added — matching Rule 45-B's own convention ("declaring raise and an
amount is the total bet") exactly, so this app's numeric API mirrors how a
TDA-run table already interprets a declared raise.

`fold`/`check`/`call`/`all_in` take no amount: `all_in` always means
"commit my entire remaining stack," computed by the engine, not supplied by
the client. This removes the ambiguity a physical chip push can have (was
that a call or a raise?) entirely — the client always sends an exact
named action, never a gesture for the server to interpret.

**Rule 45-A's 50% threshold is a different question from this app's
legality check.** That threshold exists to interpret an *ambiguous
physical chip push* as a call or a raise at the table. This application has
no such ambiguity: every action is an explicit, named, numeric API call.
The minimum-raise-size rule (Rule 45-A's "at least equal to the largest
prior full bet or raise") is what this engine enforces; the 50% physical-
interpretation rule has no equivalent here and is not implemented, because
there is nothing for it to disambiguate.

## Heads-up action order

Per Rule 36-C: the button is the small blind, acts first preflop, and acts
last (i.e., the big blind acts first) on every later street. The button
rotates between hands; full next-hand orchestration (who becomes the
button, dealing a new hand) is explicitly out of scope for this slice and
belongs to a later one.

**Big blind preflop option.** Not found as a separately numbered rule in
the fetched TDA text — the closest related content (Rule 56-B) covers pot
calculations involving blinds, not the option itself. This is implemented
as the standard, universally-assumed structural behavior of a blind game
(the big blind's forced post is not a voluntary action, so matching it does
not end the preflop round until the big blind has also had a turn),
consistent with the general round-completion principle the engine applies
uniformly to every street, not as a literal citation to a specific TDA rule
number.

## Minimum-raise and all-in interpretation

- **Minimum raise** (Rule 45-A): a raise must bring the total current-street
  bet to at least `currentBet + lastFullRaiseSize`, where `lastFullRaiseSize`
  starts at one big blind and updates to the size of each full raise's own
  increment.
- **Short all-in exception:** an all-in for less than the minimum raise is
  always legal (a player can never be required to have chips they don't
  have), but per Rule 49-A it does not update `lastFullRaiseSize` and does
  not reopen betting for whichever seat has **already acted** this street
  at the current bet level. A seat facing its very first decision of the
  street always gets full normal options regardless of how short the
  wager facing it is — Rule 49-A's text specifically scopes the
  restriction to players who have already acted, not to first-time actors.
- **No wagering against an opponent who cannot call:** once a seat is
  all-in, the other seat can never bet or raise further — there is nobody
  left able to call it. This is enforced independently of the reopening
  flag above.
- **Heads-up-specific collapse, worth flagging explicitly:** in this
  engine, a sub-minimum bet or raise is only ever accepted as a genuine
  all-in (see the `bet_below_minimum`/`raise_below_minimum` guards in
  `applyBettingAction`, which only admit an amount below the stated
  minimum when it equals the acting seat's entire remaining stack). Because
  heads-up has exactly one opponent, this means "a short raise doesn't
  reopen betting for an already-acted opponent" and "nobody can wager
  against an all-in opponent" always co-occur — the short-raising seat is
  always the one now out of chips, and there's only one other seat who
  could ever face it. The `bettingReopened` flag is still derived exactly
  per Rule 49-A's literal text (see `poker/betting.ts`'s tests), but it has
  no *independently observable* effect on `getLegalActions`' output in
  heads-up specifically, for this reason. See "Known P1 differences" below
  for why this stops being true with more seats.

## Uncalled excess treatment

When one seat commits more than the other seat's own stack ever allowed
them to match (a bet/raise the opponent can only call all-in for less), the
excess is identified as `uncalledExcess: { seat, amount }` on the resulting
state once the hand reaches `runout_required`. This is computed as the
difference between the two seats' `committedTotal` values — in heads-up,
any such difference, by construction, belongs entirely to whoever
committed more and must be returned to them at settlement, never awarded
to anyone or left unaccounted for. This slice only **identifies** the
amount; actually moving chips back to a stack, and all other settlement/
payout logic, belongs to a later slice.

## Known P1 (multiplayer) differences

- With 3+ players, a short all-in's "doesn't reopen betting" consequence
  becomes independently meaningful: an already-acted player who is not the
  one facing the short all-in directly can still be barred from re-raising
  while a player who hasn't acted yet is not — a distinction that collapses
  to a single flag in heads-up but will need to be tracked per-seat (or
  per "has this seat acted since the last full raise") once more than one
  opponent exists.
- Side pots do not exist in this slice at all — `uncalledExcess` only
  handles the two-player case where the excess simply returns to the
  single over-committing player. With 3+ players and multiple different
  all-in amounts, the same underlying commitment-tracking fields
  (`committedTotal` per seat) generalize to side-pot construction, but that
  construction itself is not implemented here.
- Turn order with 3+ players requires skipping folded/all-in seats around a
  full ring, not just picking "the other seat."

## Explicit simplifications for this web application

- Named, exact-amount actions only (`fold`/`check`/`call`/`bet`/`raise`/
  `all_in`), never a physical chip-count or gesture to interpret — this is
  why Rule 45-A's 50% ambiguous-push threshold has no equivalent here.
- No action timer / clock is implemented or assumed by this engine; that is
  a UI/session concern for a later slice, not a betting-legality concern.
- Button rotation between hands, dealing, hole cards, and showdown are all
  out of scope for this slice (see `poker/betting.ts`'s own module comment
  and the scope boundary in `docs/poker-final-architecture.md`).
- This document records an implementation basis chosen by this project; it
  does not constitute, and should not be read as, approval by the course
  instructor or by any gambling regulator. Those approvals remain open
  items tracked in `docs/poker-final-architecture.md`.
