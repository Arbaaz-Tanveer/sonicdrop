// Real-browser end-to-end test (headless Edge/Chrome via the DevTools protocol):
//   1. Browser A runs the Send screen with a real PNG + message; we capture the audio it plays.
//   2. That audio goes through the simulated room channel and is written to a WAV.
//   3. Browser B runs the Receive screen with the WAV as its (fake) microphone.
//   4. Pass = browser B shows the files with "SHA-256 verified".
// Usage: node test/browser-e2e.mjs [modeId] [scenario] [--dist|--dev]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const lib = require('./sim-lib.cjs');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const modeId = +(args.find((a) => /^\d$/.test(a)) || 3);
const scenario = args.find((a) => lib.SCENARIOS[a]) || 'near';
const dev = args.includes('--dev');
const pass = (args.find((a) => a.startsWith('--pass=')) || '').slice(7);
const speedtest = args.includes('--speedtest');
const BROWSER = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync);
const work = mkdtempSync(join(tmpdir(), 'sd-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tiny PNG encoder for a test photo ----
function png(w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = (x * 255) / w; raw[o + 1] = (y * 255) / h; raw[o + 2] = 128 + 127 * Math.sin((x + y) / 23); raw[o + 3] = 255;
    }
  }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function wav(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return b;
}

// ---- minimal CDP client ----
async function launch(name, port, extra) {
  const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(work, name)}`,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream', ...extra, 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 50; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (list.some((t) => t.type === 'page')) break; } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const wait = new Map(); const logs = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${name} ${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push(`[${name} EXCEPTION] ` + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });
  const send = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  return { proc, send, evaluate, logs, close: () => { try { ws.close(); } catch (e) { /* closed */ } proc.kill(); } };
}

const server = spawn(process.execPath, [join(root, 'serve.mjs'), '--port', '8099', ...(dev ? ['--dev'] : [])], { stdio: 'ignore' });
await sleep(800);
const urlArg = args.find((a) => a.startsWith('--url='));
const url = urlArg ? urlArg.slice(6).replace(/\/?$/, '/') : args.includes('--file') ? 'file:///' + join(root, 'dist', 'index.html').split(String.fromCharCode(92)).join('/') : 'http://localhost:8099/';
let A, B, ok = false;
try {
  console.log(`page: ${url}\nbrowser: ${BROWSER}\nmode ${modeId} (${lib.P.modes[modeId].name}) · scenario ${scenario} · ${dev ? 'src/' : 'dist/'}`);
  const pngPath = join(work, 'sunset.png');
  writeFileSync(pngPath, png(900, 600));

  // ---------- A: sender ----------
  A = await launch('tx', 9333, []);
  await A.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__tx = [];
    const orig = AudioBuffer.prototype.copyToChannel;
    AudioBuffer.prototype.copyToChannel = function (src, ch, off) { if (this.sampleRate === 48000) window.__tx.push(Array.from(src)); return orig.call(this, src, ch, off); };` });
  await A.send('Page.navigate', { url: url + (speedtest ? '#test' : '#send') });
  await sleep(1500);
  if (speedtest) {
    await A.evaluate(`document.getElementById('testPlayBtn').click()`);
    for (let i = 0; i < 120; i++) { await sleep(500); if (await A.evaluate('window.__tx.length') >= 16) break; }
    await sleep(500);
  } else {
  const doc = await A.send('Runtime.evaluate', { expression: "document.getElementById('fileInput')" });
  await A.send('DOM.enable');
  await A.send('DOM.setFileInputFiles', { files: [pngPath], objectId: doc.result.result.objectId });
  await A.evaluate(`(() => { const t = document.getElementById('msgInput'); t.value = 'Hello from SonicDrop 👋 sent through the air'; t.dispatchEvent(new Event('input')); })()`);
  await sleep(1500);
  const info = await A.evaluate(`document.getElementById('payloadInfo').textContent + ' | ' + [...document.querySelectorAll('#fileList .sz')].map(e => e.textContent).join(',')`);
  console.log('sender payload:', info);
  await A.evaluate(`document.querySelectorAll('#modeList .mode')[${modeId}].click()`);
  await A.evaluate(`document.getElementById('passInput').value = ${JSON.stringify(pass)}`);
  await A.evaluate(`document.getElementById('txBtn').click()`);
  const want = 14;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const n = await A.evaluate('window.__tx.reduce((a, s) => a + s.length, 0)');
    if (n > want * 48000) break;
  }
  }
  const what = speedtest ? 'speed test' : await A.evaluate(`document.getElementById('txWhat').textContent + ' | pass ' + document.getElementById('txPass').textContent`);
  const parts = await A.evaluate('window.__tx');
  console.log('sender live:', what, `| captured ${parts.length} frames`);
  A.logs.forEach((l) => console.log(l));
  A.close(); A = null;

  // ---------- channel ----------
  const total = parts.reduce((a, p) => a + p.length, 0);
  const txAudio = new Float32Array(total + 48000);
  let o = 24000; for (const p of parts) { txAudio.set(p, o); o += p.length; }
  const ch = lib.channel(txAudio, { ...lib.SCENARIOS[scenario], rxRate: 48000 });
  const wavPath = join(work, 'mic.wav');
  writeFileSync(wavPath, wav(ch.audio, 48000));
  console.log(`channel: ${scenario}, wrote ${(ch.audio.length / 48000).toFixed(1)} s of mic audio`);

  // ---------- B: receiver ----------
  B = await launch('rx', 9334, ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`]);
  if (args.includes('--phone')) await B.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await B.send('Page.navigate', { url: url + '#receive' });
  await sleep(1500);
  await B.evaluate(`document.getElementById('rxBtn').click()`);
  let last = '', triedPass = false;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const s = await B.evaluate(`JSON.stringify({ state: document.getElementById('rxState').textContent, speed: document.getElementById('rxSpeed').textContent,
      snr: document.getElementById('rxSnr').textContent, frames: document.getElementById('rxFrames').textContent,
      title: document.querySelector('.xfer-title')?.textContent, sub: document.querySelector('.xfer-sub')?.textContent,
      verified: !!document.querySelector('.verified'), files: [...document.querySelectorAll('.rfile .nm')].map(e => e.textContent),
      msg: document.querySelector('.preview-msg')?.textContent, err: document.getElementById('rxErr').hidden ? null : document.getElementById('rxErr').textContent,
      locked: !!document.querySelector('.passbox'), reco: document.getElementById('testReco').hidden ? null : document.getElementById('testReco').textContent,
      test: [...document.querySelectorAll('.trow .ts')].map(e => e.textContent).join(' | ') || undefined,
      testSummary: document.getElementById('testCard').hidden ? undefined : document.getElementById('testProg').textContent + (document.getElementById('testCard').open ? ' [open]' : ' [folded]') })`);
    if (s !== last) { console.log('receiver:', s); last = s; }
    const st = JSON.parse(s);
    if (st.err) break;
    if (st.locked && pass && !triedPass) {
      triedPass = true;
      await B.evaluate(`(() => { const i = document.querySelector('.passbox input'); i.value = 'wrong one'; document.querySelector('.passbox button').click(); })()`);
      await sleep(2500);
      const wrong = await B.evaluate(`!!document.querySelector('.xfer-body .err')`);
      console.log('wrong passphrase rejected in UI:', wrong);
      await B.evaluate(`(() => { const i = document.querySelector('.passbox input'); i.value = ${JSON.stringify(pass)}; document.querySelector('.passbox button').click(); })()`);
    }
    if (st.verified || (speedtest && st.reco)) { ok = true; break; }
  }
  const shotArg = args.find((a) => a.startsWith('--shot='));
  if (shotArg) {
    const r = await B.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shotArg.slice(7), Buffer.from(r.result.data, 'base64'));
  }
  B.logs.forEach((l) => console.log(l));
} catch (e) {
  console.error('E2E error:', e);
} finally {
  if (A) A.close();
  if (B) B.close();
  server.kill();
}
console.log(ok ? 'E2E PASS' : 'E2E FAIL');
process.exit(ok ? 0 : 1);
