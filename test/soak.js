// Soak test: 3 bots play back-to-back games for N minutes against a real server process.
//   node test/soak.js tcp|udp [minutes=10] [port]
// Reports server memory (working set / RSS sampled from the OS), server errors, games played,
// result/scoreboard mismatches between bots, stale/out-of-order state applied, final-position desync.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { C } = require('../server/common/protocol');
const { Bot } = require('./bot');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const proto = process.argv[2] === 'udp' ? 'udp' : 'tcp';
const MINUTES = +(process.argv[3] || 10);
const PORT = +(process.argv[4] || (proto === 'tcp' ? 19500 : 19501));
const OUT = path.join(__dirname, '..', 'logs', 'verify');
fs.mkdirSync(OUT, { recursive: true });

function memMB(pid) {
  if (process.platform === 'win32') {
    // locale-independent (tasklist prints "Ko" on French Windows): working set in bytes
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' });
    const b = parseInt(r.stdout, 10);
    return isNaN(b) ? null : Math.round(b / 1048576 * 10) / 10;
  }
  const r = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
  return Math.round(parseInt(r.stdout, 10) / 1024 * 10) / 10;
}

(async () => {
  const logPath = path.join(OUT, `soak-${proto}-server.log`);
  const logf = fs.openSync(logPath, 'w');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', proto, `server-${proto}.js`), '--port', String(PORT), '--host', '127.0.0.1',
    '--accounts', path.join(os.tmpdir(), `pvp-soak-${proto}-${Date.now()}.json`)], { stdio: ['ignore', logf, logf] });
  let exited = false; srv.on('exit', () => { exited = true; });
  await sleep(1000);
  const bots = ['s1', 's2', 's3'].map(u => new Bot({ proto, host: '127.0.0.1', port: PORT, user: u + (Date.now() % 10000), pass: 'pw11' }));
  await Promise.all(bots.map(b => b.connect()));
  await Promise.all(bots.map(b => b.auth(true)));
  for (const b of bots) { b.send(C.JOINROOM, ['SOAK', b.name, 0]); await b.waitFor(C.ROOM_JOINED); }
  const mem = [];
  const t0 = Date.now(), END = t0 + MINUTES * 60000;
  const memTimer = setInterval(() => mem.push({ t: Math.round((Date.now() - t0) / 1000), mb: memMB(srv.pid) }), 15000);
  mem.push({ t: 0, mb: memMB(srv.pid) });
  const stats = { games: 0, resultMismatch: 0, scoreboardMismatch: 0, finalPosDesync: 0, finalPosChecks: 0, errors: [] };
  // track last sent state per bot (slot -> data)
  const lastSent = {};
  bots.forEach(b => { const orig = b.send.bind(b); b.send = (t, d, r) => { if (t === C.BROADCAST && d[0].length) lastSent[d[0][0].id] = d[0][0].data; return orig(t, d, r); }; });
  try {
    while (Date.now() < END) {
      for (const b of bots) b.send(C.SETCONFIRM, true);
      await bots[0].waitFor(C.SESSION_STATUS, d => d.status === 'waiting' && d.players.length === 3 && d.players.every(p => p.ready), 15000);
      const st = bots[0].inbox.filter(m => m.t === C.SESSION_STATUS).slice(-1)[0].d;
      const host = bots.find(b => b.id === st.host);
      const starts = Promise.all(bots.filter(b => b !== host).map(b => b.waitFor(C.ROOMFROZEN, null, 15000)));
      host.send(C.FREEZEROOM, { settings: { scoreLimit: 10 }, modules: [] });
      await starts;
      const order = st.players.map(p => bots.find(b => b.id === p.id));
      order.forEach((b, i) => b.startStreaming(i));
      const results = Promise.all(bots.map(b => b.waitFor(C.GAME_RESULT, null, 120000)));
      let done = false; results.then(() => done = true, () => done = true);
      const evT = setInterval(() => bots.forEach(b => b.send(C.BROADCAST, [[], [[99, Date.now()]]], true)), 1000);
      let iter = 0;
      while (!done) {
        // every 3rd tick: pause all streams 500 ms, then every bot must hold exactly each sender's last state
        if (++iter % 3 === 0) {
          order.forEach(b => b.stopStreaming());
          await sleep(500);
          if (!done) bots.forEach(b => { for (const slot in b.states) { stats.finalPosChecks++; const sent = lastSent[slot]; if (!sent || JSON.stringify(sent.slice(0, 7)) !== JSON.stringify(b.states[slot].slice(0, 7))) { stats.finalPosDesync++; if (process.env.SOAKDEBUG) console.log('DESYNC slot', slot, JSON.stringify(sent), JSON.stringify(b.states[slot])); } } });
          order.forEach((b, i) => b.startStreaming(i));
        }
        const victim = bots[Math.floor(Math.random() * 3)];
        const killer = bots.filter(b => b !== victim)[Math.floor(Math.random() * 2)];
        victim.send(C.SCORE_EVENT, { kind: 'kill', victim: victim.id, killer: killer.id });
        await sleep(1500);
      }
      clearInterval(evT);
      const res = await results;
      const sig = r => JSON.stringify([r.winner, r.ranking.map(x => [x.user, x.score, x.kills, x.deaths])]);
      if (!res.every(r => sig(r) === sig(res[0]))) stats.resultMismatch++;
      const sbs = bots.map(b => b.inbox.filter(m => m.t === C.SCOREBOARD).slice(-1)[0]).map(m => m && JSON.stringify(m.d.ranking.map(x => [x.user, x.score])));
      if (!sbs.every(s => s === sbs[0])) stats.scoreboardMismatch++;
      // final-position consistency: after the stream stops, everybody must hold the sender's last state
      order.forEach(b => b.stopStreaming());
      bots.forEach(b => { for (const slot in {}) { stats.finalPosChecks++; const sent = lastSent[slot]; if (!sent || JSON.stringify(sent.slice(0, 7)) !== JSON.stringify((b.states[slot] || []).slice(0, 7))) { stats.finalPosDesync++; if (process.env.SOAKDEBUG) console.log('DESYNC slot', slot, 'sent', JSON.stringify(sent), 'held', JSON.stringify(b.states[slot])); } } b.states = {}; });
      stats.games++;
      bots.forEach(b => { b.inbox.length = 0; });
      process.stdout.write(`\r[${proto.toUpperCase()} soak] ${Math.round((Date.now() - t0) / 1000)} s, games ${stats.games}, mem ${mem[mem.length - 1].mb} MB   `);
    }
  } catch (e) { stats.errors.push(e.message); }
  clearInterval(memTimer);
  mem.push({ t: Math.round((Date.now() - t0) / 1000), mb: memMB(srv.pid) });
  const agg = {}; bots.forEach(b => { for (const [k, v] of Object.entries(b.metrics.c)) agg[k] = (agg[k] || 0) + v; });
  bots.forEach(b => b.close());
  await sleep(500);
  const log = fs.readFileSync(logPath, 'utf8');
  const serverErrors = (log.match(/uncaughtException|handler error|Error:/g) || []).length;
  const warm = mem.find(m => m.t >= 60) || mem[0];
  const out = {
    proto: proto.toUpperCase(), minutes: MINUTES, serverAlive: !exited, games: stats.games,
    memMB: { start: mem[0].mb, afterWarmup: warm.mb, end: mem[mem.length - 1].mb, max: Math.max(...mem.map(m => m.mb)), growthAfterWarmup: Math.round((mem[mem.length - 1].mb - warm.mb) * 10) / 10 },
    memSamples: mem, serverErrorLines: serverErrors, resultMismatch: stats.resultMismatch, scoreboardMismatch: stats.scoreboardMismatch,
    finalPositionDesync: `${stats.finalPosDesync}/${stats.finalPosChecks}`, staleStateApplied: agg.stateStaleApplied || 0,
    stateUpdatesReceived: agg.stateUpdates || 0, retransmissions: agg.retransmissions || 0, testErrors: stats.errors,
  };
  srv.kill();
  fs.writeFileSync(path.join(OUT, `soak-${proto}.json`), JSON.stringify(out, null, 1));
  console.log('\n' + JSON.stringify(Object.assign({}, out, { memSamples: undefined })));
  process.exit(out.serverAlive && !stats.errors.length && !serverErrors && !stats.resultMismatch && !stats.scoreboardMismatch ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
