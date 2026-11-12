// TCP vs UDP benchmark with the network simulator. Writes logs/bench-<proto>.json and regenerates
// docs/RESULTS.md from every bench file present.
//   node test/bench.js tcp    |   node test/bench.js udp    |   node test/bench.js (both)
// Each profile: real server process + 3 bots on 127.0.0.1, 30 Hz state streams, 1 reliable "shot"
// event per bot per second, then one bot freezes to measure disconnect detection.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { C } = require('../server/common/protocol');
const { Bot } = require('./bot');
const { stats } = require('../server/common/metrics');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PROFILES = [
  { name: 'clean (LAN)', sim: {} },
  { name: '5% loss', sim: { loss: 0.05, delay: 20, jitter: 5 } },
  { name: '10% loss + 100 ms delay', sim: { loss: 0.10, delay: 100, jitter: 20, dup: 0.02, reorder: 0.05 } },
];
const PLAY_MS = +(process.env.BENCH_MS || 15000);

function simArgs(s) { return Object.entries(s).flatMap(([k, v]) => [`--sim-${k}`, String(v)]); }

function startServer(proto, port, sim) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', proto, `server-${proto}.js`), '--port', String(port), '--host', '127.0.0.1',
      '--accounts', path.join(os.tmpdir(), `pvp-bench-${Date.now()}.json`), ...simArgs(sim)], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', b => { if (/listening/.test(b)) res(p); });
    setTimeout(() => rej(new Error('server start timeout')), 5000);
  });
}

async function runProfile(proto, prof) {
  const port = proto === 'tcp' ? 19200 : 19201;
  const srv = await startServer(proto, port, prof.sim);
  const sim = Object.assign({ loss: 0, delay: 0, jitter: 0, dup: 0, reorder: 0, rto: 200 }, prof.sim);
  const bots = ['b1', 'b2', 'b3'].map(u => new Bot({ proto, host: '127.0.0.1', port, user: u + Date.now() % 10000, pass: 'pw1', sim }));
  const W = 20000;
  try {
    await Promise.all(bots.map(b => b.connect(W)));
    await Promise.all(bots.map(b => b.auth(true)));
    for (const b of bots) { b.send(C.JOINROOM, ['BENCH', b.name, 0]); await b.waitFor(C.ROOM_JOINED, null, W); }
    for (const b of bots) b.send(C.SETCONFIRM, true);
    await bots[0].waitFor(C.SESSION_STATUS, d => d.players.length === 3 && d.players.every(p => p.ready), W);
    const started = Promise.all(bots.slice(1).map(b => b.waitFor(C.ROOMFROZEN, null, W)));
    bots[0].send(C.FREEZEROOM, { settings: { scoreLimit: 0 }, modules: [] });
    await started;
    // measurement hooks
    const m = { stateAge: [], eventLat: [], gapMs: [], recv: 0, expected: 0, lostSeq: 0, stale: 0 };
    bots.forEach((b, i) => {
      const last = {}, lastSeq = {};
      b.link.on('message', msg => {
        if (msg.t !== C.DATA) return;
        const now = Date.now();
        (msg.d[0] || []).forEach(p => {
          const d = p.data; if (!d) return;
          if (lastSeq[p.id] !== undefined) {
            if (d[6] <= lastSeq[p.id]) { m.stale++; return; }
            if (d[6] > lastSeq[p.id] + 1) m.lostSeq += d[6] - lastSeq[p.id] - 1;
          }
          lastSeq[p.id] = d[6];
          m.recv++;
          m.stateAge.push(now - d[7]);
          if (last[p.id]) m.gapMs.push(now - last[p.id]);
          last[p.id] = now;
        });
        (msg.d[1] || []).forEach(ev => { if (ev[0] === 99) m.eventLat.push(now - ev[1]); });
      });
    });
    bots.forEach((b, i) => b.startStreaming(i));
    const evTimers = bots.map(b => setInterval(() => b.send(C.BROADCAST, [[], [[99, Date.now()]]], true), 1000));
    const t0 = Date.now();
    await sleep(PLAY_MS);
    evTimers.forEach(clearInterval);
    const elapsed = (Date.now() - t0) / 1000;
    const sent = bots.map(b => b.metrics.get('msgsOut'));
    // disconnect detection: bot 3 freezes (half-open)
    const tf = Date.now();
    const det = bots[0].waitFor(C.PLAYER_DROPPED, null, 30000);
    bots[2].vanish('freeze');
    await det;
    const detectMs = Date.now() - tf;
    bots.forEach(b => b.stopStreaming());
    const rtts = bots.flatMap(b => b.metrics.rtt);
    const counters = {};
    bots.forEach(b => { for (const [k, v] of Object.entries(b.metrics.c)) counters[k] = (counters[k] || 0) + v; });
    const bytes = (counters.bytesOut || 0) + (counters.bytesIn || 0);
    const res = {
      proto: proto.toUpperCase(), profile: prof.name, sim: prof.sim, seconds: elapsed,
      rtt: stats(rtts),
      stateAge: stats(m.stateAge),
      eventLatency: stats(m.eventLat),
      stateGap: stats(m.gapMs),
      stateRateHz: Math.round(m.recv / elapsed / 6 * 10) / 10,   // per (receiver, sender) pair: 3 bots x 2 remotes
      statesLostPct: Math.round(m.lostSeq / Math.max(1, m.lostSeq + m.recv) * 1000) / 10,
      staleDiscarded: m.stale + (counters.staleDiscarded || 0),
      retransmissions: counters.retransmissions || 0,
      duplicatesDiscarded: counters.duplicates || 0,
      outOfOrderBuffered: counters.outOfOrder || 0,
      kbpsPerClient: Math.round(bytes / 3 / elapsed / 1024 * 8 * 10) / 10,
      disconnectDetectMs: detectMs,
    };
    console.log(`  ${res.proto} | ${prof.name}: RTT avg ${res.rtt.avg} p95 ${res.rtt.p95} | state age avg ${res.stateAge.avg} p95 ${res.stateAge.p95} max ${res.stateAge.max} | event p95 ${res.eventLatency.p95} | gap p95 ${res.stateGap.p95} max ${res.stateGap.max} | lost ${res.statesLostPct}% | retx ${res.retransmissions} | detect ${detectMs} ms`);
    return res;
  } finally {
    bots.forEach(b => { try { b.close(); } catch (e) { } });
    srv.kill();
    await sleep(300);
  }
}

function writeResults() {
  const dir = path.join(__dirname, '..', 'logs');
  const rows = [];
  for (const p of ['tcp', 'udp']) { try { rows.push(...JSON.parse(fs.readFileSync(path.join(dir, `bench-${p}.json`), 'utf8'))); } catch (e) { } }
  if (!rows.length) return;
  const f = v => v == null ? '-' : v;
  let md = `# Measured TCP vs UDP results\n\nGenerated by \`npm run bench:tcp\` / \`npm run bench:udp\` (test/bench.js) on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.\n\n` +
    `Setup: real server process + 3 headless bot clients over real sockets on one machine (127.0.0.1), ${PLAY_MS / 1000} s of play per profile, ` +
    `30 Hz position stream per client, 1 reliable "shot" event per client per second. Impairments are injected by \`server/common/simnet.js\` on **every outgoing packet of the server and of every client** ` +
    `(so loss applies per hop: client->server and server->client). For TCP, a "lost" packet is modelled as a kernel retransmission (delay of RTO=200 ms, doubling, with head-of-line blocking of all later data), ` +
    `because TCP never exposes loss to the application.\n\n` +
    `| Version | Profile | RTT avg / p95 (ms) | Perceived lag: state age avg / p95 / max (ms) | Reliable event latency p95 / max (ms) | Freeze: gap between updates p95 / max (ms) | State updates not delivered (lost or superseded) | Stale discarded | Retransmissions | Bandwidth / client (kbit/s) | Disconnect detected after (ms) |\n` +
    `|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of rows) md += `| ${r.proto} | ${r.profile} | ${f(r.rtt.avg)} / ${f(r.rtt.p95)} | ${f(r.stateAge.avg)} / ${f(r.stateAge.p95)} / ${f(r.stateAge.max)} | ${f(r.eventLatency.p95)} / ${f(r.eventLatency.max)} | ${f(r.stateGap.p95)} / ${f(r.stateGap.max)} | ${r.statesLostPct}% | ${r.staleDiscarded} | ${r.proto === 'UDP' ? r.retransmissions : 'kernel (hidden)'} | ${r.kbpsPerClient} | ${r.disconnectDetectMs} |\n`;
  md += `\n## How to read it\n\n` +
    `- **Perceived lag (state age)** = time between a client sampling its position and another client receiving it. This is what a player sees as lag.\n` +
    `- **Freeze (gap)** = time between two consecutive position updates of the same remote player. Large values are visible stutter/teleport ("desync after a lost message").\n` +
    `- **State updates not delivered**: UDP drops lost ones on purpose, and the server's per-receiver batching (60 Hz) keeps only the newest state of each player, so an older one can be *superseded* (no retransmit; the next update 33 ms later supersedes it). TCP never loses them but delivers them late.\n` +
    `- **Reliable events** (shots, kills, scores, room ops) are never lost in either version: TCP by the kernel, UDP by our ACK/retransmit layer (server/common/reliable.js).\n` +
    `- **Disconnect detection**: a client freezes without closing its socket (half-open). TCP: app heartbeat 2 s / timeout 6 s. UDP: heartbeat 1 s / timeout 5 s. ` +
    `A *killed* TCP client is detected immediately (OS sends RST/FIN); UDP has no FIN, so it always relies on the heartbeat or an explicit BYE.\n` +
    `\nRaw numbers: \`logs/bench-tcp.json\`, \`logs/bench-udp.json\`.\n`;
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'RESULTS.md'), md);
  console.log('wrote docs/RESULTS.md');
}

(async () => {
  const which = process.argv.slice(2).filter(a => a === 'tcp' || a === 'udp');
  for (const proto of (which.length ? which : ['tcp', 'udp'])) {
    console.log(`\n=== bench ${proto.toUpperCase()} ===`);
    const out = [];
    for (const prof of PROFILES) out.push(await runProfile(proto, prof));
    fs.mkdirSync(path.join(__dirname, '..', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'logs', `bench-${proto}.json`), JSON.stringify(out, null, 1));
  }
  writeResults();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
