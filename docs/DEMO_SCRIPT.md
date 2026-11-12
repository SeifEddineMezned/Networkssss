# Demo script (≈ 12 min) + fallbacks

Roles: **S** = server laptop (projector shows the server log), **P1/P2/P3** = player laptops.
Everyone has the repo folder and Node ≥ 18. No `npm install`.

## T−1 day (tonight)
- [ ] On every laptop: `node -v` (≥ 18) and `npm test` on at least one (all checks PASS).
- [ ] On S: open the firewall (docs/README.md §2), note the LAN IP.
- [ ] VPS ready (scripts/deploy/RUNBOOK.md). From each P laptop: `node scripts/netcheck.js VPS_IP` →
      screenshot (shows each network's public IP).
- [ ] Register accounts `alice`, `bob`, `carol` once on each server (TCP and UDP use the same file
      `server/data/accounts.json` when they run on the same machine).
- [ ] Charge phones (hotspots), bring a USB stick with the repo.

## T−10 min (in the room)
1. Everyone joins the same Wi-Fi or hotspot. S: `ipconfig` (Win) / `ipconfig getifaddr en0` (mac).
2. Each P: `node scripts/netcheck.js S_IP`. Both lines OK? Go. If not, see the fallbacks.

## Part A: TCP version (≈ 5 min)
| min | Who | Action | Say / show |
|---|---|---|---|
| 0:00 | S | `node server/tcp/server-tcp.js` | "raw `net` server, port 9000, prints its IPs" |
| 0:30 | P1–P3 | `node bridge/bridge.js --proto tcp --server S_IP:9000`, open http://localhost:8080 | server log: 3 `connect` lines with 3 IPs; bridge = localhost only |
| 1:00 | P1 | Register `alice`; P2 log in with a wrong password | AUTH_FAIL "Wrong password"; duplicate username rejected |
| 1:30 | P1 | Create room `ARENA` | lobby on P2/P3 shows ARENA 1/4 waiting |
| 2:00 | P2, P3 | Join; P3 leaves + rejoins | PLAYER_LEFT toast, list updates |
| 2:30 | all | hold G (fire) → ready; host starts | status waiting → playing on the side panel |
| 3:00 | all | play ~60 s, F3 on P1 | live server scoreboard, ping per player, RTT HUD |
| 4:00 | P3 | **pull the plug**: turn Wi-Fi off | ≈ 6 s later: "carol DISCONNECTED (timeout, detected after … ms)", game continues |
| 4:30 | | let the timer/score limit finish (or P2 closes the tab) | GAME RESULT: ranking + winner from the server |

## Part B: UDP version (≈ 5 min)
| min | Who | Action | Say / show |
|---|---|---|---|
| 5:00 | S | Ctrl+C, `node server/udp/server-udp.js` | "raw `dgram`, port 9001, NO TCP" |
| 5:20 | P1–P3 | Ctrl+C bridges, `node bridge/bridge.js --proto udp --server S_IP:9001` (**P2 adds** `--sim-loss 0.1 --sim-delay 80`), reload the page | lobby says "Transport: raw UDP"; P2 is our "bad network" player |
| 5:40 | | log in, create/join, ready, start, play | same features |
| 7:00 | P1 | F3 HUD | retransmits, dup, out-of-order, lost state updates, srtt/rto |
| 7:30 | P2 | F3 HUD on the lossy player | 10 % of its packets are dropped, yet movement stays smooth and no kill/score is lost; retransmission counter climbs |
| 8:30 | P3 | Wi-Fi off | ≈ 5 s → PLAYER_DROPPED, host hand-over if P3 was host |
| 9:00 | | finish → result | |

## Part C: Cross-network bonus (≈ 2 min)
- Server on the VPS (`journalctl -u pvp-udp -f` on the projector).
- P1 on campus Wi-Fi, P2 on phone hotspot A, P3 on phone hotspot B.
- Show 3 different public IPs in the server log (`connect … from <ip>:<port>`), play 30 s.
- Show the 3 netcheck screenshots from last night.

## Fallbacks
| Problem | Fallback |
|---|---|
| Campus Wi-Fi isolates clients (no client-to-client traffic) | everyone on S's phone hotspot (or the VPS) |
| Windows firewall blocks | rerun the `New-NetFirewallRule` commands as admin; or accept the pop-up for **Public + Private** |
| Port in use | `--port 9100` on the server and the same on bridges; `--ui-port 8090` for a busy 8080 |
| UDP blocked by the network | VPS + hotspot; or show UDP on LAN and the bonus with TCP |
| A laptop dies | run a headless player: `node test/bot.js --proto udp --server S_IP:9001 --room ARENA` |
| VPS down | Tailscale (RUNBOOK fallback): say it's a virtual network |
| A dropped player comes back (Wi-Fi on again) | the bridge reconnects and re-logs in automatically; that player clicks **Leave room** and rejoins after the current game |
| Anything else | `npm test` live on the projector: 46 e2e checks + fuzz over real sockets |
