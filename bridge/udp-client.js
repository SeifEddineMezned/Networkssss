// Client side of the UDP transport (bridge + test bots). Contains the client half of the
// reliability layer: handshake with nonce/token, reliable+unreliable channels, heartbeat.
const dgram = require('dgram');
const crypto = require('crypto');
const EventEmitter = require('events');
const { C, safeParse } = require('../server/common/protocol');
const { SimNet } = require('../server/common/simnet');
const { ReliableEndpoint, parseDatagram } = require('../server/common/reliable');

class UdpClient extends EventEmitter {
  constructor(opts) {
    super();
    this.host = opts.host; this.port = opts.port;
    this.metrics = opts.metrics;
    this.sim = new SimNet(opts.sim, 'datagram', opts.metrics);
    this.proto = 'UDP';
    this.up = false;
  }
  connect() {
    this.closed = false;
    this.nonce = crypto.randomBytes(6).toString('hex');
    this.lastRecv = Date.now();
    const sock = this.sock = dgram.createSocket('udp4');
    sock.on('error', e => this._down('error:' + (e.code || e.message)));
    sock.on('message', buf => this._onDatagram(buf));
    // Handshake: repeat HELLO until WELCOME (the handshake itself must survive loss).
    let tries = 0;
    const hello = () => {
      if (this.up || this.closed) return;
      if (++tries > 20) return this._down('handshakeTimeout', true);
      this._raw({ h: 'HELLO', n: this.nonce, v: 1 });
      this.helloTimer = setTimeout(hello, 500);
    };
    hello();
  }
  _raw(obj) {
    const buf = Buffer.from(JSON.stringify(obj));
    if (this.metrics) this.metrics.inc('bytesOut', buf.length);
    const sock = this.sock;
    this.sim.send(() => { if (sock && !this.closed) sock.send(buf, this.port, this.host, () => { }); });
  }
  _onDatagram(buf) {
    if (this.metrics) this.metrics.inc('bytesIn', buf.length);
    const raw = safeParse(buf.toString('utf8'));
    if (!raw || typeof raw !== 'object') return;
    if (raw.h === 'WELCOME') {
      if (raw.n !== this.nonce || this.up) return;
      this.token = raw.s;
      this.lastRecv = Date.now();
      this.ep = new ReliableEndpoint({
        token: this.token, metrics: this.metrics,
        sendDatagram: b => { const sock = this.sock; this.sim.send(() => { if (sock && !this.closed) sock.send(b, this.port, this.host, () => { }); }); },
        deliver: (m, rel) => this._onMsg(m, rel),
        onFail: why => this._down('retransmitTimeout'),
      });
      this.up = true;
      clearTimeout(this.helloTimer);
      const hb = raw.heartbeatMs || 1000, to = raw.timeoutMs || 5000;
      this.tickTimer = setInterval(() => this.ep && this.ep.tick(), 20);
      this.hbTimer = setInterval(() => {
        if (Date.now() - this.lastRecv > to) return this._down('timeout');
        this.send({ t: C.PING, d: { ts: Date.now() } }, false);
      }, hb);
      this.welcome = { id: raw.id, transport: 'UDP', heartbeatMs: hb, timeoutMs: to };
      return this.emit('up', this.welcome);
    }
    if (raw.h === 'BYE') return this._down('serverDropped');
    if (!this.ep) return;
    const p = parseDatagram(buf);
    if (!p) return;
    this.lastRecv = Date.now();
    this.ep.receive(p);
  }
  _onMsg(m, reliable) {
    if (this.metrics) this.metrics.inc('msgsIn');
    if (m.t === C.PING) return this.send({ t: C.PONG, d: { ts: m.d && m.d.ts } }, false);
    if (m.t === C.PONG) { const r = Date.now() - m.d.ts; if (this.metrics) this.metrics.addRtt(r); this.emit('rtt', r); return; }
    this.emit('message', m, reliable);
  }
  send(msg, reliable = true) {
    if (!this.up || !this.ep) return;
    if (this.metrics) this.metrics.inc('msgsOut');
    this.ep.send(msg, reliable);
  }
  _down(reason, force) {
    const was = this.up || force;
    this.up = false;
    this.closed = true;
    clearTimeout(this.helloTimer); clearInterval(this.tickTimer); clearInterval(this.hbTimer);
    if (this.sock) { const s = this.sock; this.sock = null; try { s.close(); } catch (e) { } }
    if (was) this.emit('down', reason, Date.now() - this.lastRecv);
  }
  close() {
    // explicit BYE on clean exit (sent twice, best effort, then the socket closes)
    if (this.up && this.ep) { this.ep.send({ t: C.BYE, d: {} }, false); this.ep.send({ t: C.BYE, d: {} }, false); }
    this.up = false;
    setTimeout(() => { this.closed = true; clearInterval(this.tickTimer); clearInterval(this.hbTimer); if (this.sock) { try { this.sock.close(); } catch (e) { } this.sock = null; } }, 100);
  }
  stats() { return this.ep ? this.ep.stats() : {}; }
}

module.exports = { UdpClient };
