# Slides (7): PvP Arena over raw TCP vs raw UDP

Numbers come from `docs/RESULTS.md` (`npm run bench`, 3 bots + server, simulator on every hop).
**Re-run `npm run bench` on demo eve and paste the fresh numbers.** If you also run a real cross-network
test, add its `netcheck` RTTs to slide 7.

---

## Slide 1: What we built
- Competitive 1–4 player arena shooter (based on open-source PvP, credited), **2 versions, same game**:
  raw **TCP** (`net`, :9000) and raw **UDP** (`dgram`, :9001, *no TCP anywhere*).
- 1 server + 3 clients on 4 machines. All 7 features in both: register/login, lobby + rooms, join/leave,
  start/end + session status, real-time play, server scoreboard + ranking + winner, disconnect handling.
- Browsers can't open raw sockets → each player runs a local **bridge** (serves the page, WebSocket on
  127.0.0.1 only). The bridge's `--proto` flag decides TCP vs UDP: identical game code on both.
- Diagram: Browser ⇄(localhost WS)⇄ bridge ══raw TCP/UDP══► server (session.js shared).

## Slide 2: Socket architecture: TCP version
- `net` server, `setNoDelay(true)`, one socket per player.
- **Friction #1: TCP is a stream, not messages** → 4-byte length prefix + JSON, a reassembler for split
  and glued frames (fuzz-tested: 1 byte at a time, 20 frames in one chunk, 4 GB length prefix).
- Disconnects: FIN/RST → instant (measured **1 ms** for a killed client); half-open (Wi-Fi off) → only
  our heartbeat sees it: PING 2 s, drop after 6 s (measured **≈ 6.1 s**).
- Backpressure: > 32 KB queued → drop stale position updates, never events.
- Everything reliable and ordered "for free" from the kernel.

## Slide 3: Socket architecture: UDP version
- `dgram` server; handshake HELLO(nonce) → WELCOME(token); token on every datagram (spoofed/unknown
  ignored; NAT port change followed).
- **Our own reliability layer** (≈ 150 lines): seq numbers, cumulative ACK + 32-bit SACK bitmask,
  RTO from SRTT/RTTVAR (RFC 6298, Karn), exponential backoff, de-dup, in-order buffer, give up after 8 tries.
- Two channels: **reliable ordered** (login, rooms, start, shots/kills, scores, results) and
  **unreliable sequenced** (positions 30 Hz; old ones dropped; next one heals the loss).
- Disconnects: heartbeat 1 s / timeout 5 s (measured **≈ 5.0–5.4 s**), reliability give-up ≈ 5.5 s,
  explicit BYE on tab close (instant). No FIN in UDP → a killed client is only seen by the heartbeat.
- **Friction #2:** we had to rebuild what TCP gives for free; our unit tests caught a real bug (ACKs that
  could never cover an old retransmission → added a cumulative ACK, like TCP's).

## Slide 4: Metrics we defined
| Metric | Definition |
|---|---|
| Perceived lag | time from a player sampling its position to another player receiving it |
| Freeze / desync after loss | time between two updates of the same remote player |
| Reliable event latency | shot event sent → received by the others |
| Dropped updates | position updates never delivered (lost or superseded) |
| Retransmissions, dup, out-of-order | counters of our UDP layer |
| Disconnect detection time | last packet from a frozen client → PLAYER_DROPPED |
| Bandwidth | kbit/s per client |

Profiles: clean LAN · 5 % loss (+20 ms) · 10 % loss + 100 ms delay + jitter/dup/reorder (per hop).

## Slide 5: Results (from RESULTS.md)
| | TCP clean | UDP clean | TCP 5 % | UDP 5 % | TCP 10 %+100 ms | UDP 10 %+100 ms |
|---|---|---|---|---|---|---|
| Perceived lag avg / max (ms) | 0.3 / 1 | 23 / 32 | 169 / **1520** | 81 / **95** | 541 / **1798** | 236 / **311** |
| Freeze max (ms) | 48 | 63 | **1427** | 217 | **1563** | 434 |
| Event latency p95 (ms) | 1 | 1 | 417 | 64 | 1298 | 355 |
| Updates not delivered | 0 % | 0 % | 0 % | 11 % | 0 % | 32 % |
| Disconnect detection (ms) | 6076 | 5071 | 6226 | 5139 | 6280 | 5441 |

Takeaway: TCP never loses an update but **delivers them late** (head-of-line blocking): stutter and
1.5 s+ spikes. UDP **loses** updates, but the next one arrives on time: smooth movement, bounded lag.

## Slide 6: Where each protocol won, and simultaneous players
- **UDP wins**: real-time movement under loss (5–6× lower worst-case lag), reliable events too (our
  per-message retransmit doesn't block unrelated positions), faster disconnect detection.
- **TCP wins**: clean LAN (≈ 0 ms extra; our UDP batching adds ≈ 20 ms), simplicity (no reliability code),
  instant detection of crashed/closed clients (FIN/RST), firewall/NAT-friendliness (campus Wi-Fi), 25 %
  less bandwidth (no acks/headers per datagram).
- **Honest losses for UDP**: 11–32 % of position updates never arrive (invisible thanks to prediction),
  more bandwidth, and much more code to get right.
- Simultaneous players: one event loop, per-player socket (TCP) / per-token endpoint (UDP); rooms
  isolated; the UDP server batches all players' states into one datagram per receiver (60 Hz); 4-player cap.

## Slide 7: Disconnections and cross-network demo
- Drop → `PLAYER_DROPPED` (+ reason + detection time) → player removed from the arena → host hand-over →
  game continues; < 2 players → result with the winner. Server never crashes (fuzz test: random bytes,
  60 KB datagrams, forged tokens, absurd seq numbers, connect storms).
- Bridge auto-reconnects (2 s) and re-logs in.
- **Bonus:** server on a VPS with a public IP (ports 9000/tcp + 9001/udp open in ufw **and** the cloud
  firewall), clients on campus Wi-Fi + 2 phone hotspots → 3 different public IPs in the server log
  (`netcheck` screenshots). PaaS can't do this (no raw UDP).
