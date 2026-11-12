// Unit tests for the UDP reliability layer (server/common/reliable.js) over an in-memory
// lossy channel: drop, duplicate, reorder. node test/reliable.test.js
const { ReliableEndpoint } = require('../server/common/reliable');
const { Metrics } = require('../server/common/metrics');
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };

function pair(net) {
  const ma = new Metrics('a'), mb = new Metrics('b');
  const got = { a: [], b: [] };
  let A, B;
  const wire = (to) => buf => {
    if (Math.random() < net.loss) return;
    const copies = Math.random() < net.dup ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      const d = net.delay + Math.random() * net.reorderSpread;
      setTimeout(() => to().receive(JSON.parse(buf)), d);
    }
  };
  A = new ReliableEndpoint({ metrics: ma, sendDatagram: wire(() => B), deliver: (m, r) => got.a.push([m, r]) });
  B = new ReliableEndpoint({ metrics: mb, sendDatagram: wire(() => A), deliver: (m, r) => got.b.push([m, r]) });
  const timer = setInterval(() => { A.tick(); B.tick(); }, 10);
  return { A, B, got, ma, mb, stop: () => clearInterval(timer) };
}

async function scenario(name, net, n = 300) {
  const p = pair(net);
  for (let i = 0; i < n; i++) { p.A.send({ t: 1, d: i }, true); p.A.send({ t: 2, d: i }, false); }
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    await new Promise(r => setTimeout(r, 50));
    if (p.got.b.filter(x => x[1]).length >= n && p.A.unacked.size === 0) break;
  }
  p.stop();
  const rel = p.got.b.filter(x => x[1]).map(x => x[0].d);
  const unrel = p.got.b.filter(x => !x[1]).map(x => x[0].d);
  const inOrder = rel.every((v, i) => v === i);
  const unrelMonotonic = unrel.every((v, i) => i === 0 || v > unrel[i - 1]);
  const c = p.ma.summary().counters, cb = p.mb.summary().counters;
  check(`${name}: all ${n} reliable msgs delivered exactly once, in order`, rel.length === n && inOrder, `got ${rel.length}, retransmissions ${c.retransmissions || 0}, dup discarded ${cb.duplicates || 0}, buffered out-of-order ${cb.outOfOrder || 0}, ${Date.now() - t0} ms`);
  check(`${name}: unreliable channel never delivers stale/duplicate`, unrelMonotonic, `delivered ${unrel.length}/${n}, lost ${cb.unreliableLost || 0}, stale dropped ${cb.staleDiscarded || 0}`);
  check(`${name}: nothing left unacked`, p.A.unacked.size === 0, `srtt ${p.A.stats().srtt} rto ${p.A.stats().rto}`);
}

(async () => {
  await scenario('clean', { loss: 0, dup: 0, delay: 1, reorderSpread: 0 });
  await scenario('20% loss', { loss: 0.2, dup: 0, delay: 5, reorderSpread: 0 });
  await scenario('10% duplicates', { loss: 0, dup: 0.1, delay: 5, reorderSpread: 0 });
  await scenario('heavy reordering (0-40 ms spread)', { loss: 0, dup: 0, delay: 5, reorderSpread: 40 });
  await scenario('all together: 15% loss + 5% dup + reorder', { loss: 0.15, dup: 0.05, delay: 20, reorderSpread: 30 });
  // dead peer -> give up after MAX_TRIES
  let failed = null;
  const dead = new ReliableEndpoint({ sendDatagram: () => { }, deliver: () => { }, onFail: why => failed = why });
  dead.send({ t: 1, d: 1 }, true);
  const t0 = Date.now();
  while (!failed && Date.now() - t0 < 20000) { dead.tick(); await new Promise(r => setTimeout(r, 10)); }
  check('dead peer detected by reliability layer (gives up after 8 tries)', !!failed, `${failed} after ${Date.now() - t0} ms`);
  console.log(`\n${pass}/${pass + fail} reliability checks passed`);
  process.exit(fail ? 1 : 0);
})();
