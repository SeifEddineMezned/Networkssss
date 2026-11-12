#!/usr/bin/env node
// PvP Arena - TCP-only game server (raw `net` sockets, no HTTP/WebSocket/socket.io).
// Usage: node server/tcp/server-tcp.js [--port 9000] [--host 0.0.0.0] [--sim-loss 0.05 --sim-delay 50 ...]
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { C } = require('../common/protocol');
const { encodeFrame, FrameReader } = require('../common/framing');
const { Session } = require('../common/session');
const { Metrics } = require('../common/metrics');
const { SimNet, parseSimArgs } = require('../common/simnet');

const argv = process.argv.slice(2);
const arg = (k, def) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : def; };
const PORT = +arg('--port', 9000);
const HOST = arg('--host', '0.0.0.0');
const HEARTBEAT_MS = 2000, TIMEOUT_MS = 6000;
const STATE_BACKLOG_LIMIT = 32 * 1024;   // bytes queued in the kernel/user buffer before we drop state updates

const metrics = new Metrics('server-tcp');
const sim = new SimNet(parseSimArgs(argv), 'stream', metrics);

process.on('uncaughtException', e => console.error('[TCP] uncaughtException (server keeps running):', e && e.stack || e));
process.on('unhandledRejection', e => console.error('[TCP] unhandledRejection:', e));

const session = new Session({
  transport: 'TCP',
  metrics,
  heartbeatTimeout: TIMEOUT_MS,
  accountsFile: arg('--accounts', path.join(__dirname, '..', 'data', 'accounts.json')),
  send(peer, msg, reliable) {
    const sock = peer.sock;
    if (!sock || sock.destroyed) return;
    // Backpressure: a slow receiver must not make us queue state updates forever.
    // Position updates are superseded by the next one 33 ms later, so stale ones are dropped.
    if (!reliable && sock.writableLength > STATE_BACKLOG_LIMIT) { metrics.inc('stateDroppedBackpressure'); return; }
    const frame = encodeFrame(msg);
    metrics.inc('msgsOut'); metrics.inc('bytesOut', frame.length);
    sim.send(() => { if (!sock.destroyed) { const ok = sock.write(frame); if (!ok) metrics.inc('writeReturnedFalse'); } }, peer.id);
  },
});
session.onDropped = (peer) => { try { peer.sock.destroy(); } catch (e) { } };

const server = net.createServer(sock => {
  const peer = { id: crypto.randomBytes(3).toString('hex'), addr: `${sock.remoteAddress}:${sock.remotePort}`, sock };
  sock.setNoDelay(true);          // disable Nagle: we send small, latency-sensitive frames
  sock.setKeepAlive(true, 5000);  // OS keepalive as a second line of defence (app heartbeat is primary)
  const reader = new FrameReader();
  session.addPeer(peer);
  session.send(peer, C.WELCOME, { id: peer.id, transport: 'TCP', heartbeatMs: HEARTBEAT_MS, timeoutMs: TIMEOUT_MS });

  sock.on('data', chunk => {
    metrics.inc('bytesIn', chunk.length);
    let res;
    try { res = reader.push(chunk); }
    catch (e) { metrics.inc('protocolViolations'); session.log(`protocol violation from ${peer.addr}: ${e.message}`); session.drop(peer, 'protocolError'); return; }
    if (res.bad) metrics.inc('badJson', res.bad);
    for (const m of res.msgs) { metrics.inc('msgsIn'); session.handle(peer, m, true); }
  });
  sock.on('error', e => { metrics.inc('socketErrors'); session.drop(peer, 'error:' + (e.code || e.message)); });
  sock.on('close', () => session.drop(peer, 'closed'));
});
server.on('error', e => { console.error('[TCP] server error:', e.message); if (e.code === 'EADDRINUSE') process.exit(1); });

setInterval(() => {
  const ts = Date.now();
  for (const peer of session.peers.values()) session.send(peer, C.PING, { ts }, false);
}, HEARTBEAT_MS);
setInterval(() => session.tick(), 250);
setInterval(() => metrics.writeJson(path.join(__dirname, '..', '..', 'logs', `server-tcp-${PORT}.json`)), 5000);

server.listen(PORT, HOST, () => {
  console.log(`[TCP] PvP arena TCP server listening on ${HOST}:${PORT}  (heartbeat ${HEARTBEAT_MS} ms, drop after ${TIMEOUT_MS} ms silence)`);
  if (sim.active) console.log('[TCP] network simulator ON:', JSON.stringify(sim.o));
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list) if (n.family === 'IPv4' && !n.internal) console.log(`[TCP]   reachable at ${n.address}:${PORT}`);
});
