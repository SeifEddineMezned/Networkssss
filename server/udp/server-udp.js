#!/usr/bin/env node
// PvP Arena - UDP-only game server (raw `dgram`, no TCP anywhere).
// Usage: node server/udp/server-udp.js [--port 9001] [--host 0.0.0.0] [--sim-loss 0.1 --sim-delay 80 ...]
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { C, safeParse } = require('../common/protocol');
const { Session } = require('../common/session');
const { Metrics } = require('../common/metrics');
const { SimNet, parseSimArgs } = require('../common/simnet');
const { ReliableEndpoint, parseDatagram } = require('../common/reliable');

const argv = process.argv.slice(2);
const arg = (k, def) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : def; };
const PORT = +arg('--port', 9001);
const HOST = arg('--host', '0.0.0.0');
const HEARTBEAT_MS = 1000, TIMEOUT_MS = 5000, STATE_HZ = 30, MAX_PEERS = 64;

const metrics = new Metrics('server-udp');
const sim = new SimNet(parseSimArgs(argv), 'datagram', metrics);
const sock = dgram.createSocket('udp4');
const byToken = new Map();     // session token -> peer
const byNonce = new Map();     // `${addr}|${nonce}` -> peer (makes the handshake idempotent)
const draining = new Map();    // token -> dropped peer whose last reliable messages are still being retransmitted

process.on('uncaughtException', e => console.error('[UDP] uncaughtException (server keeps running):', e && e.stack || e));
process.on('unhandledRejection', e => console.error('[UDP] unhandledRejection:', e));

const session = new Session({
  transport: 'UDP',
  metrics,
  heartbeatTimeout: TIMEOUT_MS,
  accountsFile: arg('--accounts', path.join(__dirname, '..', 'data', 'accounts.json')),
  send(peer, msg, reliable) {
    if (!reliable && msg.t === C.DATA && Array.isArray(msg.d) && Array.isArray(msg.d[0]) && !(msg.d[1] && msg.d[1].length)) {
      // Batch player state per receiver: keep only the newest state of each player, flush at STATE_HZ.
      for (const item of msg.d[0]) if (item && item.id !== undefined) peer.pendingState.set(item.id, item);
      return;
    }
    peer.ep.send(msg, reliable);
  },
});
session.onDropped = (peer) => {
  byToken.delete(peer.token);
  byNonce.delete(peer.nonceKey);
  // Keep the reliability endpoint alive for 2 s so the last reliable messages (e.g. "you were
  // replaced", final GAME_RESULT) still get retransmitted/acked, then say BYE.
  draining.set(peer.token, peer);
  setTimeout(() => {
    draining.delete(peer.token);
    try { rawSend({ h: 'BYE', reason: 'dropped' }, peer.port, peer.address); } catch (e) { }
  }, 2000);
};

function rawSend(obj, port, address) {
  const buf = Buffer.from(JSON.stringify(obj));
  metrics.inc('bytesOut', buf.length);
  sim.send(() => sock.send(buf, port, address));
}

function handshake(p, rinfo) {
  if (typeof p.n !== 'string' || p.n.length > 32) return;
  const key = `${rinfo.address}:${rinfo.port}|${p.n}`;
  let peer = byNonce.get(key);
  if (!peer) {
    if (byToken.size >= MAX_PEERS) return rawSend({ h: 'FULL' }, rinfo.port, rinfo.address);
    const token = crypto.randomBytes(6).toString('hex');
    peer = { id: crypto.randomBytes(3).toString('hex'), token, nonceKey: key, address: rinfo.address, port: rinfo.port,
      addr: `${rinfo.address}:${rinfo.port}`, pendingState: new Map() };
    peer.ep = new ReliableEndpoint({
      token: null, metrics,
      sendDatagram: buf => { metrics.inc('bytesOut', buf.length); sim.send(() => sock.send(buf, peer.port, peer.address)); },
      deliver: (msg, reliable) => session.handle(peer, msg, reliable),
      onFail: why => { session.log(`reliability gave up on ${peer.user || peer.id}: ${why}`); session.drop(peer, 'retransmitTimeout'); },
    });
    byToken.set(token, peer);
    byNonce.set(key, peer);
    session.addPeer(peer);
  }
  rawSend({ h: 'WELCOME', n: p.n, s: peer.token, id: peer.id, transport: 'UDP', heartbeatMs: HEARTBEAT_MS, timeoutMs: TIMEOUT_MS }, rinfo.port, rinfo.address);
}

sock.on('message', (buf, rinfo) => {
  try {
    metrics.inc('bytesIn', buf.length); metrics.inc('datagramsIn');
    if (buf.length > 4096) { metrics.inc('oversizeIn'); return; }
    const raw = safeParse(buf.toString('utf8'));
    if (!raw || typeof raw !== 'object') { metrics.inc('badJson'); return; }
    if (raw.h === 'HELLO') return handshake(raw, rinfo);
    const peer = typeof raw.s === 'string' && (byToken.get(raw.s) || draining.get(raw.s));
    if (!peer) { metrics.inc('unknownToken'); return; }   // unknown/forged session token: ignore
    const p = parseDatagram(buf);
    if (!p) { metrics.inc('badHeader'); return; }
    if (peer.address !== rinfo.address || peer.port !== rinfo.port) {
      session.log(`address change for ${peer.user || peer.id}: ${peer.addr} -> ${rinfo.address}:${rinfo.port} (NAT rebinding)`);
      peer.address = rinfo.address; peer.port = rinfo.port; peer.addr = `${rinfo.address}:${rinfo.port}`;
    }
    session.touch(peer);
    peer.ep.receive(p);
  } catch (e) { console.error('[UDP] message handler error (ignored):', e && e.message); }
});
sock.on('error', e => { console.error('[UDP] socket error:', e.message); if (e.code === 'EADDRINUSE') process.exit(1); });

setInterval(() => { for (const peer of byToken.values()) peer.ep.tick(); for (const peer of draining.values()) peer.ep.tick(); }, 20);
setInterval(() => {
  for (const peer of byToken.values()) {
    if (!peer.pendingState.size) continue;
    peer.ep.send({ t: C.DATA, d: [Array.from(peer.pendingState.values()), []] }, false);
    peer.pendingState.clear();
  }
}, Math.round(1000 / STATE_HZ));
setInterval(() => {
  const ts = Date.now();
  for (const peer of byToken.values()) peer.ep.send({ t: C.PING, d: { ts } }, false);
}, HEARTBEAT_MS);
setInterval(() => session.tick(), 250);
setInterval(() => metrics.writeJson(path.join(__dirname, '..', '..', 'logs', `server-udp-${PORT}.json`)), 5000);

sock.bind(PORT, HOST, () => {
  console.log(`[UDP] PvP arena UDP server listening on ${HOST}:${PORT}  (heartbeat ${HEARTBEAT_MS} ms, drop after ${TIMEOUT_MS} ms silence)`);
  if (sim.active) console.log('[UDP] network simulator ON:', JSON.stringify(sim.o));
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list) if (n.family === 'IPv4' && !n.internal) console.log(`[UDP]   reachable at ${n.address}:${PORT}`);
});
