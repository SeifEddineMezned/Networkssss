// Headless raw-protocol client (no browser). Speaks exactly what the bridge speaks.
// Library usage: const { Bot } = require('./bot');  CLI: node test/bot.js --proto udp --server HOST:PORT --user bob --pass x --room R1
const { C, NAMES } = require('../server/common/protocol');
const { TcpClient } = require('../bridge/tcp-client');
const { UdpClient } = require('../bridge/udp-client');
const { Metrics } = require('../server/common/metrics');

class Bot {
  constructor(o) {
    this.o = o;
    this.name = o.user;
    this.metrics = new Metrics('bot-' + o.user);
    const Cls = o.proto === 'udp' ? UdpClient : TcpClient;
    this.link = new Cls({ host: o.host, port: o.port, sim: o.sim, metrics: this.metrics });
    this.inbox = [];
    this.waiters = [];
    this.states = {};          // remote player id -> latest state
    this.stateTimes = [];      // arrival timestamps of state updates (rate/jitter)
    this.lastStateSeq = {};
    this.link.on('message', (m) => this._onMsg(m));
    this.link.on('down', (reason, silence) => { this.downReason = reason; this._onMsg({ t: -1, d: { reason, silence } }); });
  }
  connect(timeout = 5000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(this.name + ': connect timeout')), timeout);
      this.link.once('up', w => { clearTimeout(t); this.id = w.id; res(w); });
      this.link.connect();
    });
  }
  send(t, d, reliable = true) { this.link.send({ t, d }, reliable); }
  _onMsg(m) {
    if (m.t === C.DATA) {
      const now = Date.now();
      this.stateTimes.push(now);
      (m.d[0] || []).forEach(p => {
        const prev = this.states[p.id];
        if (prev && p.data && typeof p.data[6] === 'number' && typeof prev[6] === 'number' && p.data[6] > prev[6] + 1)
          this.metrics.inc('stateGaps', p.data[6] - prev[6] - 1);
        if (prev && p.data && typeof p.data[6] === 'number' && p.data[6] <= prev[6]) { this.metrics.inc('stateStaleApplied'); return; }
        this.states[p.id] = p.data;
        if (p.data && typeof p.data[7] === 'number') this.metrics.sample('stateAgeMs', now - p.data[7]);
      });
      this.metrics.inc('stateUpdates', (m.d[0] || []).length);
      (m.d[1] || []).forEach(ev => this.metrics.inc('eventsIn'));
    }
    this.inbox.push(m);
    if (this.inbox.length > 5000) this.inbox.splice(0, 2500);
    for (const w of this.waiters.slice()) {
      if (w.t === m.t && (!w.pred || w.pred(m.d))) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.timer); w.res(m.d); }
    }
    if (this.o.verbose && m.t !== C.DATA && m.t !== C.SESSION_STATUS && m.t !== C.SCOREBOARD) console.log(`  [${this.name}] <- ${NAMES[m.t] || m.t} ${JSON.stringify(m.d).substr(0, 160)}`);
  }
  // Wait for a message of type t (optionally matching pred). Also checks already received ones if `past`.
  waitFor(t, pred, timeout = 5000, past = false) {
    if (past) { const f = this.inbox.find(m => m.t === t && (!pred || pred(m.d))); if (f) return Promise.resolve(f.d); }
    return new Promise((res, rej) => {
      const w = { t, pred, res };
      w.timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); rej(new Error(`${this.name}: timeout waiting for ${NAMES[t] || t}`)); }, timeout);
      this.waiters.push(w);
    });
  }
  async auth(register = true) {
    const ok = this.waitFor(C.AUTH_OK, null, 5000);
    const fail = this.waitFor(C.AUTH_FAIL, null, 5000).then(d => { throw new Error(d.msg); });
    this.send(register ? C.REGISTER : C.LOGIN, { user: this.o.user, pass: this.o.pass });
    return Promise.race([ok, fail]).finally(() => { ok.catch(() => { }); fail.catch(() => { }); });
  }
  // Simulate the PvP client state stream: [id, playing, walking, x, y, angle, seq, sentTs]
  startStreaming(slot, hz = 30) {
    const s = this._stream = this._stream || { seq: 0, x: 2 + slot, y: 2, a: 0 };   // continues across pauses
    clearInterval(this.streamTimer);
    this.streamTimer = setInterval(() => {
      s.seq++; s.a += 0.1; s.x += Math.cos(s.a) * 0.05; s.y += Math.sin(s.a) * 0.05;
      this.send(C.BROADCAST, [[{ id: slot, data: [slot, true, true, +s.x.toFixed(2), +s.y.toFixed(2), +s.a.toFixed(3), s.seq, Date.now()] }], []], false);
    }, Math.round(1000 / hz));
  }
  stopStreaming() { clearInterval(this.streamTimer); }
  close() { this.stopStreaming(); this.link.close(); }
  // Unexpected disconnection: vanish without BYE/FIN (simulates Wi-Fi off / crash)
  // mode 'freeze': process hangs / cable pulled -> socket stays open but nothing is sent or read
  //               (half-open connection: ONLY the application heartbeat can detect it)
  // mode 'kill'  : process killed -> OS closes the socket (TCP sends RST/FIN, UDP sends nothing)
  vanish(mode = 'kill') {
    this.stopStreaming();
    const l = this.link;
    l.removeAllListeners('down');
    if (mode === 'freeze') {
      clearInterval(l.hbTimer); clearInterval(l.tickTimer);
      l.send = () => { };
      if (l.sock) { if (l.proto === 'UDP') { l.sock.removeAllListeners('message'); } else { l.sock.pause(); } }
      return;
    }
    if (l.proto === 'UDP') { l.closed = true; clearInterval(l.tickTimer); clearInterval(l.hbTimer); try { l.sock.close(); } catch (e) { } l.sock = null; }
    else { clearInterval(l.hbTimer); try { l.sock.destroy(); } catch (e) { } }
  }
}

module.exports = { Bot };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const proto = arg('--proto', 'tcp');
  const [host, port] = arg('--server', '127.0.0.1:' + (proto === 'udp' ? 9001 : 9000)).split(':');
  const user = arg('--user', 'bot' + Math.floor(Math.random() * 1000));
  const bot = new Bot({ proto, host, port: +port, user, pass: arg('--pass', 'botpass'), verbose: true });
  (async () => {
    await bot.connect();
    try { await bot.auth(true); } catch (e) { await bot.auth(false); }
    const room = arg('--room', 'BOTS');
    bot.send(C.JOINROOM, [room, user, 0]);
    await bot.waitFor(C.ROOM_JOINED);
    bot.send(C.SETCONFIRM, true);
    console.log(`${user} joined ${room} and is ready; streaming once the game starts. Ctrl+C to quit.`);
    bot.waitFor(C.ROOMFROZEN, null, 3600000).then(() => bot.startStreaming(3));
    process.on('SIGINT', () => { bot.close(); setTimeout(() => process.exit(0), 300); });
  })().catch(e => { console.error(e.message); process.exit(1); });
}
