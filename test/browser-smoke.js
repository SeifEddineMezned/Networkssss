// Real-browser smoke test (no extra deps): drives headless Chrome/Edge through the DevTools
// protocol. Two pages (bridges on :8080 and :8081 must be running) register, create/join a room,
// hold FIRE to get ready, the host starts, they play for a few seconds; screenshots go to logs/.
//   node test/browser-smoke.js [chromePath]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CANDIDATES = [process.argv[2], 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const exe = CANDIDATES.find(p => fs.existsSync(p));
const PORT = 9333;
const OUT = path.join(__dirname, '..', 'logs');
fs.mkdirSync(OUT, { recursive: true });

class Page {
  constructor(name, wsUrl) { this.name = name; this.id = 0; this.pending = {}; this.errors = []; this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = e => { const m = JSON.parse(e.data);
      if (m.id && this.pending[m.id]) { this.pending[m.id](m); delete this.pending[m.id]; }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.errors.push(m.params.args.map(a => a.value || a.description).join(' '));
    };
    this.ready = new Promise(r => this.ws.onopen = r); }
  cmd(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise(r => this.pending[id] = r); }
  async eval(expr) { const r = await this.cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result && r.result.result && r.result.result.value; }
  key(type, code) { return this.cmd('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, keyCode: code }); }
  async shot(file) { const r = await this.cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); }
}

(async () => {
  if (!exe) throw new Error('No Chrome/Edge found');
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-smoke-'));
  const br = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  await sleep(2500);
  const open = async (url, name) => { const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${url}`, { method: 'PUT' })).json(); const p = new Page(name, t.webSocketDebuggerUrl); await p.ready; await p.cmd('Runtime.enable'); await p.cmd('Page.enable'); await p.cmd('Emulation.setFocusEmulationEnabled', { enabled: true }); return p; };
  const A = await open('http://localhost:8080/', 'A');
  const B = await open('http://localhost:8081/', 'B');
  await sleep(3000);
  const uniq = Date.now() % 100000;
  for (const [p, u] of [[A, 'ann' + uniq], [B, 'ben' + uniq]]) {
    const r = await p.eval(`(()=>{const u=document.getElementById('rawUser');if(!u)return 'no login form: '+document.getElementById('rawov').innerText.slice(0,200);u.value='${u}';document.getElementById('rawPass').value='secret';document.getElementById('rawRegister').click();return 'ok'})()`);
    console.log(p.name, 'register:', r);
  }
  await sleep(1500);
  const room = 'S' + (uniq % 10000);
  console.log('A lobby:', (await A.eval(`document.getElementById('rawov').innerText`) || '').replace(/\s+/g, ' ').slice(0, 160));
  await A.eval(`(()=>{document.getElementById('rawRoom').value='${room}';document.getElementById('rawCreate').click()})()`);
  await sleep(2500);
  console.log('B lobby:', (await B.eval(`document.getElementById('rawov').innerText`) || '').replace(/\s+/g, ' ').slice(0, 200));
  await B.eval(`(()=>{const b=document.querySelector('[data-join="${room}"]');if(b)b.click();return !!b})()`);
  await sleep(4000);
  await A.shot(path.join(OUT, 'smoke-1-room-A.png'));
  // hold FIRE (G = keyCode 71) to get ready on both
  for (const p of [A, B]) await p.key('keyDown', 71);
  await sleep(4000);
  for (const p of [A, B]) await p.key('keyUp', 71);
  await sleep(4000);
  const st = await A.eval(`(()=>({net:NETPLAY.isEnabled,state:NETPLAY_STATE_DEBUG=typeof GAME!=='undefined', ov:document.getElementById('rawov').innerText.replace(/\\s+/g,' ').slice(0,300)}))()`);
  console.log('A after ready:', JSON.stringify(st));
  // walk around a bit
  for (const p of [A, B]) await p.key('keyDown', 38);
  await sleep(2500);
  for (const p of [A, B]) await p.key('keyUp', 38);
  await A.shot(path.join(OUT, 'smoke-2-game-A.png'));
  await B.shot(path.join(OUT, 'smoke-2-game-B.png'));
  console.log('A errors:', A.errors.slice(0, 10));
  console.log('B errors:', B.errors.slice(0, 10));
  // B closes the tab -> A should see the drop and the game ends
  await B.cmd('Page.close').catch(() => { });
  await sleep(4000);
  console.log('A after B left:', (await A.eval(`document.getElementById('rawov').innerText`) || '').replace(/\s+/g, ' ').slice(0, 300));
  await A.shot(path.join(OUT, 'smoke-3-result-A.png'));
  br.kill();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
