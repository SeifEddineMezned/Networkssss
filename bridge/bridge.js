#!/usr/bin/env node
// Per-player bridge: the ONLY thing that talks to the game server, using a RAW socket.
//
//   [Browser: PvP UI] <--WebSocket, 127.0.0.1 only--> [bridge.js] <--raw TCP (net) or raw UDP (dgram)--> [server]
//
// Browsers cannot open raw TCP/UDP sockets, so the page talks to this local process, which also
// serves the game files. The WebSocket never leaves the machine (it is bound to 127.0.0.1).
//
// Usage: node bridge/bridge.js --proto tcp|udp --server HOST:PORT [--ui-port 8080] [--sim-loss 0.05 ...]
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { C, NAMES } = require('../server/common/protocol');
const { TcpClient } = require('./tcp-client');
const { UdpClient } = require('./udp-client');
const { Metrics } = require('../server/common/metrics');
const { parseSimArgs } = require('../server/common/simnet');

const argv = process.argv.slice(2);
const arg = (k, def) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : def; };
const PROTO = (arg('--proto', 'tcp') + '').toLowerCase();
if (PROTO !== 'tcp' && PROTO !== 'udp') { console.error('--proto must be tcp or udp'); process.exit(1); }
const SERVER = arg('--server', '127.0.0.1:' + (PROTO === 'tcp' ? 9000 : 9001));
const [SHOST, SPORT] = [SERVER.substring(0, SERVER.lastIndexOf(':')), +SERVER.substring(SERVER.lastIndexOf(':') + 1)];
const UI_PORT = +arg('--ui-port', 8080);
const UI_HOST = arg('--ui-host', '127.0.0.1');
const CLIENT_ROOT = path.resolve(__dirname, '..', 'client');
const sim = parseSimArgs(argv);
const metrics = new Metrics(`bridge-${PROTO}`);
const runId = new Date().toISOString().replace(/[:.]/g, '-');

process.on('uncaughtException', e => console.error('[bridge] uncaughtException (still running):', e && e.stack || e));

const log = (...a) => console.log(new Date().toISOString().substr(11, 12), `[bridge ${PROTO.toUpperCase()}]`, ...a);

// ------------------------------------------------------------------ minimal WebSocket server (RFC 6455, text frames)
// Hand-written so the laptops need no npm install. Localhost-only, single client.
function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0), frag = [];
  const ws = {
    socket,
    send(text) {
      if (socket.destroyed) return;
      const b = Buffer.from(text, 'utf8');
      let h;
      if (b.length < 126) { h = Buffer.from([0x81, b.length]); }
      else if (b.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(b.length, 2); }
      else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(b.length), 2); }
      socket.write(Buffer.concat([h, b]));
    },
    close() { try { socket.write(Buffer.from([0x88, 0])); socket.end(); } catch (e) { } },
    onmessage: null, onclose: null,
  };
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 4 * 1024 * 1024) return socket.destroy();
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const mk = buf.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3]; }
      buf = buf.subarray(need);
      if (op === 0x8) { ws.close(); return; }
      if (op === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 0x1 || op === 0x0) {
        frag.push(payload);
        if (fin) { const text = Buffer.concat(frag).toString('utf8'); frag = []; if (ws.onmessage) ws.onmessage(text); }
      }
    }
  });
  const closed = () => { if (ws.onclose) { const f = ws.onclose; ws.onclose = null; f(); } };
  socket.on('close', closed); socket.on('error', closed);
  return ws;
}

// ------------------------------------------------------------------ static files
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.mp4': 'audio/mp4', '.xm': 'application/octet-stream', '.ico': 'image/x-icon' };

const httpServer = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/raw-config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    return res.end(`window.RAW_BRIDGE=${JSON.stringify({ proto: PROTO.toUpperCase(), server: SERVER, ws: '/ws' })};`);
  }
  const file = path.normalize(path.join(CLIENT_ROOT, url === '/' ? 'index.html' : url));
  if (!file.startsWith(CLIENT_ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ------------------------------------------------------------------ server link
let link = null, linkUp = false, browser = null, creds = null, reconnectTimer = null, downAt = 0, lastRtt = null;

function toBrowser(obj) { if (browser) browser.send(JSON.stringify(obj)); }
function linkStatus(state, extra) { toBrowser(Object.assign({ t: 'link', state, proto: PROTO.toUpperCase(), server: SERVER }, extra || {})); }

function connectLink() {
  clearTimeout(reconnectTimer);
  const Cls = PROTO === 'udp' ? UdpClient : TcpClient;
  link = new Cls({ host: SHOST, port: SPORT, sim, metrics });
  linkStatus('connecting');
  link.on('up', w => {
    linkUp = true;
    const reconnectMs = downAt ? Date.now() - downAt : 0;
    if (downAt) { metrics.sample('reconnectMs', reconnectMs); log(`reconnected after ${reconnectMs} ms`); }
    downAt = 0;
    log(`connected to ${SERVER} over raw ${PROTO.toUpperCase()}, session id ${w.id}`);
    linkStatus('up', { id: w.id, reconnectMs });
    if (creds) link.send({ t: C.LOGIN, d: creds }, true);   // transparent re-login after a reconnect
  });
  link.on('message', (m, reliable) => {
    if (m.t === C.AUTH_FAIL && creds) creds = null;
    toBrowser({ t: m.t, d: m.d });
  });
  link.on('rtt', r => { lastRtt = r; });
  link.on('down', (reason, silence) => {
    linkUp = false;
    downAt = Date.now();
    metrics.inc('linkDown');
    metrics.sample('detectMs', silence);
    log(`connection to server LOST: ${reason} (silence ${silence} ms) - reconnecting in 2 s`);
    linkStatus('down', { reason, silence });
    reconnectTimer = setTimeout(connectLink, 2000);
  });
  link.connect();
}

httpServer.on('upgrade', (req, socket) => {
  if ((req.url || '').split('?')[0] !== '/ws') return socket.destroy();
  if (browser) { log('new browser tab connected, closing the previous one'); try { browser.close(); } catch (e) { } }
  const ws = browser = wsAccept(req, socket);
  log('browser connected');
  linkStatus(linkUp ? 'up' : 'connecting', { id: link && link.welcome && link.welcome.id });
  ws.onmessage = text => {
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'metric') { if (typeof m.k === 'string') { metrics.inc('ui_' + m.k, m.n || 1); if (typeof m.v === 'number') metrics.sample('ui_' + m.k, m.v); } return; }
    if (typeof m.t !== 'number' || !linkUp) return;
    if (m.t === C.LOGIN || m.t === C.REGISTER) creds = { user: m.d && m.d.user, pass: m.d && m.d.pass };
    if (m.t === C.LOGOUT) creds = null;
    if (m.t === C.BROADCAST && Array.isArray(m.d) && Array.isArray(m.d[0]) && Array.isArray(m.d[1])) {
      // split: events -> reliable ordered channel, positions -> unreliable sequenced channel
      if (m.d[1].length) link.send({ t: C.BROADCAST, d: [[], m.d[1]] }, true);
      if (m.d[0].length) link.send({ t: C.BROADCAST, d: [m.d[0], []] }, false);
      return;
    }
    link.send({ t: m.t, d: m.d }, true);
  };
  ws.onclose = () => {
    if (browser !== ws) return;
    browser = null;
    log('browser tab closed -> leaving the game server (clean disconnect)');
    creds = null;
    if (link) { link.removeAllListeners('down'); link.close(); }
    linkUp = false;
    setTimeout(connectLink, 300);
  };
});

// HUD stats for F3 + periodic metric logs
setInterval(() => {
  const s = metrics.summary();
  toBrowser({ t: 'stats', proto: PROTO.toUpperCase(), server: SERVER, rtt: lastRtt, rttStats: s.rtt, jitter: s.jitter, c: s.counters, transport: link ? link.stats() : {} });
}, 1000);
setInterval(() => metrics.writeJson(path.join(__dirname, '..', 'logs', `bridge-${PROTO}-${runId}.json`)), 5000);

httpServer.on('error', e => { console.error(`[bridge] cannot listen on ${UI_HOST}:${UI_PORT}: ${e.message}`); process.exit(1); });
httpServer.listen(UI_PORT, UI_HOST, () => {
  log(`game UI:   http://localhost:${UI_PORT}   (WebSocket on 127.0.0.1 only)`);
  log(`server:    ${SERVER} via raw ${PROTO.toUpperCase()}`);
  if (Object.values(sim).some((v, i) => v && i < 5)) log('network simulator ON for outgoing packets:', JSON.stringify(sim));
  connectLink();
});
