# PvP Arena: TCP-only and UDP-only versions

Computer Networks project #2. A competitive 1–4 player arena shooter (based on kesiev/pvp, see
`NOTICE.md`), shipped in **two versions of the same game**: one where every byte between machines
goes over **raw TCP** (`net`), one where it goes over **raw UDP** (`dgram`, no TCP anywhere).

- Server: `server/tcp/server-tcp.js` (port 9000) or `server/udp/server-udp.js` (port 9001)
- Client machine: `bridge/bridge.js` + a browser on `http://localhost:8080`
- **No npm install needed**: zero dependencies, only Node.js ≥ 18 (tested with Node 24.15).

```
 laptop 2..4                                             laptop 1 / VPS
 ┌───────────────────────┐                               ┌──────────────────────────┐
 │ Browser (PvP UI)      │                               │ server-tcp.js  :9000/tcp │
 │   │ WebSocket         │      raw TCP  or  raw UDP     │        or                │
 │   │ 127.0.0.1 ONLY    │ ════════════════════════════► │ server-udp.js  :9001/udp │
 │ bridge.js ────────────┼───────────────────────────────┤ (session.js: accounts,   │
 └───────────────────────┘                               │  lobby, rooms, scores)   │
                                                         └──────────────────────────┘
```

A browser cannot open raw TCP/UDP sockets, so every player runs a tiny local **bridge** that serves the
game page and relays it to the server through a raw socket. The browser↔bridge WebSocket is bound to
`127.0.0.1` and never leaves the machine. **The only link between machines is the raw TCP or UDP socket.**

---

## 0. Prerequisites (every laptop)

1. Install Node.js 18+ (https://nodejs.org, LTS). Check: `node -v`.
2. Copy this folder to every laptop (USB / git clone). No `npm install`.
3. Use Chrome, Edge or Firefox.

## 1. Find the server's IP (laptop 1)

| OS | Command |
|---|---|
| Windows | `ipconfig` → "IPv4 Address" of the Wi-Fi adapter (e.g. 192.168.1.23). The server also prints it at startup. |
| macOS | `ipconfig getifaddr en0` |
| Linux | `hostname -I` |

## 2. Open the server's firewall (laptop 1, once)

**Windows** (PowerShell **as Administrator**):
```powershell
New-NetFirewallRule -DisplayName "PvP TCP 9000" -Direction Inbound -Protocol TCP -LocalPort 9000 -Action Allow
New-NetFirewallRule -DisplayName "PvP UDP 9001" -Direction Inbound -Protocol UDP -LocalPort 9001 -Action Allow
```
(Or accept the "Allow Node.js" pop-up the first time, ticking **both Private and Public** networks.
Hotspots are often classified as "Public".)

**macOS**: System Settings → Network → Firewall → Options → allow incoming connections for `node`.
Or temporarily: `sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which node) && sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp $(which node)`

**Linux**: `sudo ufw allow 9000/tcp && sudo ufw allow 9001/udp`

Client laptops need no firewall changes (they only make outgoing connections).

## 3. Run the TCP version

Laptop 1 (server):
```bash
node server/tcp/server-tcp.js --port 9000
```
Laptops 2, 3, 4 (clients), with `SERVER_IP` from step 1:
```bash
node bridge/bridge.js --proto tcp --server SERVER_IP:9000
```
Then open **http://localhost:8080** in the browser on each client laptop.

## 4. Run the UDP version

Laptop 1:
```bash
node server/udp/server-udp.js --port 9001
```
Laptops 2, 3, 4:
```bash
node bridge/bridge.js --proto udp --server SERVER_IP:9001
```
Open **http://localhost:8080**. The lobby shows "Transport: raw UDP".

The commands are identical on Windows (PowerShell/cmd), macOS and Linux. Run them from the repo root.
npm shortcuts: `npm run server:tcp`, `npm run server:udp`, `npm run bridge:tcp -- --server IP:9000`.

## 5. Playing

1. **Register** (first time) or **Login**. Accounts are stored on the server (`server/data/accounts.json`,
   salted scrypt hashes).
2. **Lobby**: room list (name, players, waiting/playing, host). **Create & join** or **Join**.
3. **Room** (PvP's netplay screen + side panel with players, ready state and ping): everyone holds
   **FIRE** to get ready. When everyone (≥ 2) is ready, the 👑 host's game starts for all.
   The host can change the game mode/score limit in the PvP setup menu (arrow keys).
4. **Play**: default keyboard: **W/S** move, **A/D** turn, **F** strafe, **G** fire, **H** action (arrows + Enter in menus, hold **1** = cancel/abort). Live
   scoreboard on the right (server-authoritative).
5. **Game over**: final ranking and winner from the server. "Back to room" plays again.
6. Leave: "Leave room" button (or hold **1** in the room screen / in game to abort). Closing the tab = clean disconnect.
7. **F3** toggles the network HUD (RTT, jitter, packets, bytes, retransmissions, dup/out-of-order,
   lost state updates, desync corrections).

## 6. Options

| Flag | Where | Meaning |
|---|---|---|
| `--port N` / `--host IP` | servers | listen port/interface (default 9000/9001, 0.0.0.0) |
| `--proto tcp\|udp --server HOST:PORT` | bridge | which version / which server |
| `--ui-port N` | bridge | local browser port (default 8080; use 8081 to run 2 clients on one PC) |
| `--sim-loss 0.1 --sim-delay 80 --sim-jitter 20 --sim-dup 0.02 --sim-reorder 0.05` | servers + bridges | network simulator on every outgoing packet |
| `--accounts FILE` | servers | account database path |

## 7. Tests and measurements (no extra machines needed)

```bash
npm test                 # reliability unit tests + full e2e (both versions) + fuzz
node test/run-all.js     # 23 checks x 2 versions: register/login/lobby/rooms/start/play/scores/result/disconnects
node test/run-all.js udp --sim-loss 0.1 --sim-delay 50     # same under 10% loss
node test/fuzz.js        # malformed/oversized/split/forged/out-of-order input never crashes a server
npm run bench            # TCP vs UDP under 3 network profiles -> docs/RESULTS.md
node test/browser-smoke.js   # real headless Chrome/Edge: 2 players register, join, ready, play, drop
npm run verify:tcp           # 3 real browser tabs + 3 bridges, full feature flow, screenshots -> logs/verify (also verify:udp)
npm run drill:udp            # bad network on one bridge, frozen + killed bridge (also drill:tcp)
npm run soak:tcp             # 10 min, 3 bots, memory / errors / desync (also soak:udp)
# full results: docs/TEST_CHECKLIST.md
node scripts/netcheck.js SERVER_IP    # reachability + RTT from this machine (run before the demo)
node test/bot.js --proto udp --server IP:9001 --room ROOM1   # extra headless player for a room
```

## 8. Cross-network (bonus)

See `scripts/deploy/RUNBOOK.md`: VPS setup, cloud firewall rules, systemd units, log commands,
Tailscale fallback.

## Repository map

```
client/                 PvP game (original) + our files: js/netplay-raw.js, js/raw-lobby.js (+17 hook lines)
server/common/          protocol.js session.js reliable.js framing.js metrics.js simnet.js
server/tcp/server-tcp.js
server/udp/server-udp.js
bridge/                 bridge.js tcp-client.js udp-client.js
test/                   bot.js run-all.js fuzz.js reliable.test.js bench.js browser-smoke.js
scripts/                netcheck.js deploy/
docs/                   README ARCHITECTURE RESULTS SLIDES DEMO_SCRIPT
server-lan/             ORIGINAL upstream socket.io server, NOT part of our deliverable
```
