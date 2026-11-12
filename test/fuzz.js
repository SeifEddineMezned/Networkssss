// Robustness: malformed / oversized / split / coalesced / duplicate / out-of-order / forged input
// must never crash either server. After every attack a legit client must still be served.
//   node test/fuzz.js
const { spawn } = require('child_process');
const net = require('net');
const dgram = require('dgram');
const path = require('path');
const os = require('os');
const { C } = require('../server/common/protocol');
const { encodeFrame } = require('../server/common/framing');
const { Bot } = require('./bot');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };

function start(proto, port) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', proto, `server-${proto}.js`), '--port', String(port), '--host', '127.0.0.1', '--accounts', path.join(os.tmpdir(), `pvp-fuzz-${proto}-${Date.now()}.json`)], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.out = '';
    const on = b => { p.out += b; if (/listening/.test(b)) res(p); };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.on('exit', c => { p.dead = true; });
    setTimeout(() => rej(new Error('no start')), 5000);
  });
}

async function alive(proto, port, server, label) {
  const u = 'f' + Math.floor(Math.random() * 1e6);
  const b = new Bot({ proto, host: '127.0.0.1', port, user: u, pass: 'x12' });
  try { await b.connect(3000); await b.auth(true); b.close(); check(`[${proto}] server alive & serving after: ${label}`, !server.dead); }
  catch (e) { check(`[${proto}] server alive & serving after: ${label}`, false, e.message); }
}

function tcpSend(port, chunks, gap = 0) {
  return new Promise(res => {
    const s = net.connect(port, '127.0.0.1');
    s.on('error', () => { });
    s.on('connect', async () => { for (const c of chunks) { s.write(c); if (gap) await sleep(gap); } setTimeout(() => { s.destroy(); res(); }, 200); });
  });
}

async function fuzzTcp() {
  const port = 19100;
  const srv = await start('tcp', port);
  console.log('\n=== TCP fuzz ===');
  await tcpSend(port, [Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n')]);
  await alive('tcp', port, srv, 'HTTP request instead of frames');
  const huge = Buffer.alloc(4); huge.writeUInt32BE(0xfffffff0, 0);
  await tcpSend(port, [huge, Buffer.alloc(100)]);
  await alive('tcp', port, srv, '4 GB length prefix');
  const bad = Buffer.from('{not json'); const h = Buffer.alloc(4); h.writeUInt32BE(bad.length);
  await tcpSend(port, [Buffer.concat([h, bad])]);
  await alive('tcp', port, srv, 'invalid JSON body');
  await tcpSend(port, [encodeFrame({ t: 999 }), encodeFrame([1, 2]), encodeFrame({ t: C.JOINROOM, d: { evil: 1 } }), encodeFrame({ t: C.LOGIN, d: { user: 'a'.repeat(5000), pass: 1 } }), encodeFrame({ t: C.SCORE_EVENT, d: { kind: 'kill', victim: 'x' } }), encodeFrame(null), encodeFrame('str')]);
  await alive('tcp', port, srv, 'unknown types / wrong schemas / unauthenticated game messages');
  // one valid frame delivered 1 byte at a time + 20 frames coalesced in one write
  const f = encodeFrame({ t: C.PING, d: { ts: 1 } });
  await tcpSend(port, [...f].map(b => Buffer.from([b])), 2);
  await tcpSend(port, [Buffer.concat(Array(20).fill(f))]);
  await alive('tcp', port, srv, 'byte-by-byte partial frames and 20 coalesced frames');
  const rnd = []; for (let i = 0; i < 50; i++) rnd.push(require('crypto').randomBytes(Math.floor(Math.random() * 2000)));
  await tcpSend(port, rnd);
  await alive('tcp', port, srv, '50 random binary chunks');
  await Promise.all(Array.from({ length: 60 }, () => tcpSend(port, [])));
  await alive('tcp', port, srv, '60 connect/disconnect storms');
  srv.kill();
}

function udpBlast(port, bufs) {
  return new Promise(res => {
    const s = dgram.createSocket('udp4');
    let i = 0;
    const next = () => { if (i >= bufs.length) { setTimeout(() => { s.close(); res(); }, 100); return; } s.send(bufs[i++], port, '127.0.0.1', next); };
    next();
  });
}

async function fuzzUdp() {
  const port = 19101;
  const srv = await start('udp', port);
  console.log('\n=== UDP fuzz ===');
  const crypto = require('crypto');
  await udpBlast(port, Array.from({ length: 200 }, () => crypto.randomBytes(1 + Math.floor(Math.random() * 1400))));
  await alive('udp', port, srv, '200 random datagrams');
  await udpBlast(port, [Buffer.alloc(60000, 65)]);
  await alive('udp', port, srv, '60 KB datagram');
  const J = o => Buffer.from(JSON.stringify(o));
  await udpBlast(port, [J({ s: 'deadbeef0000', c: 'R', q: 1, t: C.LOGIN, d: { user: 'x', pass: 'y' } }), J({ h: 'HELLO' }), J({ h: 'HELLO', n: 'x'.repeat(500) }), J(null), J([1]), J({ c: 'R' })]);
  await alive('udp', port, srv, 'forged session token, broken handshakes');
  // legit handshake then garbage sequence numbers, duplicates, reordering
  const s = dgram.createSocket('udp4');
  const welcome = await new Promise(res => { s.on('message', b => { try { const m = JSON.parse(b); if (m.h === 'WELCOME') res(m); } catch (e) { } }); s.send(J({ h: 'HELLO', n: 'fz1' }), port, '127.0.0.1'); });
  const tok = welcome.s;
  const pk = [];
  for (const q of [5, 3, 3, 3, 1, -1, 0, 1e30, 'x', 2, 4, 4, 1e6]) pk.push(J({ s: tok, c: 'R', q, a: 'z', b: -1, t: C.PING, d: { ts: Date.now() } }));
  for (let i = 0; i < 50; i++) pk.push(J({ s: tok, c: 'U', q: Math.floor(Math.random() * 100), t: C.BROADCAST, d: [[{ id: 0, data: [] }], []] }));
  pk.push(J({ s: tok, c: 'R', q: 6, t: C.SCORE_EVENT, d: { kind: 'kill', victim: welcome.id, killer: 'zz' } }));
  await new Promise(r => { let i = 0; const n = () => i < pk.length ? s.send(pk[i++], port, '127.0.0.1', n) : r(); n(); });
  await sleep(200); s.close();
  await alive('udp', port, srv, 'duplicate / out-of-order / absurd sequence numbers, bogus acks');
  srv.kill();
}

(async () => {
  await fuzzTcp();
  await fuzzUdp();
  console.log(`\n${pass}/${pass + fail} fuzz checks passed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
