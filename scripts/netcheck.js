#!/usr/bin/env node
// Cross-network proof: run on EVERY client machine before the demo.
//   node scripts/netcheck.js SERVER_IP [--tcp 9000] [--udp 9001] [--no-public-ip]
// Prints this machine's local + public IP, then: raw TCP connect time + app RTT (PING/PONG),
// and raw UDP echo RTT (as seen by the server, including the address the server sees = your NAT).
const net = require('net');
const dgram = require('dgram');
const os = require('os');
const https = require('https');
const { encodeFrame, FrameReader } = require('../server/common/framing');
const { C } = require('../server/common/protocol');

const argv = process.argv.slice(2);
const host = argv.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || '127.0.0.1';
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const TCP = +arg('--tcp', 9000), UDP = +arg('--udp', 9001);

function publicIp() {
  if (argv.includes('--no-public-ip')) return Promise.resolve('(skipped)');
  return new Promise(res => {
    const r = https.get('https://api.ipify.org', { timeout: 4000 }, s => { let b = ''; s.on('data', d => b += d); s.on('end', () => res(b.trim())); });
    r.on('error', () => res('(unknown - no internet?)')); r.on('timeout', () => { r.destroy(); res('(timeout)'); });
  });
}

function tcpCheck() {
  return new Promise(res => {
    const t0 = Date.now(); let connectMs = null; const rtts = []; const rd = new FrameReader();
    const s = net.connect({ host, port: TCP });
    const done = (ok, msg) => { try { s.destroy(); } catch (e) { } res({ ok, msg, connectMs, rtts }); };
    const to = setTimeout(() => done(false, 'timeout (no answer in 5 s): check server firewall / cloud security list / IP'), 5000);
    s.on('connect', () => { connectMs = Date.now() - t0; });
    s.on('data', chunk => {
      for (const m of rd.push(chunk).msgs) {
        if (m.t === C.WELCOME || m.t === C.PONG) {
          if (m.t === C.PONG) rtts.push(Date.now() - m.d.ts);
          if (rtts.length >= 5) { clearTimeout(to); return done(true, 'ok'); }
          s.write(encodeFrame({ t: C.PING, d: { ts: Date.now() } }));
        }
      }
    });
    s.on('error', e => { clearTimeout(to); done(false, e.code + (e.code === 'ECONNREFUSED' ? ' (host reachable but nothing listening on ' + TCP + '/tcp)' : '')); });
  });
}

function udpCheck() {
  return new Promise(res => {
    const s = dgram.createSocket('udp4'); const rtts = []; let you = null, sent = 0;
    const done = (ok, msg) => { clearInterval(iv); try { s.close(); } catch (e) { } res({ ok, msg, rtts, you, sent }); };
    s.on('message', b => { try { const m = JSON.parse(b); if (m.h === 'ECHO') { rtts.push(Date.now() - +m.n.split('-')[0]); you = m.you; if (rtts.length >= 5) done(true, 'ok'); } } catch (e) { } });
    s.on('error', e => done(false, e.code));
    const iv = setInterval(() => { sent++; s.send(Buffer.from(JSON.stringify({ h: 'ECHO', n: Date.now() + '-' + sent })), UDP, host); }, 200);
    setTimeout(() => done(rtts.length > 0, rtts.length ? `ok (${rtts.length}/${sent} echoes)` : 'no echo in 5 s: UDP blocked (firewall / cloud security list / wrong IP) or server not running'), 5000);
  });
}

const fmt = a => a.length ? `min ${Math.min(...a)} / avg ${Math.round(a.reduce((x, y) => x + y, 0) / a.length)} / max ${Math.max(...a)} ms` : '-';
(async () => {
  const locals = Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address);
  console.log(`machine:      ${os.hostname()} (${os.platform()})`);
  console.log(`local IPv4:   ${locals.join(', ') || '-'}`);
  console.log(`public IP:    ${await publicIp()}`);
  console.log(`server:       ${host}  (TCP ${TCP}, UDP ${UDP})\n`);
  const t = await tcpCheck();
  console.log(`[TCP] ${t.ok ? 'OK  ' : 'FAIL'} connect ${t.connectMs != null ? t.connectMs + ' ms' : '-'}, app RTT ${fmt(t.rtts)}  ${t.ok ? '' : '-> ' + t.msg}`);
  const u = await udpCheck();
  console.log(`[UDP] ${u.ok ? 'OK  ' : 'FAIL'} echo RTT ${fmt(u.rtts)}, server sees you as ${u.you || '-'}  ${u.ok ? '' : '-> ' + u.msg}`);
  process.exit(t.ok || u.ok ? 0 : 1);
})();
