// Counters + RTT/interval statistics, used by servers, bridges and bots.
const fs = require('fs');
const path = require('path');

function stats(arr) {
  if (!arr.length) return { n: 0, min: null, avg: null, p95: null, max: null };
  const s = arr.slice().sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const pick = q => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const r = v => Math.round(v * 10) / 10;
  return { n: s.length, min: r(s[0]), avg: r(sum / s.length), p50: r(pick(0.5)), p95: r(pick(0.95)), max: r(s[s.length - 1]) };
}

class Metrics {
  constructor(name) {
    this.name = name;
    this.start = Date.now();
    this.c = {};
    this.rtt = [];
    this.series = {};
  }
  inc(k, n = 1) { this.c[k] = (this.c[k] || 0) + n; }
  get(k) { return this.c[k] || 0; }
  sample(series, v) { (this.series[series] = this.series[series] || []).push(v); if (this.series[series].length > 20000) this.series[series].shift(); }
  addRtt(v) { this.rtt.push(v); if (this.rtt.length > 20000) this.rtt.shift(); }
  jitter() {
    // RFC 3550-style: mean absolute difference between consecutive RTT samples
    if (this.rtt.length < 2) return null;
    let s = 0;
    for (let i = 1; i < this.rtt.length; i++) s += Math.abs(this.rtt[i] - this.rtt[i - 1]);
    return Math.round(s / (this.rtt.length - 1) * 10) / 10;
  }
  summary() {
    const secs = (Date.now() - this.start) / 1000;
    const out = { name: this.name, seconds: Math.round(secs * 10) / 10, counters: Object.assign({}, this.c), rtt: stats(this.rtt), jitter: this.jitter(), series: {} };
    for (const k in this.series) out.series[k] = stats(this.series[k]);
    return out;
  }
  writeJson(file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.summary(), null, 2));
    } catch (e) { console.error('metrics write failed', e.message); }
  }
  appendCsv(file, row) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, Object.keys(row).join(',') + '\n');
      fs.appendFileSync(file, Object.values(row).join(',') + '\n');
    } catch (e) { }
  }
}

module.exports = { Metrics, stats };
