# Architecture

## 1. Process view (identical for both versions; only the socket type changes)

```
 Client machine (x3)                                       Server machine (laptop 1 or VPS)
 ┌──────────────────────────────────────────┐              ┌───────────────────────────────────────────┐
 │ Browser tab  http://localhost:8080       │              │ server-tcp.js (net, :9000)                 │
 │  PvP engine (client/js/*.js, unchanged)  │              │   or server-udp.js (dgram, :9001)          │
 │  NetplayRaw  (netplay-raw.js)            │              │   ├─ transport: framing / reliability,     │
 │  Lobby overlay (raw-lobby.js)            │              │   │   heartbeat, backpressure, simulator   │
 │     │ WebSocket, bound to 127.0.0.1      │              │   └─ session.js (same file for both)       │
 │ bridge.js                                │  raw TCP     │       accounts (scrypt, JSON file)         │
 │  ├─ static file server (127.0.0.1:8080)  │  or raw UDP  │       lobby + rooms (wraps PvP's           │
 │  ├─ tcp-client.js | udp-client.js  ──────┼─────────────►│         NetplayServer)                     │
 │  └─ simulator, metrics, reconnect        │              │       start rules, relay, scoreboard,      │
 └──────────────────────────────────────────┘              │       results, disconnect handling          │
                                                           └───────────────────────────────────────────┘
```

Browsers cannot open raw TCP/UDP sockets, so the bridge is required. The WebSocket exists **only on
127.0.0.1** (the bridge listens on `127.0.0.1`, not `0.0.0.0`), so it never crosses the network. The
browser does not choose TCP or UDP. The bridge's `--proto` flag decides, which guarantees that both
versions run byte-for-byte the same game, lobby and UI code.

## 2. Decisions recorded (and deviations from the original brief)

| Topic | Decision | Why |
|---|---|---|
| `./game/` folder | The repo **is** the kesiev/pvp clone (it was already cloned into this folder), so `client/` = the game. No nested clone. | Avoid duplicating the game; license files stay in the root. |
| Lobby UI | **DOM overlay** (`client/js/raw-lobby.js`) for login/register, room list, create/join/leave, room status with pings, scoreboard, results, link-lost banner, F3 HUD. Ready/start reuses PvP's own netplay screen (hold FIRE; host starts). | PvP's canvas menu has a 6-char nickname keyboard and no text password input; extending it would touch rendering code. |
| Room engine | PvP's `NetplayServer` (`client/js/netplay-server.js`) is reused unchanged except for 1 new method (`unfreezeRoom`) and 2 bug fixes (`roomTimeLimit==` typo, undefined `serverLog` that would crash on room timeout). | Same semantics as the original game. |
| WebSocket | Hand-written RFC 6455 server (~60 lines in bridge.js) instead of the `ws` package. | Zero dependencies: no `npm install` on 4 laptops on demo day. Localhost only. |
| Authority | Gameplay stays client-simulated with prediction (original PvP design). The **server is authoritative for accounts, rooms, start rules, scoreboard and results**. | Server-side physics would mean rewriting the engine (out of scope). |
| Score source | The victim's own client reports its death (`SCORE_EVENT`, reliable). The server only accepts a death report from the victim's own session, rate-limits it (≥ 400 ms), keeps the score and decides the end (score limit, < 2 players, or host's timer end). | A client cannot award itself kills. Ranking = frags (kills; suicide −1). The game-mode HUD of non-deathmatch modes may differ from the server ranking: use the default deathmatch modes for the demo. |
| Host | Host = first player in join order. If the host leaves/drops, the next player becomes host (`HOST_CHANGED`), and the game's `netMaster` follows (1-line hook in `game.js`). | |
| TCP disconnect | `close`/`error` events (RST/FIN → instant) **plus** app heartbeat: PING every 2 s, drop after 6 s silence (catches half-open: Wi-Fi off, frozen process). OS keep-alive also on. | |
| UDP disconnect | Heartbeat 1 s, drop after 5 s silence; reliability layer gives up after 8 tries (≈ 5.5 s); explicit `BYE` on clean exit (tab closed). | UDP has no FIN. |
| Reconnect | Bridge reconnects every 2 s and re-logs in transparently with the cached credentials. The player is back in the lobby (a dropped player is not re-inserted in a running game). | Re-inserting a player into PvP's running simulation would need engine changes. |
| Batching | UDP server batches player states per receiver at 60 Hz (keeps the newest per player). TCP relays immediately. | Fewer datagrams; measured cost ≈ +20 ms state age on a clean LAN (see RESULTS.md). |

## 3. Message schema (`server/common/protocol.js`), same for both transports

Payload: JSON `{t: code, d: data}`. Every message < 1200 bytes.

| Code | Name | Dir | Channel (UDP) | Payload |
|---|---|---|---|---|
| 0 | JOINROOM | C→S | R | `[roomId, nick, setup]` |
| 1 | LEAVEROOM | C→S | R | – |
| 2 | SETCONFIRM | C→S | R | `true/false` (ready) |
| 3 | FREEZEROOM | C→S | R | game settings (start, host only, ≥2 ready) |
| 4 | UPDATESETUP | C→S | R | setup (host only) |
| 5 | BROADCAST | C→S | **U** for positions, **R** for events | `[[{id,data:[id,playing,walking,x,y,angle]}], [events]]` |
| 6 | SENDEVENT | C→S | R | `[targetPlayerId, event]` |
| 7 | ROOMCONFIG | S→C | R | `{setup, players:[{name,id,isYou,confirm}]}` |
| 8 | DATA | S→C | U / R | relayed BROADCAST |
| 9 | EVENT | S→C | R | relayed SENDEVENT |
| 10 | ROOMFROZEN | S→C | R | game start + settings |
| 11/12 | SETUP / CONFIRM | S→C | R | |
| 20/21 | HELLO / WELCOME | both | handshake | UDP: `{h:'HELLO',n:nonce}` → `{h:'WELCOME',n,s:token,id}`; TCP: WELCOME on connect |
| 22/23 | REGISTER / LOGIN | C→S | R | `{user, pass}` |
| 24/25 | AUTH_OK / AUTH_FAIL | S→C | R | `{user,id}` / `{msg}` |
| 26/27 | ROOM_LIST_REQ / ROOM_LIST | both | R | `[{id,name,players,max,status,host,users}]` |
| 28 | CREATE_ROOM | C→S | R | `{name}` |
| 29/30 | PLAYER_LEFT / PLAYER_DROPPED | S→C | R | `{id,user,reason,detectMs}` |
| 31 | SCORE_EVENT | C→S | R | `{kind:'kill'|'suicide', victim, killer}` |
| 32 | SCOREBOARD | S→C | R | `{ranking:[{user,score,kills,deaths,rank}], scoreLimit}` (on change + every 1 s) |
| 33 | GAME_RESULT | S→C | R | `{reason, ranking, winner, draw, durationMs}` |
| 34/35 | PING / PONG | both | U | `{ts}`: heartbeat + RTT |
| 36 | ERROR | S→C | R | `{code,msg}` |
| 37 | BYE | C→S | U (x2) | clean exit (UDP) |
| 38 | GAME_END_REQ | C→S | R | host's game timer ended |
| 39 | LOGOUT | C→S | R | |
| 40 | HOST_CHANGED | S→C | R | `{id,user}` |
| 41 | ROOM_JOINED | S→C | R | `{room}` |
| 42 | SESSION_STATUS | S→C | U | `{room,status,players:[{user,host,ready,ping}]}` every 1 s |

Every incoming message is validated (`validateClient`: type whitelist + payload schema); invalid ones are
counted and ignored. Every handler is wrapped in try/catch, plus `process.on('uncaughtException')`.

## 4. TCP version

- `net.createServer`, `setNoDelay(true)` (Nagle off: small latency-sensitive frames), `setKeepAlive`.
- **Framing** (`server/common/framing.js`): `[uint32 BE length][UTF-8 JSON]`. `FrameReader` accumulates
  bytes, extracts every complete frame from one chunk (coalesced writes), keeps partial frames for the
  next chunk, and rejects frames > 64 KB (connection closed as a protocol violation).
  *Friction point: TCP is a byte stream, not a message protocol.* Fuzz test sends a frame 1 byte at a
  time and 20 frames in one write.
- **Backpressure**: if a socket has > 32 KB queued, position-only updates for it are dropped (they are
  superseded 33 ms later) instead of growing an unbounded queue. Events are never dropped.
- **Head-of-line blocking**: one lost segment delays every following byte until the kernel retransmits
  (RTO ≥ 200 ms). Measured in RESULTS.md: max perceived lag 1.5–1.8 s under 5–10 % loss.

## 5. UDP version

- `dgram` `udp4`. Handshake: client repeats `HELLO{nonce}` every 500 ms until `WELCOME{nonce, token}`
  (idempotent per address+nonce). Every later datagram carries the token `s`; unknown tokens are ignored
  (anti-spoofing). Peers are keyed by token, not address: if a NAT changes the client's port the server
  logs "address change (NAT rebinding)" and follows it.
- **Reliability layer** (`server/common/reliable.js`, shared by server and bridge):
  header `{s, c, q, k, a, b}`.
  - `c:'R'` RELIABLE ORDERED: seq `q`, receiver delivers in order (out-of-order ones buffered, up to 512),
    discards duplicates, acks with cumulative `k` (all ≤ k received) + selective `a` (highest) + 32-bit
    bitmask `b`. Sender retransmits after RTO (RFC 6298 SRTT/RTTVAR, Karn's rule, initial 100 ms, min 60,
    exponential backoff capped at 1 s). After 8 tries the peer is considered dead (≈ 5.5 s).
  - `c:'U'` UNRELIABLE SEQUENCED: never retransmitted; receiver drops anything older than the newest seq
    seen (stale/duplicate). Used for positions, PING/PONG, SESSION_STATUS.
  - `c:'A'` pure ACK.
- **What goes where**: login, rooms, ready, start, events (shots/hits/kills), score events, scoreboards,
  results → R. Player positions → U. The bridge splits PvP's mixed BROADCAST packet into an R part
  (events) and a U part (positions).
- **Loss healing**: PvP sends the *full* player state every frame (30 Hz), so one lost update is healed by
  the next one; the predictor (`netplay-config.js`) extrapolates in between.
- **Size**: positions quantized (x,y 0.01, angle 0.001); typical datagram 100–300 B; `oversizePackets`
  counter if any message exceeded 1200 B (none observed).
- Dropped sessions keep their reliability endpoint for 2 s ("draining") so the last reliable messages
  (e.g. GAME_RESULT, "logged in elsewhere") are still retransmitted, then the server sends `BYE`.

## 6. Disconnection handling (both)

```
detect (transport) ─► session.drop(peer, reason)
   ├─ NetplayServer.leaveRoom → ROOMCONFIG to the others
   ├─ PLAYER_DROPPED {user, reason, detectMs} to the room   (UI toast + player removed from the arena)
   ├─ host? → HOST_CHANGED → next player is host (and the game's netMaster)
   ├─ playing and < 2 left → GAME_RESULT (reason notEnoughPlayers)
   └─ empty room → deleted
```
Reasons: `closed` (TCP FIN/RST), `error:*`, `timeout` (heartbeat), `retransmitTimeout` (UDP reliability
gave up), `bye` (UDP clean exit), `replaced` (same user logged in elsewhere), `protocolError`.

## 7. Network simulator (`server/common/simnet.js`)

`--sim-loss --sim-delay --sim-jitter --sim-dup --sim-reorder` on servers, bridges and bots, applied to
every outgoing packet. UDP: per-datagram drop/delay/dup/reorder. TCP: loss is emulated as a kernel
retransmission delay (200 ms doubling) inside a strict FIFO per connection, i.e. head-of-line blocking,
because real TCP never shows loss to the application. For real OS-level impairment use **clumsy**
(Windows) or `tc netem` (Linux): the results should be compared with that caveat.

## 8. Metrics

`server/common/metrics.js`, written every 5 s to `logs/*.json` (servers and bridges): RTT
min/avg/p50/p95/max, jitter (mean |ΔRTT|), packets/bytes in/out, retransmissions, duplicates,
out-of-order, unreliable lost/stale, backpressure drops, invalid messages, heartbeat drops, disconnect
detection time, reconnect time, UI desync corrections (> 0.5 tile between predicted and received
position). Live in the browser with **F3**.
