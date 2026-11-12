// Reliability layer on top of raw UDP datagrams (used by BOTH the UDP server and the UDP client).
//
// Every datagram is a JSON object:
//   { s: <session token>, c: 'R'|'U'|'A', q: <seq>, a: <ack>, b: <ackBits>, t: <type>, d: <payload> }
//   c='R'  RELIABLE ORDERED   : retransmitted until acked, de-duplicated, delivered in order
//   c='U'  UNRELIABLE SEQUENCED: never retransmitted, receiver drops anything older than newest seen
//   c='A'  pure ACK (no payload)
//   a/b    piggy-backed acks: a = highest reliable seq received, bit i of b = (a-1-i) received
//
// RTO follows RFC 6298 (SRTT/RTTVAR, Karn's rule: no samples from retransmitted packets),
// exponential backoff per packet, peer declared dead after MAX_TRIES transmissions.
const { MAX_PACKET } = require('./protocol');

const INITIAL_RTO = 100, MIN_RTO = 60, MAX_RTO = 2000, MAX_TRIES = 8, MAX_OOO = 512;

class ReliableEndpoint {
  // opts: { sendDatagram(buf), deliver(msg, reliable), onFail(), metrics, token }
  constructor(opts) {
    this.o = opts;
    this.token = opts.token || null;
    this.metrics = opts.metrics || null;
    // outgoing
    this.nextR = 1; this.nextU = 1;
    this.unacked = new Map();         // seq -> { pkt, sentAt, firstAt, tries }
    // incoming reliable
    this.expected = 1;                // next in-order reliable seq to deliver
    this.ooo = new Map();             // seq -> msg buffered (arrived early)
    this.maxRecv = 0;
    // incoming unreliable
    this.latestU = 0;
    // RTT
    this.srtt = null; this.rttvar = null; this.rto = INITIAL_RTO;
    this.failed = false;
  }

  m(k, n) { if (this.metrics) this.metrics.inc(k, n); }

  _ackFields() {
    let bits = 0;
    for (let i = 0; i < 32; i++) {
      const s = this.maxRecv - 1 - i;
      if (s <= 0) break;
      if (s < this.expected || this.ooo.has(s)) bits |= (1 << i);
    }
    return { a: this.maxRecv, b: bits >>> 0 };
  }

  _emit(pkt) {
    const f = this._ackFields();
    pkt.a = f.a; pkt.b = f.b;
    if (this.token) pkt.s = this.token;
    const buf = Buffer.from(JSON.stringify(pkt), 'utf8');
    if (buf.length > MAX_PACKET) this.m('oversizePackets');
    this.m('pktsOut'); this.m('bytesOut', buf.length);
    this.o.sendDatagram(buf);
  }

  send(msg, reliable) {
    if (this.failed) return;
    if (reliable) {
      const q = this.nextR++;
      const pkt = { c: 'R', q, t: msg.t, d: msg.d };
      const now = Date.now();
      this.unacked.set(q, { pkt, sentAt: now, firstAt: now, tries: 1 });
      this.m('reliableSent');
      this._emit(pkt);
    } else {
      this._emit({ c: 'U', q: this.nextU++, t: msg.t, d: msg.d });
      this.m('unreliableSent');
    }
  }

  sendAck() { this._emit({ c: 'A' }); this.m('acksSent'); }

  _rttSample(r) {
    if (this.srtt === null) { this.srtt = r; this.rttvar = r / 2; }
    else { this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - r); this.srtt = 0.875 * this.srtt + 0.125 * r; }
    this.rto = Math.min(MAX_RTO, Math.max(MIN_RTO, this.srtt + 4 * this.rttvar));
    if (this.metrics) this.metrics.sample('transportRtt', r);
  }

  _processAcks(a, b) {
    if (typeof a !== 'number') return;
    const now = Date.now();
    const ackOne = (s) => {
      const e = this.unacked.get(s);
      if (!e) return;
      if (e.tries === 1) this._rttSample(now - e.sentAt);   // Karn's rule
      this.unacked.delete(s);
    };
    ackOne(a);
    for (let i = 0; i < 32; i++) if ((b >>> i) & 1) ackOne(a - 1 - i);
  }

  // Feed a parsed datagram object (header already validated by caller).
  receive(pkt) {
    if (this.failed) return;
    this.m('pktsIn');
    this._processAcks(pkt.a, pkt.b);
    if (pkt.c === 'A') return;
    if (typeof pkt.q !== 'number' || pkt.q < 1 || !Number.isSafeInteger(pkt.q)) { this.m('badSeq'); return; }
    if (pkt.c === 'U') {
      if (pkt.q <= this.latestU) { this.m(pkt.q === this.latestU ? 'duplicates' : 'staleDiscarded'); return; }
      if (this.latestU && pkt.q > this.latestU + 1) this.m('unreliableLost', pkt.q - this.latestU - 1);
      this.latestU = pkt.q;
      this.o.deliver({ t: pkt.t, d: pkt.d }, false);
      return;
    }
    if (pkt.c !== 'R') return;
    // reliable
    if (pkt.q > this.maxRecv) this.maxRecv = pkt.q;
    if (pkt.q < this.expected || this.ooo.has(pkt.q)) { this.m('duplicates'); this.sendAck(); return; }
    if (pkt.q > this.expected + MAX_OOO) { this.m('tooFarAhead'); return; }
    if (pkt.q === this.expected) {
      this.expected++;
      this.o.deliver({ t: pkt.t, d: pkt.d }, true);
      while (this.ooo.has(this.expected)) {
        const m = this.ooo.get(this.expected);
        this.ooo.delete(this.expected);
        this.expected++;
        this.o.deliver(m, true);
      }
    } else {
      this.m('outOfOrder');
      this.ooo.set(pkt.q, { t: pkt.t, d: pkt.d });
    }
    this.sendAck();
  }

  // Call every ~20 ms.
  tick() {
    if (this.failed) return;
    const now = Date.now();
    for (const [q, e] of this.unacked) {
      const timeout = Math.min(MAX_RTO * 4, this.rto * Math.pow(2, e.tries - 1));
      if (now - e.sentAt >= timeout) {
        if (e.tries >= MAX_TRIES) {
          this.failed = true;
          this.m('reliableGaveUp');
          if (this.o.onFail) this.o.onFail(`no ACK for seq ${q} after ${MAX_TRIES} tries`);
          return;
        }
        e.tries++; e.sentAt = now;
        this.m('retransmissions');
        this._emit(e.pkt);
      }
    }
  }

  stats() { return { srtt: this.srtt && Math.round(this.srtt), rto: Math.round(this.rto), unacked: this.unacked.size, ooo: this.ooo.size }; }
}

// Header validation for anything that arrives on the UDP socket.
function parseDatagram(buf) {
  if (buf.length > 8192) return null;
  let p;
  try { p = JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (p.c !== 'R' && p.c !== 'U' && p.c !== 'A') return null;
  if (p.c !== 'A' && typeof p.t !== 'number') return null;
  return p;
}

module.exports = { ReliableEndpoint, parseDatagram, MAX_TRIES };
