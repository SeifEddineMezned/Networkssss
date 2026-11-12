// Network impairment simulator applied to every OUTGOING packet/frame.
//   --sim-loss 0.1 --sim-delay 80 --sim-jitter 20 --sim-dup 0.02 --sim-reorder 0.05
//
// UDP mode ("datagram"): each datagram is independently dropped / delayed / duplicated /
//   reordered, exactly like a lossy IP network would do to UDP.
// TCP mode ("stream"): the kernel retransmits lost TCP segments, so the application never sees
//   loss, it sees *delay*. We model a lost segment as a frame delivered after an RTO
//   (default 200 ms, Linux/Windows minimum RTO order of magnitude) and, because TCP delivers in
//   order, every later frame waits behind it (head-of-line blocking). Dup/reorder are hidden by
//   TCP and therefore ignored. For real OS-level loss on TCP use clumsy (Windows) / tc netem (Linux).

function parseSimArgs(argv) {
  const o = { loss: 0, delay: 0, jitter: 0, dup: 0, reorder: 0, rto: 200 };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--sim-(loss|delay|jitter|dup|reorder|rto)$/.exec(argv[i]);
    if (m) o[m[1]] = parseFloat(argv[++i]) || 0;
  }
  return o;
}

function isActive(o) { return !!(o && (o.loss || o.delay || o.jitter || o.dup || o.reorder)); }

class SimNet {
  constructor(opts, mode, metrics) {
    this.o = Object.assign({ loss: 0, delay: 0, jitter: 0, dup: 0, reorder: 0, rto: 200 }, opts || {});
    this.mode = mode;           // 'datagram' | 'stream'
    this.metrics = metrics;
    this.active = isActive(this.o);
    this.lastRelease = new Map(); // stream key -> last scheduled delivery time
  }

  // deliver(): actually puts the bytes on the wire. key: per-connection key (stream mode)
  send(deliver, key) {
    if (!this.active) return deliver();
    const o = this.o;
    const base = o.delay + (o.jitter ? (Math.random() * 2 - 1) * o.jitter : 0);
    if (this.mode === 'datagram') {
      if (Math.random() < o.loss) { if (this.metrics) this.metrics.inc('simDropped'); return; }
      let d = Math.max(0, base);
      if (Math.random() < o.reorder) { d += 30 + Math.random() * 40; if (this.metrics) this.metrics.inc('simReordered'); }
      setTimeout(deliver, d);
      if (Math.random() < o.dup) { if (this.metrics) this.metrics.inc('simDuplicated'); setTimeout(deliver, d + 5); }
    } else {
      let d = Math.max(0, base);
      let tries = 0;
      while (Math.random() < o.loss && tries < 6) { d += o.rto * Math.pow(2, tries); tries++; }
      if (tries && this.metrics) this.metrics.inc('simTcpRetransmitDelays', tries);
      // strict FIFO per connection: a delayed ("retransmitted") frame blocks every later frame
      let q = this.lastRelease.get(key);
      if (!q) { q = { items: [], timer: null }; this.lastRelease.set(key, q); }
      const prevAt = q.items.length ? q.items[q.items.length - 1].at : 0;
      q.items.push({ at: Math.max(Date.now() + d, prevAt), deliver });
      const pump = () => {
        q.timer = null;
        const now = Date.now();
        while (q.items.length && q.items[0].at <= now) q.items.shift().deliver();
        if (q.items.length) q.timer = setTimeout(pump, q.items[0].at - now);
      };
      if (!q.timer) q.timer = setTimeout(pump, Math.max(0, q.items[0].at - Date.now()));
    }
  }
}

module.exports = { SimNet, parseSimArgs, isActive };
