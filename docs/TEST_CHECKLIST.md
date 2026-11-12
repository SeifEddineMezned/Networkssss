# Verification checklist (run on 2026-11-12, Windows 11, Node 24.15, headless Chrome)

All results below were produced on **one laptop over real sockets on 127.0.0.1** (separate OS processes:
server, 3 bridges, 3 browser tabs / bots). Evidence lives in `logs/verify/` (screenshots `*.png`,
`*-results.json`, server/bridge logs, `protocol-proof.txt`, `soak-*.json`).

**Code fix made during this pass** (the browser verifier failed on it): a second login of an
already-logged-in user used to *replace* the first session; it is now **rejected** ("User already logged
in elsewhere"). To keep automatic reconnect working, the server gives each login a private resume token
that only that player's bridge holds; a reconnecting bridge presents it and takes over its own stale
session. Files: `server/common/session.js`, `server/common/protocol.js`, `bridge/bridge.js`,
`test/run-all.js` (+2 checks). Everything was re-run afterwards.

Re-run any line with the command shown. `browser-verify.js` starts its own server + 3 bridges on
ui-ports 8080/8081/8082 (keep those ports and 9000/9001 free).

## 1. Automated suites

| ✓ | Item | Command | Expected | Observed |
|---|---|---|---|---|
| [x] | Reliability layer unit tests | `node test/reliable.test.js` | all pass | **16/16** (`logs/verify/final-reliable.txt`) |
| [x] | End-to-end, both versions (bots over real sockets) | `node test/run-all.js` | all pass | **48/48** (24 TCP + 24 UDP) (`final-run-all.txt`); baseline before the fix: 46/46 |
| [x] | Fuzz / robustness | `node test/fuzz.js` | server never crashes | **11/11** (`final-fuzz.txt`) |
| [x] | Browser smoke (2 tabs) TCP | server + 2 bridges, then `node test/browser-smoke.js` | full flow, 0 JS errors | **PASS**: playing → tab closed → "not enough players left", winner shown, 0 JS errors (`final-browser-smoke-tcp.txt`) |
| [x] | Browser smoke (2 tabs) UDP | same with `--proto udp` | same | **PASS**, same result (`final-browser-smoke-udp.txt`) |

## 2. Real browsers, 3 players: `node test/browser-verify.js tcp` / `node test/browser-verify.js udp`

| ✓ | Item | Expected | TCP observed | UDP observed |
|---|---|---|---|---|
| [x] | Register (3 tabs) | lobby "Logged in as …" | PASS | PASS |
| [x] | Login with existing credentials (logout + login) | lobby | PASS | PASS |
| [x] | Wrong password rejected | "Wrong password" | PASS | PASS |
| [x] | Duplicate username rejected | "Username already taken" | PASS | PASS |
| [x] | Second login of same user rejected, first session unaffected | "User already logged in elsewhere", tab A still logged in | PASS (after fix; **FAIL before**) | PASS |
| [x] | Create room, room list shows it on other tabs | room name in B and C lobbies | PASS | PASS |
| [x] | Join (3 players in room) | host sees 3 players | PASS | PASS |
| [x] | Leave and rejoin | PLAYER_LEFT seen by host, back to 3 | PASS | PASS |
| [x] | 4th player allowed, 5th rejected (4th/5th = raw-protocol bots) | 4/4, then "Room is full (max 4)" | PASS | PASS |
| [x] | Non-host cannot start | "Only the host can start" | PASS | PASS |
| [x] | Not-ready player blocks start | stays "waiting"; forced start → "Not everybody is ready" | PASS | PASS |
| [x] | Host starts with 2 players | status playing, 2 players | PASS | PASS |
| [x] | 2-player game: positions both ways, GAME_RESULT on both | | PASS (~30 upd/s) | PASS |
| [x] | Host starts with 3 players | status playing, 3 players | PASS | PASS |
| [x] | All 3 receive each other's position updates | ≥ 2 remote slots per tab, > 30 updates each | PASS (≈ 320–335 per remote in 8 s) | PASS (≈ 230–330 per remote in 8 s) |
| [x] | Shots arrive on every tab | FIRES events > 0 on every tab | PASS (20 each) | PASS |
| [x] | Scores identical on all 3 screens* | same side-panel scoreboard text on 3 tabs | PASS: `1. ann 3 pts 3K/1D · 2. cat 2 pts 2K/2D · 3. ben 0 pts 0K/2D` | PASS (identical) |
| [x] | GAME_RESULT same ranking + winner on all 3 | identical JSON + "WINNER" on 3 screens | PASS (winner ann) | PASS (winner ann) |
| [x] | Close host tab mid-game: drop detected | PLAYER_DROPPED on both remaining tabs | PASS (reason `closed`, 14–224 ms) | PASS (reason `bye`, 209 ms) |
| [x] | Host handover | HOST_CHANGED to a remaining player, room shows new 👑 | PASS | PASS |
| [x] | Others continue, server up | still playing, positions keep flowing | PASS (+68–70 updates in 2.5 s); 1 intermittent FAIL in an early run, explained in † | PASS (+61–66); 1 intermittent FAIL in a repeat run of the 2-player check, explained in † |
| [x] | Close 2nd tab → last player gets result | GAME_RESULT `notEnoughPlayers` | PASS | PASS |
| [x] | Server accepts new players afterwards | bot registers | PASS | PASS |
| [x] | No JS errors in any tab | 0 | PASS | PASS |
| [x] | Screenshots of each stage | `logs/verify/<proto>-NN-<stage>-<tab>.png` | 13 stages saved | 13 stages saved |
| | **Total (final runs, `logs/verify/final-verify-{tcp,udp}.txt`)** | | **28/28** | **28/28** |

\* Kills are **injected** through `RAWLINK.reportDeath(victim, killer)` called in each victim's own tab:
the exact call `game.js:1009` makes when a local player dies. Headless tabs cannot aim, so this proves the
**server scoreboard / results / consistency across screens**, not that a real in-game frag triggers the
call. PvP's own in-game HUD (top-left) therefore still shows 0 pts in the screenshots. **Do one real
2-minute match before the demo** and check that a frag updates the side-panel scoreboard.

† Two intermittent FAILs were seen and explained: an early TCP run (remaining tabs got 0 position updates in
the 2.5 s window after the host closed) and a UDP repeat run (host got only 14 updates from the other tab in the
2-player window, while the other tab got 102 from the host). In both, the screenshot of the "silent" tab shows
PvP's **start-of-game fade-in still running** 3–6 s after START: that tab's game loop had not begun sending
yet (3 headless tabs software-render the raycaster on one CPU). The network delivered what was sent.
Fix (test only): the verifier now waits until every tab is actually streaming before opening a measurement
window, and reports that warm-up (observed 1 ms – 3.4 s). After the fix: TCP 28/28, UDP 28/28, both drills
15/15. On real laptops each tab has its own machine, so this is a test-harness artefact, but
**watch for a slow fade-in on a weak laptop during the demo**.

Test-only fixes made while building the verifier (no product change): retry "hold FIRE" until the
server reports the player ready (PvP needs a fresh FIRE press after screen changes; one 4.5 s press was
sometimes missed under CPU load); host-change check reads the latest HOST_CHANGED; server-error check no
longer counts the expected disconnect reason `error:ECONNRESET` as an error; measurement windows open only
after every tab streams (†). Soak: positions are compared during play (streams paused 500 ms), because the
server correctly stops relaying positions once GAME_RESULT has ended a game.

## 3. Protocol purity: `logs/verify/protocol-proof.txt`

| ✓ | Item | Method | Expected | Observed |
|---|---|---|---|---|
| [x] | TCP version uses no UDP to the server | `netstat -ano` filtered by server + bridge PIDs during a 3-player game (inside `browser-verify.js tcp`) | server: TCP only; each bridge: 1 TCP conn to :9000, 0 UDP sockets, other TCP only on 127.0.0.1:808x | **PASS** (server 4 TCP / 0 UDP; bridges 1 TCP to server, 0 UDP, 2 localhost-UI entries each) |
| [x] | UDP version uses no TCP to the server | same, `browser-verify.js udp` | server: 1 UDP socket, 0 TCP; bridges: 0 TCP to server, 1 UDP socket, TCP only 127.0.0.1:808x | **PASS** (server 0 TCP / 1 UDP; bridges 0 TCP to server, 1 UDP); bridge UDP ports match the server's "connect from" log lines |

## 4. Bad-network drills: `node test/browser-verify.js tcp --drill` / `udp --drill`

Bridge C runs with `--sim-loss 0.1 --sim-delay 80 --sim-jitter 20`.

| ✓ | Item | Expected | TCP observed | UDP observed |
|---|---|---|---|---|
| [x] | 3-player game playable with C on lossy link (20 s) | all tabs receive both remotes | PASS (≈ 545–590 updates per remote, final run) | PASS (≈ 425–495 per remote, final run) |
| [x] | Shots arrive | FIRES > 0 everywhere | PASS (20 each) | PASS (20 each) |
| [x] | Scores consistent on 3 screens at the end | identical scoreboard + GAME_RESULT | PASS | PASS |
| [x] | Frozen client (bridge B process suspended with NtSuspendProcess = SIGSTOP equivalent) | dropped by heartbeat, game continues | PASS: `timeout` after 5.2–6.6 s | PASS: `retransmitTimeout` after 5.5 s |
| [x] | Game continues for A + lossy C | updates keep flowing | PASS | PASS |
| [x] | Abrupt kill of bridge C (TerminateProcess) | drop detected, A gets result, server up | PASS: `error:ECONNRESET` after ~210 ms (OS sends RST) | PASS: `timeout` after 5.1 s (UDP has no FIN) |
| [x] | No JS errors / no server errors | 0 / 0 | PASS / PASS | PASS / PASS |
| | **Total** | | **15/15** | **15/15** |

## 5. Soak, 10 minutes per version, 3 bots playing back-to-back games: `node test/soak.js tcp 10` / `udp 10`

TCP and UDP ran **in parallel** (and partly during browser tests), so CPU was shared. Each game: score
limit 10, 30 Hz positions, 1 reliable event/s per bot, a kill every 1.5 s; every 3rd tick the streams
pause 500 ms and every bot must hold **exactly** each sender's last state.

| ✓ | Item | Expected | TCP observed | UDP observed |
|---|---|---|---|---|
| [x] | Server alive after 10 min | yes | yes | yes |
| [x] | Games completed | > 10 | 17 | 16 |
| [x] | Server errors (uncaught / handler errors) | 0 | 0 | 0 |
| [x] | GAME_RESULT mismatch between bots | 0 | 0 | 0 |
| [x] | Scoreboard mismatch between bots | 0 | 0 | 0 |
| [x] | Position desync after quiescence | 0 | **0/702** | **0/690** |
| [x] | Stale state applied | 0 | 0 | 0 |
| [x] | Server memory (working set) | flat after warm-up | 112.8 → 113.4 MB (+0.6 MB over 9 min) | 113.3 → 121.0 MB (+7.7 MB), rising during min 1–7 then **flat at 121.0 MB for the last 4 min** |
| | State updates received / retransmissions | | 67 062 / 0 (kernel) | 65 240 / 1 |

The UDP rise-then-plateau matches the metrics module's sample buffers, which are capped at 20 000 entries
(`server/common/metrics.js`). It is bounded, not a leak, but this is inferred from the shape, not
heap-profiled. Raw samples: `logs/verify/soak-{tcp,udp}.json`.

## 6. Summary

| Area | TCP | UDP |
|---|---|---|
| Automated: reliability unit tests | 16/16 PASS (shared) | |
| Automated: e2e | 24/24 PASS | 24/24 PASS |
| Automated: fuzz | 7/7 PASS | 4/4 PASS |
| Browser smoke (2 tabs) | PASS | PASS |
| Browser 3-player full flow | 28/28 PASS (1 earlier intermittent FAIL, explained †) | 28/28 PASS (1 earlier intermittent FAIL, explained †) |
| Protocol purity | PASS | PASS |
| Bad-network drill + frozen + killed | 15/15 PASS | 15/15 PASS |
| Soak 10 min | PASS | PASS |

## 7. NOT tested (needs several machines / real networks)

- **4 separate computers** (1 server + 3 clients). Everything ran on one laptop; real LAN/Wi-Fi behaviour
  (client isolation on campus Wi-Fi, Windows firewall prompts on other laptops, ARP/Wi-Fi power-save
  latency) is untested.
- **Cross-network bonus** (VPS + different hotspots, NAT, public IPs): no VPS was available. `netcheck.js`
  and the runbook were only run against localhost.
- **Real packet loss**: all loss/delay came from our simulator (`simnet.js`), not from a real network or
  an OS-level tool (clumsy / tc netem).
- **Real Wi-Fi switched off** on a client: simulated by process suspend (frozen) and process kill.
- **Real reconnect after a network outage in the browser** (bridge re-login with resume token): tested
  with bots (`run-all`), not by turning Wi-Fi off and on.
- **Real in-game frags** feeding the scoreboard (see * above): run one manual match.
- **macOS / Linux clients**, Firefox/Safari, projector readability.
- Long sessions (> 10 min) and more than one room playing at once in the browser.
