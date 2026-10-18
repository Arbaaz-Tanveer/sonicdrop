// Screenshots of every screen (desktop + phone) with a live transfer, for visual review.
// Usage: node test/screens.mjs [outDir]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { launch, png, wav, sleep, work } from './cdp.mjs';

const require = createRequire(import.meta.url);
const lib = require('./sim-lib.cjs');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || join(root, 'test', 'shots');
mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, [join(root, 'serve.mjs'), '--port', '8098'], { stdio: 'ignore' });
await sleep(800);
const url = 'http://localhost:8098/';

async function shot(b, name, full) {
  let clip;
  if (full) {
    const h = await b.evaluate('document.documentElement.scrollHeight');
    const w = await b.evaluate('document.documentElement.clientWidth');
    clip = { x: 0, y: 0, width: w, height: Math.min(h, 4000), scale: 1 };
  }
  const r = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full, ...(clip ? { clip } : {}) });
  writeFileSync(join(out, name + '.png'), Buffer.from(r.result.data, 'base64'));
  console.log('saved', name);
}
const viewport = (b, w, h, mobile) => b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });

try {
  const pngPath = join(work, 'sunset.png');
  writeFileSync(pngPath, png(900, 600));
  // Capture a transmission for the receiver.
  const A = await launch('shots-tx', 9343, []);
  await A.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__tx=[];const o=AudioBuffer.prototype.copyToChannel;AudioBuffer.prototype.copyToChannel=function(s,c,f){if(this.sampleRate===48000)window.__tx.push(Array.from(s));return o.call(this,s,c,f);};` });
  await viewport(A, 1280, 860, false);
  await A.send('Page.navigate', { url });
  await sleep(1200);
  await shot(A, 'desktop-home', true);
  await A.send('Page.navigate', { url: url + '#send' });
  await sleep(1000);
  const doc = await A.send('Runtime.evaluate', { expression: "document.getElementById('fileInput')" });
  await A.send('DOM.enable');
  await A.send('DOM.setFileInputFiles', { files: [pngPath], objectId: doc.result.result.objectId });
  await A.evaluate(`(() => { const t = document.getElementById('msgInput'); t.value = 'Meet at the café at 6 ☕'; t.dispatchEvent(new Event('input')); })()`);
  await A.evaluate(`document.querySelectorAll('#modeList .mode')[3].click()`);
  await sleep(1500);
  await shot(A, 'desktop-send', true);
  await A.evaluate(`document.getElementById('txBtn').click()`);
  await sleep(6000);
  await shot(A, 'desktop-sending', false);
  for (let i = 0; i < 40 && (await A.evaluate('window.__tx.length')) < 6; i++) await sleep(500);
  const parts = await A.evaluate('window.__tx');
  await viewport(A, 390, 844, true);
  await A.evaluate(`location.hash = ''`);
  await sleep(800);
  await shot(A, 'phone-home', false);
  await A.evaluate(`location.hash = 'send'`);
  await sleep(800);
  await shot(A, 'phone-send', true);
  A.logs.forEach((l) => console.log(l));
  A.close();

  const total = parts.reduce((a, p) => a + p.length, 0);
  const tx = new Float32Array(total + 96000); let o = 48000; for (const p of parts) { tx.set(p, o); o += p.length; }
  const ch = lib.channel(tx, { ...lib.SCENARIOS.near, rxRate: 48000 });
  const wavPath = join(work, 'mic.wav');
  writeFileSync(wavPath, wav(ch.audio, 48000));

  const B = await launch('shots-rx', 9344, ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`]);
  await viewport(B, 1280, 860, false);
  await B.send('Page.navigate', { url: url + '#receive' });
  await sleep(1000);
  await shot(B, 'desktop-receive-idle', false);
  await B.evaluate(`document.getElementById('rxBtn').click()`);
  await sleep(2600);
  await shot(B, 'desktop-receiving', false);
  for (let i = 0; i < 40 && !(await B.evaluate(`!!document.querySelector('.verified')`)); i++) await sleep(500);
  await B.evaluate(`document.querySelector('details.diag').open = true`);
  await sleep(2500);
  await shot(B, 'desktop-received', true);
  await viewport(B, 390, 844, true);
  await sleep(1500);
  await shot(B, 'phone-received', true);
  B.logs.forEach((l) => console.log(l));
  B.close();
} finally {
  server.kill();
}
process.exit(0);
