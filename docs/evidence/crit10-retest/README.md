# Crit 10 — retained follow-up log evidence

This is a **later follow-up session**, not the missing trace of the original
room EVM43AVT. The author supplied the raw Fly capture and confirmed room
JCD73KK4, the same two classmates, independent identities and no operating
hints. Windows laptops/Chrome were unchanged from the original session.

## Provenance and extraction

- Source filename: `crit10-20261017-190236.json`, supplied by the author;
  196,168 bytes, retained privately outside the repository with mode 0600.
- Selected room JCD73KK4, roomId 13, matchId 8: **41 records**, two distinct
  server identities, all `actor: player`, `source: http`, `outcome: accepted`.
- Selected event window: 17 October 2026, **19:02:52.668–19:04:08.904 UTC+8**
  (11:02:52.668–11:04:08.904 UTC). This is the retained operation window;
  the full duration of the follow-up was not independently recorded.
- The capture contained 201 action records. The other **160 timeout records
  from unrelated rooms were excluded**. No timeout event for this room was
  present, so those unrelated events cannot stand in as its timeout evidence.
- [actions.jsonl](actions.jsonl) retains explicit allowlisted action fields.
  Server participant IDs are consistently replaced by `participant-1`
  (seat 1) and `participant-2` (seat 2); names and raw identity IDs are omitted.
  Original timestamps, room/match, seats, actions, outcomes, readiness and
  versions are preserved. Platform wrappers and arbitrary messages are removed.
- [summary.json](summary.json) records source/output SHA-256 hashes,
  counts and extraction boundaries. No cookies, tokens, private hands,
  card ID lists or deck contents are included. No source event is fabricated.
- Repair baseline: [18ad415](https://github.com/comp4020-agentic-coding-studio/comp4020-final-posture627k/commit/18ad415).
  The action log itself carries no build identifier.

## What the evidence supports

The trace attributes room creation, joining, readiness, match start and
subsequent actions to two server-recognized identities. For example, seat 1
plays War Cry and seat 2 responds with Attack. This supports a concrete
account of who acted and which version the server accepted. It does not
prove who was physically operating the browser without the author's report.

| Action | Accepted records |
|---|---:|
| `create_room` | 1 |
| `set_ready` | 2 |
| `join_room` | 1 |
| `start_match` | 1 |
| `play_war_cry` | 1 |
| `respond_group_attack` | 1 |
| `play_attack` | 7 |
| `respond_dodge` | 3 |
| `play_insight` | 1 |
| `end_turn` | 8 |
| `discard_cards` | 1 |
| `play_seize` | 2 |
| `play_disarm` | 4 |
| `decline_attack_response` | 4 |
| `play_arrow_volley` | 1 |
| `decline_group_response` | 1 |
| `decline_rescue` | 2 |

Selected chronology (UTC+8):

| Time | Seat | Action | State version / room operation |
|---|---:|---|---|
| 19:02:52.668 | 1 | `create_room` | room/readiness |
| 19:03:01.103 | 2 | `join_room` | room/readiness |
| 19:03:03.140 | 1 | `start_match` | None → 2 |
| 19:03:06.225 | 1 | `play_war_cry` | 2 → 3 |
| 19:03:08.642 | 2 | `respond_group_attack` | 3 → 4 |
| 19:03:14.909 | 1 | `play_insight` | 6 → 7 |
| 19:03:20.161 | 1 | `discard_cards` | 8 → 10 |
| 19:04:04.348 | 1 | `play_arrow_volley` | 35 → 36 |
| 19:04:07.947 | 1 | `decline_rescue` | 37 → 38 |
| 19:04:08.904 | 2 | `decline_rescue` | 38 → 39 |

All 41 HTTP operations were accepted; they are not 41 separate card plays
or necessarily 41 unit version increments. No rejected over-discard request
appears. No `rescue_heal` appears; the two rescue-related records are declines.

## Human follow-up, supplied separately by the author

| Finding | Source and status |
|---|---|
| Targetless card use | Author confirms classmates found the repair successful. The trace contains War Cry, Insight and Arrow Volley plays; it does not record whether each was clicked or dragged. Heal is not represented in this capture. |
| Discard limit | Author confirms the repair successful. One accepted discard is logged; selection counts and rejected UI selections are not logged, so an exact 2-HP/5-card boundary test cannot be reconstructed from this file. |
| Lobby | Classmates report the button is too small and recommend confirmation before returning. This is a new open usability issue; navigation GETs are not action events in this trace. No button-size/confirmation change is claimed here. |
| HUD | No separate new acceptance result was supplied. Retain the earlier readability finding and automated evidence separately. |

This follow-up does not establish measured latency, next-day persistence,
final visual acceptance, or that the author narrated live from logs. It
preserves a trace that can be read afterwards. The original five-minute
session remains an independent human account with an unrecovered trace.
No additional runtime or browser testing was performed for this documentation
submission. The unchanged CI still runs its required checks when pushed.
