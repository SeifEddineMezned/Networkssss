// End-to-end test of EVERY mandatory feature, for both versions.
//   node test/run-all.js            -> TCP then UDP
//   node test/run-all.js udp        -> only UDP
//   node test/run-all.js tcp --sim-loss 0.1 --sim-delay 50   (simulator applied to bots AND server)
// Spawns a real server process + 3 bot clients talking over real sockets on 127.0.0.1.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { C } = require('../server/common/protocol');
const { Bot } = require('./bot');
const { parseSimArgs } = require('../server/common/simnet');

const argv = process.argv.slice(2);
const protos = argv.filter(a => a === 'tcp' || a === 'udp');
const simArgs = argv.filter((a, i) => a.startsWith('--sim-') || (argv[i - 1] || '').startsWith('--sim-'));
const sim = parseSimArgs(argv);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startServer(proto, port, accounts) {
  return new Promise((res, rej) => {
    const script = path.join(__dirname, '..', 'server', proto, `server-${proto}.js`);
    const p = spawn(process.execPath, [script, '--port', String(port), '--host', '127.0.0.1', '--accounts', accounts, ...simArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.log = [];
    const onData = b => { const s = b.toString(); p.log.push(s); if (process.env.SHOWLOG) process.stdout.write('    SERVER| ' + s); if (/listening/.test(s)) res(p); };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('exit', c => rej(new Error('server exited ' + c)));
    setTimeout(() => rej(new Error('server did not start')), 5000);
  });
}

let results = [];
function check(proto, name, ok, detail) {
  results.push({ proto, name, ok: !!ok, detail: detail || '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${proto.toUpperCase()}] ${name}${detail ? '  -- ' + detail : ''}`);
}

async function runFor(proto) {
  const port = proto === 'tcp' ? 19000 : 19001;
  const accounts = path.join(os.tmpdir(), `pvp-test-accounts-${proto}-${Date.now()}.json`);
  console.log(`\n=== ${proto.toUpperCase()} version (server on 127.0.0.1:${port}${simArgs.length ? ', sim ' + simArgs.join(' ') : ''}) ===`);
  const server = await startServer(proto, port, accounts);
  const T = sim.loss || sim.delay ? 15000 : 5000;
  const mk = user => new Bot({ proto, host: '127.0.0.1', port, user, pass: 'pw-' + user, sim });
  const [A, B, Cc] = [mk('alice'), mk('bob'), mk('carol')];
  try {
    // 1. registration + login
    await Promise.all([A.connect(), B.connect(), Cc.connect()]);
    check(proto, 'handshake (HELLO/WELCOME) x3', A.id && B.id && Cc.id);
    await Promise.all([A.auth(true), B.auth(true), Cc.auth(true)]);
    check(proto, 'register 3 users', true);
    const dup = mk('alice'); await dup.connect();
    let dupErr = null; try { await dup.auth(true); } catch (e) { dupErr = e.message; }
    check(proto, 'duplicate username rejected', /taken/.test(dupErr || ''), dupErr);
    let pwErr = null; dup.o.pass = 'wrong'; try { await dup.auth(false); } catch (e) { pwErr = e.message; }
    check(proto, 'wrong password rejected', /Wrong password/.test(pwErr || ''), pwErr);
    dup.close();
    // re-login with the right password works (same credentials)
    const relog = mk('carol'); await relog.connect();
    const replaced = Cc.waitFor(C.ERROR, d => d.code === 'replaced', T);
    await relog.auth(false);
    await replaced;
    check(proto, 'login with same credentials; one active session per user (old one replaced)', true);
    Cc.close();
    const C2 = relog; C2.name = 'carol';

    // 2. lobby + room creation
    A.send(C.CREATE_ROOM, { name: 'ARENA1' });
    const list = await A.waitFor(C.ROOM_LIST, l => l.some(r => r.id === 'ARENA1'), T);
    check(proto, 'create room + room list', list.some(r => r.id === 'ARENA1' && r.status === 'waiting'));
    B.send(C.CREATE_ROOM, { name: 'ARENA1' });
    await B.waitFor(C.ERROR, d => d.code === 'roomExists', T);
    check(proto, 'duplicate room name rejected', true);

    // 3. join / leave
    for (const bot of [A, B, C2]) { bot.send(C.JOINROOM, ['ARENA1', bot.name, { mode: 1 }]); await bot.waitFor(C.ROOM_JOINED, null, T); }
    const cfg = await A.waitFor(C.ROOMCONFIG, d => d.players.length === 3, T, true).catch(() => null) || await A.waitFor(C.ROOMCONFIG, d => d.players.length === 3, T);
    check(proto, '3 players joined the room (PvP ROOMCONFIG)', cfg.players.length === 3);
    B.send(C.LEAVEROOM);
    await A.waitFor(C.PLAYER_LEFT, d => d.user === 'bob', T);
    check(proto, 'leave room -> PLAYER_LEFT broadcast', true);
    B.send(C.JOINROOM, ['ARENA1', 'bob', 0]); await B.waitFor(C.ROOM_JOINED, null, T);
    B.send(C.ROOM_LIST_REQ);
    const l2 = await B.waitFor(C.ROOM_LIST, l => l.some(r => r.id === 'ARENA1' && r.players === 3), T);
    check(proto, 'rejoin; lobby shows 3/4 waiting', !!l2);

    // 4. start rules
    A.send(C.FREEZEROOM, { settings: { scoreLimit: 3, map: 0 }, modules: [] });
    const notReady = await A.waitFor(C.ERROR, d => d.code === 'cannotStart', T);
    check(proto, 'start refused while players not ready', /ready/.test(notReady.msg), notReady.msg);
    for (const bot of [A, B, C2]) bot.send(C.SETCONFIRM, true);
    await A.waitFor(C.SESSION_STATUS, d => d.players.length === 3 && d.players.every(p => p.ready), T);
    B.send(C.FREEZEROOM, { settings: { scoreLimit: 3 } });
    const notHost = await B.waitFor(C.ERROR, d => d.code === 'cannotStart', T);
    check(proto, 'start refused for non-host', /host/.test(notHost.msg), notHost.msg);
    const fB = B.waitFor(C.ROOMFROZEN, null, T), fC = C2.waitFor(C.ROOMFROZEN, null, T);
    A.send(C.FREEZEROOM, { settings: { scoreLimit: 3, map: 0 }, modules: [] });
    await Promise.all([fB, fC]);
    const st = await A.waitFor(C.SESSION_STATUS, d => d.status === 'playing', T);
    check(proto, 'host starts game -> ROOMFROZEN to others, status=playing', st.status === 'playing');

    // 5. real-time actions
    [A, B, C2].forEach((b, i) => b.startStreaming(i));
    await sleep(2000);
    A.send(C.BROADCAST, [[], [[9, 'evt-shot']]], true);
    await B.waitFor(C.DATA, d => d[1].length && d[1][0][1] === 'evt-shot', T, true);
    const rates = [A, B, C2].map(b => b.metrics.get('stateUpdates'));
    check(proto, 'state streaming relayed between all players', rates.every(r => r > 40), 'updates received in 2 s: ' + rates.join('/'));
    check(proto, 'reliable game event (shot) delivered', true);

    // 6. scores + result (A kills C2 three times, scoreLimit 3)
    const res1 = Promise.all([A, B, C2].map(b => b.waitFor(C.GAME_RESULT, null, T)));
    for (let i = 0; i < 3; i++) { C2.send(C.SCORE_EVENT, { kind: 'kill', victim: C2.id, killer: A.id }); await sleep(450); }
    // cheating attempt: B claims C2 died -> must be ignored
    B.send(C.SCORE_EVENT, { kind: 'kill', victim: C2.id, killer: B.id });
    const [r1] = await res1;
    check(proto, 'server-side scoreboard + GAME_RESULT with winner on score limit', r1.winner === 'alice' && r1.reason === 'scoreLimit',
      r1.ranking.map(r => `${r.rank}.${r.user}=${r.score}`).join(' '));
    const sb = A.inbox.filter(m => m.t === C.SCOREBOARD).length;
    check(proto, 'SCOREBOARD broadcast during play', sb >= 3, sb + ' scoreboards');
    [A, B, C2].forEach(b => b.stopStreaming());

    // 7. unexpected disconnect mid-game, host hand-over, game continues, then ends
    await A.waitFor(C.SESSION_STATUS, d => d.status === 'waiting', T, true);
    for (const bot of [A, B, C2]) bot.send(C.SETCONFIRM, true);
    await A.waitFor(C.SESSION_STATUS, d => d.players.every(p => p.ready) && d.players.length === 3, T);
    const f2 = Promise.all([B, C2].map(b => b.waitFor(C.ROOMFROZEN, null, T)));
    A.send(C.FREEZEROOM, { settings: { scoreLimit: 10 }, modules: [] });
    await f2;
    [A, B, C2].forEach((b, i) => b.startStreaming(i));
    await sleep(500);
    const t0 = Date.now();
    const dropB = B.waitFor(C.PLAYER_DROPPED, d => d.user === 'alice', 15000);
    const hostC = C2.waitFor(C.HOST_CHANGED, null, 15000);
    A.vanish('freeze');   // host's laptop freezes / Wi-Fi gone: no FIN, no BYE, half-open socket
    const dd = await dropB;
    const detect = Date.now() - t0;
    const hc = await hostC;
    check(proto, 'unexpected disconnect of HOST detected by heartbeat -> PLAYER_DROPPED', dd.reason === 'timeout', `detected in ${detect} ms (reason ${dd.reason})`);
    check(proto, 'host role handed over to next player in join order', hc.user === 'carol', 'new host ' + hc.user);
    const before = C2.metrics.get('stateUpdates'); await sleep(1000);
    { const got = C2.metrics.get('stateUpdates') - before; check(proto, 'remaining players continue playing', got > 10, got + ' state updates/s from the remaining player'); }
    const res2 = C2.waitFor(C.GAME_RESULT, null, 15000);
    const t1 = Date.now();
    B.vanish('kill');   // process killed: OS closes the socket
    const r2 = await res2;
    check(proto, 'killed client detected (' + (proto === 'tcp' ? 'TCP RST/FIN -> immediate' : 'UDP: no FIN exists -> heartbeat') + ')', true, `detected in ${Date.now() - t1} ms`);
    check(proto, 'fewer than 2 players left -> game ends with result, server alive', r2.reason === 'notEnoughPlayers' && r2.winner === 'carol', `winner ${r2.winner}`);
    // server still accepts new clients
    const late = mk('dave'); await late.connect(); await late.auth(true);
    check(proto, 'server did not crash, accepts new players afterwards', true);
    late.close(); C2.close();
    await sleep(300);
    // keep summary of transport metrics from a bot
    return { detectMs: detect, carol: C2.metrics.summary() };
  } catch (e) {
    check(proto, 'UNEXPECTED: ' + e.message, false);
    if (!process.env.SHOWLOG) console.log(server.log.join('').split('\n').slice(-30).join('\n'));
  } finally {
    server.kill();
    try { fs.unlinkSync(accounts); } catch (e) { }
  }
}

(async () => {
  for (const p of (protos.length ? protos : ['tcp', 'udp'])) await runFor(p);
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  fs.mkdirSync(path.join(__dirname, '..', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'logs', 'run-all-last.json'), JSON.stringify(results, null, 1));
  process.exit(failed.length ? 1 : 0);
})();
