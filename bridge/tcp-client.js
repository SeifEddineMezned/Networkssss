// Client side of the TCP transport (used by the bridge and by the test bots).
const net = require('net');
const EventEmitter = require('events');
const { C } = require('../server/common/protocol');
const { encodeFrame, FrameReader } = require('../server/common/framing');
const { SimNet } = require('../server/common/simnet');

class TcpClient extends EventEmitter {
  constructor(opts) {
    super();
    this.host = opts.host; this.port = opts.port;
    this.metrics = opts.metrics;
    this.sim = new SimNet(opts.sim, 'stream', opts.metrics);
    this.proto = 'TCP';
    this.up = false;
  }
  connect() {
    this.reader = new FrameReader();
    this.lastRecv = Date.now();
    const sock = this.sock = net.connect({ host: this.host, port: this.port });
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 5000);
    sock.on('connect', () => { this.lastRecv = Date.now(); });
    sock.on('data', chunk => {
      this.lastRecv = Date.now();
      if (this.metrics) this.metrics.inc('bytesIn', chunk.length);
      let res;
      try { res = this.reader.push(chunk); } catch (e) { return this._down('protocolError'); }
      for (const m of res.msgs) this._onMsg(m);
    });
    sock.on('error', e => this._down('error:' + (e.code || e.message)));
    sock.on('close', () => this._down('closed'));
  }
  _onMsg(m) {
    if (this.metrics) this.metrics.inc('msgsIn');
    if (m.t === C.WELCOME) {
      this.up = true; this.welcome = m.d;
      const hb = m.d.heartbeatMs || 2000, to = m.d.timeoutMs || 6000;
      clearInterval(this.hbTimer);
      this.hbTimer = setInterval(() => {
        if (Date.now() - this.lastRecv > to) return this._down('timeout');
        this.send({ t: C.PING, d: { ts: Date.now() } }, false);
      }, hb);
      return this.emit('up', m.d);
    }
    if (m.t === C.PING) return this.send({ t: C.PONG, d: { ts: m.d.ts } }, false);
    if (m.t === C.PONG) { const r = Date.now() - m.d.ts; if (this.metrics) this.metrics.addRtt(r); this.emit('rtt', r); return; }
    this.emit('message', m, true);
  }
  send(msg, reliable = true) {
    const sock = this.sock;
    if (!sock || sock.destroyed) return;
    if (!reliable && sock.writableLength > 32 * 1024) { if (this.metrics) this.metrics.inc('stateDroppedBackpressure'); return; }
    const f = encodeFrame(msg);
    if (this.metrics) { this.metrics.inc('msgsOut'); this.metrics.inc('bytesOut', f.length); }
    this.sim.send(() => { if (!sock.destroyed) sock.write(f); }, 'c');
  }
  _down(reason) {
    clearInterval(this.hbTimer);
    const wasUp = this.up || this.sock;
    this.up = false;
    if (this.sock) { const s = this.sock; this.sock = null; try { s.destroy(); } catch (e) { } }
    if (wasUp) this.emit('down', reason, Date.now() - this.lastRecv);
  }
  close() { if (this.sock) { try { this.sock.end(); } catch (e) { } } clearInterval(this.hbTimer); this.up = false; const s = this.sock; this.sock = null; if (s) setTimeout(() => s.destroy(), 200); }
  stats() { return {}; }
}

module.exports = { TcpClient };
