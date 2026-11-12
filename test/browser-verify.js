// Full 3-player verification in REAL browsers (headless Chrome/Edge driven over the DevTools
// protocol, no extra deps). Starts its own server + 3 bridges (ui ports 8080/8081/8082).
//   node test/browser-verify.js tcp|udp            -> functional flow (section 2) + protocol proof (section 3)
//   node test/browser-verify.js tcp|udp --drill    -> bad network on bridge C, frozen bridge, killed bridge (section 4)
// Screenshots: logs/verify/<proto>[-drill]-NN-<stage>-<tab>.png   Results: logs/verify/<proto>[-drill]-results.json
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Bot } = require('./bot');
const { C } = require('../server/common/protocol');

const argv = process.argv.slice(2);
const PROTO = argv.includes('udp') ? 'udp' : 'tcp';
const DRILL = argv.includes('--drill');
const SPORT = PROTO === 'tcp' ? 9000 : 9001;
const TAG = PROTO + (DRILL ? '-drill' : '');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'logs', 'verify');
fs.mkdirSync(OUT, { recursive: true });
const SIM = ['--sim-loss', '0.1', '--sim-delay', '80', '--sim-jitter', '20'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exe = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(p => fs.existsSync(p));

const results = [];
let shotN = 0;
function rec(item, ok, detail) {
  results.push({ item, ok: !!ok, detail: detail || '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${TAG.toUpperCase()}] ${item}${detail ? '  -- ' + detail : ''}`);
}

// ------------------------------------------------------------------ processes
const procs = [];
function startProc(name, args) {
  const logf = fs.openSync(path.join(OUT, `${TAG}-${name}.log`), 'w');
  const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', logf, logf] });
  p.name = name; p.exited = false;
  p.on('exit', c => { p.exited = true; p.code = c; });
  procs.push(p);
  return p;
}
const logOf = name => { try { return fs.readFileSync(path.join(OUT, `${TAG}-${name}.log`), 'utf8'); } catch (e) { return ''; } };
async function waitLog(name, re, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(logOf(name))) return true; await sleep(100); } return false; }
function suspend(pid, on) {
  const ps = `$s='[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);';` +
    `$t=Add-Type -MemberDefinition $s -Name N${Date.now()} -Namespace W -PassThru; $p=Get-Process -Id ${pid}; [void]$t::${on ? 'NtSuspendProcess' : 'NtResumeProcess'}($p.Handle)`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  return r.status === 0;
}

// ------------------------------------------------------------------ CDP
class Page {
  constructor(name, ws) {
    this.name = name; this.id = 0; this.pending = {}; this.errors = []; this.closed = false;
    this.ws = new WebSocket(ws);
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending[m.id]) { this.pending[m.id](m); delete this.pending[m.id]; }
      if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; this.errors.push(d.exception ? d.exception.description : d.text); }
    };
    this.ready = new Promise(r => this.ws.onopen = r);
  }
  cmd(method, params = {}) { if (this.closed) return Promise.resolve({}); const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise(r => { this.pending[id] = r; setTimeout(() => r({ timeout: true }), 15000); }); }
  async ev(expr) { const r = await this.cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result && r.result.result ? r.result.result.value : undefined; }
  key(type, code) { return this.cmd('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, keyCode: code }); }
  async shot(stage) { if (this.closed) return; const r = await this.cmd('Page.captureScreenshot', { format: 'png' }); if (r.result) fs.writeFileSync(path.join(OUT, `${TAG}-${String(shotN).padStart(2, '0')}-${stage}-${this.name}.png`), Buffer.from(r.result.data, 'base64')); }
  ov() { return this.ev(`(document.getElementById('rawov')||{innerText:''}).innerText.replace(/\\s+/g,' ')`); }
  v(expr) { return this.ev(`(()=>{const v=window.__v;return ${expr}})()`); }
}

const INSTR = `(()=>{ if (window.__v) return 'already';
  window.__v={data:{},fires:0,ev:0,dropped:[],left:[],host:[],results:[],errors:[],status:null,sb:null,authFail:[],joined:[]};
  RAWLINK.on(8,d=>{(d[0]||[]).forEach(p=>__v.data[p.id]=(__v.data[p.id]||0)+1);(d[1]||[]).forEach(e=>{__v.ev++;if(e[0]==16)__v.fires++;});});
  RAWLINK.on(9,e=>{__v.ev++;});
  RAWLINK.on(30,d=>__v.dropped.push(Object.assign({at:Date.now()},d))); RAWLINK.on(29,d=>__v.left.push(d)); RAWLINK.on(40,d=>__v.host.push(d));
  RAWLINK.on(33,d=>__v.results.push(d)); RAWLINK.on(36,d=>__v.errors.push(d)); RAWLINK.on(42,d=>__v.status=d); RAWLINK.on(32,d=>__v.sb=d);
  RAWLINK.on(25,d=>__v.authFail.push(d.msg)); RAWLINK.on(41,d=>__v.joined.push(d.room)); return 'ok'; })()`;

async function until(fn, ms = 10000, step = 200) { const t = Date.now(); let v; while (Date.now() - t < ms) { try { v = await fn(); if (v) return v; } catch (e) { } await sleep(step); } return v; }

async function auth(p, user, pass, register) {
  return p.ev(`(()=>{const u=document.getElementById('rawUser');if(!u)return 'no form';u.value=${JSON.stringify(user)};document.getElementById('rawPass').value=${JSON.stringify(pass)};document.getElementById(${JSON.stringify(register ? 'rawRegister' : 'rawLogin')}).click();return 'ok'})()`);
}
const click = (p, sel) => p.ev(`(()=>{const b=document.querySelector(${JSON.stringify(sel)});if(!b)return false;b.click();return true})()`);
async function hold(pages, code, ms) { for (const p of pages) await p.key('keyDown', code); await sleep(ms); for (const p of pages) await p.key('keyUp', code); }
async function playFor(pages, ms) {
  const t = Date.now();
  for (const p of pages) await p.key('keyDown', 87);   // W: walk
  while (Date.now() - t < ms) { for (const p of pages) await p.key('keyDown', 71); await sleep(150); for (const p of pages) await p.key('keyUp', 71); await sleep(250); }
  for (const p of pages) await p.key('keyUp', 87);
}
// hold FIRE until the server reports every listed tab as ready (PvP needs a fresh FIRE press after screens change)
async function readyAll(pages, users, statusPage) {
  for (let i = 0; i < 4; i++) {
    const s = await statusPage.v('__v.status');
    if (s && s.status === 'playing') return true;
    const notReady = pages.filter((p, k) => !(s && s.players.some(x => x.user === users[k] && x.ready)));
    if (!notReady.length) return true;
    for (const p of notReady) await p.key('keyUp', 71);
    await sleep(300);
    await hold(notReady, 71, 4500);
    await sleep(800);
  }
  return false;
}
// wait until every tab's GAME LOOP is running and streaming (PvP's start fade-in can take seconds when
// 3 headless tabs software-render on one CPU); returns the warm-up time (-1 = never) so slow starts stay visible
async function waitStreams(pages, remotes, ms = 20000) {
  const t = Date.now();
  const ok = await until(async () => { for (const p of pages) { const d = JSON.parse(await p.v('JSON.stringify(__v.data)')); if (Object.values(d).filter(v => v >= 5).length < remotes) return false; } return true; }, ms, 250);
  return ok ? Date.now() - t : -1;
}
const stage = async (name, pages) => { shotN++; for (const p of pages) await p.shot(name); };

function netstatProof(label, pids) {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  const lines = r.stdout.split(/\r?\n/).map(l => l.trim()).filter(l => /^(TCP|UDP)\s/.test(l));
  const byPid = {};
  for (const l of lines) { const cols = l.split(/\s+/); const pid = +cols[cols.length - 1]; for (const [name, p] of Object.entries(pids)) if (p === pid) (byPid[name] = byPid[name] || []).push(l); }
  let txt = `=== ${label} (${new Date().toISOString()}) ===\nPIDs: ${JSON.stringify(pids)}\n`;
  const verdict = [];
  for (const [name, ls] of Object.entries(byPid)) {
    txt += `-- ${name} (pid ${pids[name]}) --\n${ls.join('\n')}\n`;
  }
  for (const name of Object.keys(pids)) {
    const ls = byPid[name] || [];
    const tcp = ls.filter(l => l.startsWith('TCP')), udp = ls.filter(l => l.startsWith('UDP'));
    if (name === 'server') {
      const ok = PROTO === 'tcp' ? udp.length === 0 && tcp.some(l => l.includes(':' + SPORT)) : tcp.length === 0 && udp.some(l => l.includes(':' + SPORT));
      verdict.push([`${name}: ${PROTO === 'tcp' ? 'TCP sockets only, no UDP' : 'UDP socket only, no TCP'}`, ok, `${tcp.length} TCP / ${udp.length} UDP entries`]);
    } else {
      // bridge: TCP allowed ONLY for the localhost UI (port 808x); server link must be the selected protocol
      const uiPort = { A: 8080, B: 8081, C: 8082 }[name.slice(-1)];
      const tcpToServer = tcp.filter(l => { const c = l.split(/\s+/); return c[2].endsWith(':' + SPORT) || c[1].endsWith(':' + SPORT); });
      const tcpNonUi = tcp.filter(l => { const c = l.split(/\s+/); return !(c[1].endsWith(':' + uiPort) || c[2].endsWith(':' + uiPort)) && !tcpToServer.includes(l); });
      const tcpUiNonLocal = tcp.filter(l => { const c = l.split(/\s+/); return (c[1].endsWith(':' + uiPort)) && !(c[1].startsWith('127.0.0.1') && (c[2].startsWith('127.0.0.1') || c[2].startsWith('0.0.0.0'))); });
      const ok = PROTO === 'tcp' ? (udp.length === 0 && tcpToServer.length >= 1 && tcpNonUi.length === 0 && tcpUiNonLocal.length === 0)
        : (udp.length >= 1 && tcpToServer.length === 0 && tcpNonUi.length === 0 && tcpUiNonLocal.length === 0);
      verdict.push([`${name}: server link = ${PROTO.toUpperCase()} only; other TCP = 127.0.0.1:${uiPort} browser UI only`, ok,
        `${tcpToServer.length} TCP to server, ${udp.length} UDP sockets, ${tcp.length - tcpToServer.length} localhost-UI TCP entries, ${tcpNonUi.length} other TCP`]);
    }
  }
  txt += 'VERDICT:\n' + verdict.map(v => `  ${v[1] ? 'PASS' : 'FAIL'} ${v[0]} (${v[2]})`).join('\n') + '\n\n';
  fs.appendFileSync(path.join(OUT, 'protocol-proof.txt'), txt);
  return verdict;
}

// ------------------------------------------------------------------ main
(async () => {
  if (!exe) throw new Error('no Chrome/Edge found');
  const accounts = path.join(os.tmpdir(), `pvp-verify-${TAG}-${Date.now()}.json`);
  const server = startProc('server', [`server/${PROTO}/server-${PROTO}.js`, '--port', String(SPORT), '--accounts', accounts]);
  await waitLog('server', /listening/);
  const bridges = ['A', 'B', 'C'].map((n, i) => startProc('bridge' + n, ['bridge/bridge.js', '--proto', PROTO, '--server', '127.0.0.1:' + SPORT, '--ui-port', String(8080 + i), ...(DRILL && n === 'C' ? SIM : [])]));
  for (const n of ['A', 'B', 'C']) await waitLog('bridge' + n, /connected to/);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-verify-'));
  const br = spawn(exe, ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${prof}`, '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  await sleep(2500);
  const open = async (port, name) => {
    const t = await (await fetch(`http://127.0.0.1:9334/json/new?http://localhost:${port}/`, { method: 'PUT' })).json();
    const p = new Page(name, t.webSocketDebuggerUrl); await p.ready;
    await p.cmd('Runtime.enable'); await p.cmd('Page.enable'); await p.cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
    p.targetId = t.id; return p;
  };
  const A = await open(8080, 'A'), B = await open(8081, 'B'), Cc = await open(8082, 'C');
  const all = [A, B, Cc];
  await sleep(2500);
  for (const p of all) await until(async () => (await p.ev(INSTR)) !== undefined && (await p.ev('!!window.__v')));
  const sfx = Date.now() % 100000;
  const U = { A: 'ann' + sfx, B: 'ben' + sfx, C: 'cat' + sfx };
  const PW = { A: 'pwA1', B: 'pwB1', C: 'pwC1' };
  const closeTab = async p => { p.closed = true; await fetch(`http://127.0.0.1:9334/json/close/${p.targetId}`); };
  const loggedIn = (p, u) => until(async () => (await p.ov() || '').includes('Logged in as ' + u), 8000);
  const ROOM = 'R' + (sfx % 10000);

  try {
    // ---------------- registration / login
    await auth(A, U.A, PW.A, true);
    rec('register (tab A)', await loggedIn(A, U.A), U.A);
    if (!DRILL) {
      await auth(B, U.A, 'wrong', false);
      const wp = await until(async () => (await B.ov()).includes('Wrong password'), 5000);
      rec('wrong password rejected', wp, wp ? 'UI shows "Wrong password"' : await B.ov());
      await auth(B, U.A, 'whatever', true);
      const du = await until(async () => (await B.ov()).includes('already taken'), 5000);
      rec('duplicate username rejected', du, du ? 'UI shows "Username already taken"' : await B.ov());
    }
    await auth(B, U.B, PW.B, true); await auth(Cc, U.C, PW.C, true);
    rec('register (tabs B, C)', (await loggedIn(B, U.B)) && (await loggedIn(Cc, U.C)));
    if (!DRILL) {
      await click(Cc, '#rawLogout'); await sleep(500);
      await auth(Cc, U.C, PW.C, false);
      rec('login with existing credentials (logout + login, tab C)', await loggedIn(Cc, U.C));
      await click(Cc, '#rawLogout'); await sleep(500);
      await auth(Cc, U.A, PW.A, false);
      const rej = await until(async () => /already logged in/i.test(await Cc.ov()), 5000);
      const aStill = (await A.ov()).includes('Logged in as ' + U.A);
      rec('second login of the same user (correct password) rejected; first session unaffected', rej && aStill, rej ? 'tab C: "' + (await Cc.v('__v.authFail.slice(-1)[0]')) + '"; tab A still logged in: ' + aStill : 'no rejection: ' + (await Cc.ov()).slice(0, 120) + ' / A still logged in: ' + aStill);
      if (!(await Cc.ov()).includes('Logged in as ' + U.C)) { if (await Cc.ev(`!!document.getElementById('rawLogout')`)) { await click(Cc, '#rawLogout'); await sleep(400); } await auth(Cc, U.C, PW.C, false); await loggedIn(Cc, U.C); }
    }
    await stage('logged-in', all);

    // ---------------- lobby / rooms
    await A.ev(`(()=>{document.getElementById('rawRoom').value='${ROOM}';document.getElementById('rawCreate').click()})()`);
    const listed = await until(async () => (await B.ov()).includes(ROOM) && (await Cc.ov()).includes(ROOM), 6000);
    rec('create room; room list on other tabs shows it', listed, ROOM);
    await stage('room-created', all);
    await until(() => click(B, `[data-join="${ROOM}"]`), 4000); await sleep(700);
    await until(() => click(Cc, `[data-join="${ROOM}"]`), 4000);
    const three = await until(async () => { const s = await A.v('__v.status'); return s && s.players.length === 3 && s; }, 15000);
    rec('join room (3 players in room, seen by host)', !!three, three ? three.players.map(p => p.user).join(', ') : '');
    await stage('room-3-joined', all);
    if (!DRILL) {
      await click(B, '#rawLeave');
      const left = await until(async () => (await A.v('__v.left')).some(l => l.user === U.B), 6000);
      await until(() => click(B, `[data-join="${ROOM}"]`), 6000);
      const back = await until(async () => { const s = await A.v('__v.status'); return s && s.players.length === 3 && s.players.some(p => p.user === U.B); }, 15000);
      rec('leave and rejoin room', left && back, `PLAYER_LEFT seen by host: ${!!left}; back in room: ${!!back}`);
      // 4th allowed, 5th rejected (bots: raw-protocol clients through the same server)
      const D = new Bot({ proto: PROTO, host: '127.0.0.1', port: SPORT, user: 'dd' + sfx, pass: 'pwD1' });
      const E = new Bot({ proto: PROTO, host: '127.0.0.1', port: SPORT, user: 'ee' + sfx, pass: 'pwE1' });
      await D.connect(); await D.auth(true); await E.connect(); await E.auth(true);
      D.send(C.JOINROOM, [ROOM, 'D', 0]); const dj = await D.waitFor(C.ROOM_JOINED, null, 5000).then(() => true, () => false);
      E.send(C.JOINROOM, [ROOM, 'E', 0]); const ef = await E.waitFor(C.ERROR, d => d.code === 'errorRoomFull', 5000).then(d => d.msg, () => null);
      const four = await until(async () => { const s = await A.v('__v.status'); return s && s.players.length === 4; }, 5000);
      rec('4th player allowed, 5th rejected', dj && ef && four, `4th joined: ${dj} (tab A sees 4: ${!!four}); 5th: "${ef}"`);
      await stage('room-4-of-4', [A]);
      D.close(); E.close();
      await until(async () => { const s = await A.v('__v.status'); return s && s.players.length === 3; }, 8000);
    }

    // ---------------- start rules
    const hostName = async () => { const s = await A.v('__v.status') || await B.v('__v.status'); const h = s && s.players.find(p => p.host); return h && h.user; };
    const byUser = u => ({ [U.A]: A, [U.B]: B, [U.C]: Cc }[u]);
    let host = byUser(await hostName());
    if (!DRILL) {
      const nonHost = all.find(p => p !== host);
      await nonHost.ev(`RAWLINK.send(3,{settings:{},modules:[]})`);
      const nh = await until(async () => (await nonHost.v('__v.errors')).find(e => e.code === 'cannotStart'), 4000);
      rec('non-host cannot start', nh && /host/.test(nh.msg), nh ? `${nonHost.name}: "${nh.msg}"` : 'no error');
      const notReady = all.find(p => p !== host && p !== nonHost);
      const nameOf = p => p === A ? U.A : p === B ? U.B : U.C;
      const twoReady = await readyAll([host, nonHost], [nameOf(host), nameOf(nonHost)], host);
      await sleep(2500);
      const st = await host.v('__v.status');
      await host.ev(`RAWLINK.send(3,{settings:{},modules:[]})`);
      const nr = await until(async () => (await host.v('__v.errors')).find(e => /ready/.test(e.msg)), 4000);
      rec('not-ready player blocks start', twoReady && st.status === 'waiting' && nr, `2/3 ready () -> status "${st.status}" after 2.5 s; forced start by host -> "${nr && nr.msg}"`);
      await stage('2-ready-1-not', all);
      // host starts with 2 players: the not-ready player leaves, the 2 ready players remain -> host's client starts
      await click(notReady, '#rawLeave');
      const p2 = await until(async () => { const s = await host.v('__v.status'); return s && s.status === 'playing' && s.players.length === 2 && s; }, 12000);
      rec('host starts with 2 players', !!p2, p2 ? p2.players.map(p => p.user).join(' + ') : JSON.stringify(await host.v('__v.status')));
      const warm2 = await waitStreams([host, nonHost], 1);
      for (const p of [host, nonHost]) await p.ev('__v.data={}');
      await playFor([host, nonHost], 4000);
      rec('2-player game: both receive the other player\'s position stream (4 s window after warm-up ' + warm2 + ' ms)', warm2 >= 0 && Object.values(JSON.parse(await nonHost.v('JSON.stringify(__v.data)'))).some(v => v > 30) && Object.values(JSON.parse(await host.v('JSON.stringify(__v.data)'))).some(v => v > 30), `host ${await host.v('JSON.stringify(__v.data)')} / other ${await nonHost.v('JSON.stringify(__v.data)')}`);
      await stage('game1-2players', [host, nonHost]);
      await host.ev('RAWLINK.reportGameEnd()');   // same hook game.js calls when the host's game timer ends
      const r1 = await until(async () => (await host.v('__v.results.length')) >= 1 && (await nonHost.v('__v.results.length')) >= 1, 6000);
      rec('2-player game ends with GAME_RESULT on both tabs', r1);
      await stage('game1-result', [host, nonHost]);
      await hold([host, nonHost], 71, 4500);    // hold FIRE on PvP's game-over screen -> back to the room
      for (const p of [host, nonHost]) await click(p, '#rawResOk');
      await until(() => click(notReady, `[data-join="${ROOM}"]`), 8000);
      await until(async () => { const s = await A.v('__v.status'); return s && s.status === 'waiting' && s.players.length === 3; }, 15000);
    }

    // ---------------- 3-player game
    for (const p of all) { await p.ev(`__v.data={};__v.fires=0;__v.ev=0;`); }
    await sleep(1500);
    await readyAll(all, [U.A, U.B, U.C], A);
    const p3 = await until(async () => { const s = await A.v('__v.status'); return s && s.status === 'playing' && s.players.length === 3 && s; }, 15000);
    rec('host starts with 3 players', !!p3, p3 ? p3.players.map(p => (p.host ? '(host)' : '') + p.user).join(' + ') : JSON.stringify(await A.v('__v.status')));
    host = byUser(await hostName());
    const warm3 = await waitStreams(all, 2);
    for (const p of all) await p.ev('__v.data={};__v.fires=0');
    // protocol proof while 3 bridges are live
    if (!DRILL) {
      const v = netstatProof(`${PROTO.toUpperCase()} version, 3 bridges in a running game`, { server: server.pid, bridgeA: bridges[0].pid, bridgeB: bridges[1].pid, bridgeC: bridges[2].pid });
      rec('protocol purity (netstat -ano by PID)', v.every(x => x[1]), v.map(x => (x[1] ? 'ok ' : 'BAD ') + x[0].split(':')[0] + ' ' + x[2]).join('; '));
    }
    await playFor(all, DRILL ? 20000 : 8000);
    const seen = [];
    for (const p of all) seen.push({ tab: p.name, data: JSON.parse(await p.v('JSON.stringify(__v.data)')), fires: await p.v('__v.fires') });
    const posOk = seen.every(s => Object.keys(s.data).length >= 2 && Object.values(s.data).filter(v => v > 30).length >= 2);
    rec('all 3 players receive each other\'s position updates' + (DRILL ? ' (C on 10% loss + 80 ms)' : ''), warm3 >= 0 && posOk, seen.map(s => `${s.tab}:${JSON.stringify(s.data)}`).join(' ') + ` (warm-up ${warm3} ms)`);
    rec('shots (FIRES events) arrive on every tab', seen.every(s => s.fires > 0), seen.map(s => `${s.tab}:${s.fires}`).join(' '));
    await stage('game2-3players', all);
    // scores: each victim's own client reports its death through the same hook game.js uses on a kill
    const st3 = await A.v('__v.status'); const id = u => st3.players.find(p => p.user === u).id;
    const kills = [[B, U.B, U.A], [Cc, U.C, U.A], [B, U.B, U.C], [A, U.A, U.C], [Cc, U.C, U.A]];
    for (const [p, victim, killer] of kills) { await p.ev(`RAWLINK.reportDeath(${JSON.stringify(id(victim))},${JSON.stringify(id(killer))},true)`); await sleep(600); }
    await sleep(2500);
    const boards = [];
    for (const p of all) boards.push(await p.ev(`(()=>{const t=document.querySelector('#rawov .side');if(!t)return '';const x=t.innerText;return x.slice(x.indexOf('Scoreboard')).replace(/\\s+/g,' ')})()`));
    const sbs = []; for (const p of all) sbs.push(JSON.stringify((await p.v('__v.sb')).ranking.map(r => [r.user, r.score, r.kills, r.deaths])));
    rec('scores identical on all 3 screens', boards[0] && boards.every(b => b === boards[0]) && sbs.every(s => s === sbs[0]) && /3 pts/.test(boards[0]), boards[0]);
    await stage('game2-scores', all);
    // result
    for (const p of all) await p.ev(`__v.results=[]`);
    await host.ev('RAWLINK.reportGameEnd()');
    await until(async () => { for (const p of all) if (!(await p.v('__v.results.length'))) return false; return true; }, 8000);
    const res = []; for (const p of all) res.push(await p.v('__v.results[0]'));
    const sig = r => r && JSON.stringify([r.winner, r.ranking.map(x => [x.rank, x.user, x.score])]);
    const resTxt = []; for (const p of all) resTxt.push(await p.ov());
    rec('GAME_RESULT: same ranking and winner on all 3 screens', res.every(r => r && sig(r) === sig(res[0])) && res[0].winner === U.A && resTxt.every(t => t.includes('WINNER: ' + U.A)), res[0] ? `winner ${res[0].winner}; ${res[0].ranking.map(r => r.rank + '.' + r.user + '=' + r.score).join(' ')}` : 'missing');
    await stage('game2-result', all);
    await hold(all, 71, 4500);
    for (const p of all) await click(p, '#rawResOk');
    await until(async () => { const s = await A.v('__v.status'); return s && s.status === 'waiting' && s.players.length === 3; }, 15000);

    // ---------------- disconnects
    for (const p of all) await p.ev(`__v.data={};__v.dropped=[];__v.host=[];__v.results=[]`);
    await sleep(1500);
    await readyAll(all, [U.A, U.B, U.C], A);
    await until(async () => { const s = await A.v('__v.status'); return s && s.status === 'playing' && s.players.length === 3; }, 15000);
    host = byUser(await hostName());
    const others = all.filter(p => p !== host);
    const warmD = await waitStreams(all, 2);
    if (process.env.EARLY_HOST_DROP) await sleep(+process.env.EARLY_HOST_DROP); else await playFor(all, 2000);
    if (!DRILL) {
      const sum = async p => Object.values(JSON.parse(await p.v('JSON.stringify(__v.data)'))).reduce((a, b) => a + b, 0);
      const pre = []; for (const p of all) pre.push(p.name + ':' + (await sum(p)) + '/state' + (await p.ev('RAWLINK.netplay.state')));
      await stage('before-host-close', all);
      const t0 = Date.now();
      await closeTab(host);
      const dropped = await until(async () => { for (const p of others) if (!(await p.v('__v.dropped.length'))) return false; return Date.now() - t0; }, 15000);
      const hc = await others[0].v('__v.host.slice(-1)[0]');
      const before = Object.values(JSON.parse(await others[1].v('JSON.stringify(__v.data)'))).reduce((a, b) => a + b, 0);
      await playFor(others, 2500);
      const after = Object.values(JSON.parse(await others[1].v('JSON.stringify(__v.data)'))).reduce((a, b) => a + b, 0);
      const playing = (await others[0].v('__v.status')).status === 'playing';
      rec('close HOST tab mid-game: drop detected by the others', !!dropped, `PLAYER_DROPPED (${await others[0].v('__v.dropped[0].reason')}) on both remaining tabs after ${dropped} ms`);
      const closedUser = host === A ? U.A : host === B ? U.B : U.C; const stNow = await others[0].v('__v.status'); const newHost = stNow.players.find(p => p.host);
      rec('host handover', hc && hc.user !== closedUser && newHost && newHost.user === hc.user, hc ? `${closedUser} (host) left -> new host ${hc.user}; room status shows host ${newHost && newHost.user}` : 'no HOST_CHANGED');
      rec('remaining players continue playing; server up', playing && after - before > 30 && !server.exited, `status ${playing ? 'playing' : 'NOT playing'}, +${after - before} position updates in 2.5 s (warm-up ${warmD} ms; before close: ${pre.join(' ')}; netplay state now ${await others[1].ev('RAWLINK.netplay.state')}), server process alive: ${!server.exited}`);
      await stage('host-tab-closed', others);
      await closeTab(others[0]);
      const r = await until(async () => others[1].v('__v.results[0]'), 10000);
      rec('close second tab -> last player gets GAME_RESULT', r && r.reason === 'notEnoughPlayers', r ? `reason ${r.reason}, winner ${r.winner}` : 'none');
      await stage('last-player-result', [others[1]]);
    } else {
      // frozen client: suspend bridge B's process (SIGSTOP equivalent)
      const survivors = [A, Cc];
      const t0 = Date.now();
      const susp = suspend(bridges[1].pid, true);
      const d = await until(async () => { for (const p of survivors) if (!(await p.v('__v.dropped').then(x => x.some(y => y.user === U.B)))) return false; return Date.now() - t0; }, 20000);
      rec('frozen client (bridge B process suspended) detected', susp && !!d, `suspended: ${susp}; PLAYER_DROPPED on A and C after ${d} ms (reason ${await A.v('__v.dropped.find(x=>x.user===' + JSON.stringify(U.B) + ')?.reason')})`);
      suspend(bridges[1].pid, false);
      const before = Object.values(JSON.parse(await A.v('JSON.stringify(__v.data)'))).reduce((a, b) => a + b, 0);
      await playFor(survivors, 3000);
      const after = Object.values(JSON.parse(await A.v('JSON.stringify(__v.data)'))).reduce((a, b) => a + b, 0);
      rec('game continues with A and C (C on lossy link)', after - before > 20 && (await A.v('__v.status')).status === 'playing', `+${after - before} updates`);
      await stage('drill-frozen-B', survivors);
      // abrupt kill of bridge C
      const t1 = Date.now();
      bridges[2].kill();   // TerminateProcess: no BYE, no clean close
      const dk = await until(async () => (await A.v('__v.dropped').then(x => x.some(y => y.user === U.C))) && Date.now() - t1, 20000);
      const r = await until(async () => A.v('__v.results[0]'), 10000);
      rec('killed bridge C detected, A gets result, server up', !!dk && r && !server.exited, `detected after ${dk} ms (reason ${await A.v('__v.dropped.find(x=>x.user===' + JSON.stringify(U.C) + ')?.reason')}); result: ${r && r.reason} winner ${r && r.winner}; server alive ${!server.exited}`);
      await stage('drill-killed-C', [A]);
    }
    // server still serves
    const late = new Bot({ proto: PROTO, host: '127.0.0.1', port: SPORT, user: 'zz' + sfx, pass: 'pwZ1' });
    const ok = await late.connect().then(() => late.auth(true)).then(() => true, () => false); late.close();
    rec('server still accepts new players at the end', ok && !server.exited);
    const pageErr = all.flatMap(p => p.errors.map(e => p.name + ': ' + e.split('\n')[0]));
    rec('no JavaScript errors in any tab', pageErr.length === 0, pageErr.slice(0, 3).join(' | '));
    // crash/handler-error lines only (disconnect reasons such as "error:ECONNRESET" are expected events, not errors)
    const srvErr = (logOf('server').match(/uncaughtException|unhandledRejection|error \(ignored\)|^\s+at /gm) || []).length;
    rec('no server errors in log', srvErr === 0, srvErr + ' error lines');
  } catch (e) {
    rec('UNEXPECTED: ' + e.message, false);
  } finally {
    fs.writeFileSync(path.join(OUT, `${TAG}-results.json`), JSON.stringify(results, null, 1));
    try { br.kill(); } catch (e) { }
    for (const p of procs) { try { if (!p.exited) p.kill(); } catch (e) { } }
    const f = results.filter(r => !r.ok).length;
    console.log(`\n[${TAG.toUpperCase()}] ${results.length - f}/${results.length} checks passed`);
    setTimeout(() => process.exit(f ? 1 : 0), 500);
  }
})();
