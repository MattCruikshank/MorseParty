// Drives headless Edge over the DevTools protocol. Usage: node test/e2e.mjs <edge.exe> <out.png>
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [edge, out] = process.argv.slice(2);
const port = 9333;
const proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, '--autoplay-policy=no-user-gesture-required',
  '--window-size=1300,1300', '--user-data-dir=' + process.env.TEMP + '\mp-e2e-profile', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch { await sleep(200); }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
await cdp('Page.enable');
await cdp('Page.navigate', { url: 'http://localhost:8765/test/harness.html' });
await sleep(1500);
await ev('run(), 1');
let done;
for (let i = 0; i < 120 && !done; i++) { await sleep(500); done = await ev('window.done'); }
console.log((await ev('log')).join('\n'));
console.log('RESULT:', done);
const shot = await cdp('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
proc.kill();
process.exit(0);
