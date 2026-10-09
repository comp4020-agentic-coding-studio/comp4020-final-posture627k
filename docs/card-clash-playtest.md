# Card Clash — two-human local playtest

Not yet performed. The automated tests drive the page in jsdom only; nobody has played this in a real browser.

## Start a local server
```
cd ~/comp4020-final-posture627k
DATA_DIR=$(mktemp -d) PORT=8080 node server.ts
```
Use a throwaway `DATA_DIR`, never `/data`. Open `http://localhost:8080/card-clash` (or `http://<your-LAN-IP>:8080/card-clash` on a trusted network).

## Separate identities
Identity is a cookie, so each player needs their own cookie jar: two different browser profiles, or one normal window plus one private window. Two tabs in the same profile are the SAME player.

## Create, join, start
1. Player A: choose a mode, press **Create Room**, press **Copy Invite Link**, press **Ready**.
2. Player B (other profile): open the invite link (`/card-clash?room=CODE`), press **Join this room**, press **Ready**. For 1v2/2v2 repeat with more profiles.
3. Player A: **Start Game** (enabled once every seat is ready; only seat 1 can start).

## Using cards (on your turn, MAIN)
- **Attack**: press Attack, then pick a target. One per turn (two for the 1v2 host).
- **Heal (self)**: only when below max HP.
- **Seize / Disarm**: pick a target holding at least one card. Disarm publicly reveals the discarded card type; Seize does not.
- **War Cry / Arrow Volley / Insight**: single click, no target.
- **Dodge** is never played proactively, only as a response.
- **End Turn** finishes MAIN.

## Defence, rescue, discard
- Attack: the target sees **Dodge / Decline**. Others see a waiting message.
- War Cry wants an Attack, Arrow Volley wants a Dodge, each in clockwise order, or Decline.
- At 0 HP everyone is asked (counterclockwise, the dying player last): **Heal / Decline**. The dying seat is named.
- End Turn with more cards than HP starts DISCARD: select the excess cards, press **Discard selected**. There is no End Turn button then.
- Every window is 10 s (shown as a countdown). Let one expire: responses auto-decline, MAIN ends, and an unfinished discard removes random excess cards.

## Confirm SSE
Perform an action in one profile; the other must update without a reload. In devtools, Network shows one `events` request per page, no repeated polling.

## Finish a match
Play until a team is eliminated; the winner line appears and the controls disappear. Eliminated players stay as spectators.

## Record
Wrong or missing buttons, state that needs a reload, a hand visible to the wrong player, double-applied actions, confusing errors, countdown mismatches, mobile layout problems, and the browser/version.
