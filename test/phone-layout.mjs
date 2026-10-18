// Phone-viewport regression: spectrogram height must stay fixed across restarts, received files must be
// near the top, and repeated transfers must not pile up. Usage: node test/phone-layout.mjs [shotDir]
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
const server = spawn(process.execPath, [join(root, 'serve.mjs'), '--port', '8097'], { stdio: 'ignore' });
await sleep(800);
const url = 'http://localhost:8097/';
let pass = true;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); if (!ok) pass = false; };
const phone = (b) => b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

try {
  // Sender: two separate transmissions (two sessions), captured back to back.
  const pngPath = join(work, 'photo.png');
  writeFileSync(pngPath, png(800, 600));
  const A = await launch('pl-tx', 9353, []);
  await A.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__tx=[];const o=AudioBuffer.prototype.copyToChannel;AudioBuffer.prototype.copyToChannel=function(s,c,f){if(this.sampleRate===48000)window.__tx.push(Array.from(s));return o.call(this,s,c,f);};` });
  await A.send('Page.navigate', { url: url + '#send' });
  await sleep(1200);
  const doc = await A.send('Runtime.evaluate', { expression: "document.getElementById('fileInput')" });
  await A.send('DOM.enable');
  await A.send('DOM.setFileInputFiles', { files: [pngPath], objectId: doc.result.result.objectId });
  await A.evaluate(`document.querySelectorAll('#modeList .mode')[3].click()`);
  await sleep(1500);
  const segs = [];
  for (let round = 0; round < 2; round++) {
    await A.evaluate(`window.__tx = []; document.getElementById('txBtn').click()`);
    for (let i = 0; i < 60 && (await A.evaluate('window.__tx.length')) < 5; i++) await sleep(400);
    segs.push(await A.evaluate('window.__tx'));
    await A.evaluate(`document.getElementById('txStop').click()`);
    await sleep(500);
  }
  A.close();
  const parts = [new Float32Array(48000), ...segs[0].map((p) => Float32Array.from(p)), new Float32Array(72000), ...segs[1].map((p) => Float32Array.from(p)), new Float32Array(96000)];
  const tx = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { tx.set(p, o); o += p.length; }
  const ch = lib.channel(tx, { ...lib.SCENARIOS.near, rxRate: 48000 });
  const wavPath = join(work, 'mic.wav');
  writeFileSync(wavPath, wav(ch.audio, 48000));

  // Receiver on a 3x phone.
  const B = await launch('pl-rx', 9354, ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}%noloop`]);
  await phone(B);
  await B.send('Page.navigate', { url: url + '#receive' });
  await sleep(1000);
  const heights = [];
  for (let i = 0; i < 3; i++) {
    await B.evaluate(`document.getElementById('rxBtn').click()`);
    await sleep(900);
    heights.push(await B.evaluate(`document.getElementById('rxWaterfall').getBoundingClientRect().height`));
    if (i < 2) { await B.evaluate(`document.getElementById('rxStop').click()`); await sleep(400); }
  }
  check('spectrogram height fixed across restarts', heights.every((h) => h === heights[0]) && heights[0] <= 110, heights.join(' / ') + ' px');
  const cv = await B.evaluate(`[document.getElementById('rxWaterfall').width, document.getElementById('rxWaterfall').height].join('x')`);
  check('spectrogram internal resolution fixed', cv === '360x120', cv);

  // Wait for both transfers.
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    if (await B.evaluate(`document.querySelectorAll('.xfer').length === 2 && !!document.querySelector('.xfer:not(.compact) .verified')`)) break;
  }
  await sleep(1500);
  const r = JSON.parse(await B.evaluate(`JSON.stringify({
    cards: document.querySelectorAll('.xfer').length,
    compact: document.querySelectorAll('.xfer.compact').length,
    liveFirst: document.querySelector('#recvLive > *:not([hidden])')?.classList.contains('live'),
    specTop: document.getElementById('rxWaterfall').getBoundingClientRect().top + scrollY,
    speedTop: document.getElementById('rxSpeed').getBoundingClientRect().top + scrollY,
    dlTop: (() => { const b = document.querySelector('.xfer:not(.compact) .btn.primary'); return b ? b.getBoundingClientRect().top + scrollY : -1; })(),
    pageH: document.documentElement.scrollHeight })`));
  check('both transfers received', r.cards === 2, `${r.cards} cards`);
  check('older transfer collapsed', r.compact === 1, `${r.compact} compact`);
  check('live monitor first: spectrum and speed on the first screen', r.liveFirst && r.specTop < 260 && r.speedTop < 420, `spectrum at ${Math.round(r.specTop)} px, speed at ${Math.round(r.speedTop)} px`);
  check('newest Download button within first screen', r.dlTop > 0 && r.dlTop < 844, `at ${Math.round(r.dlTop)} px`);
  console.log(`page height ${r.pageH} px`);
  // Full-screen image viewer: open from the preview, zoom, close with Escape.
  await B.evaluate(`document.querySelector('.xfer:not(.compact) .preview-img').click()`);
  await sleep(400);
  const lbOpen = await B.evaluate(`!document.getElementById('lightbox').hidden && document.getElementById('lbImg').naturalWidth > 0`);
  const lbShot = await B.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, 'phone-lightbox.png'), Buffer.from(lbShot.result.data, 'base64'));
  await B.evaluate(`document.getElementById('lbImg').click()`);
  await sleep(200);
  const zoomed = await B.evaluate(`document.getElementById('lightbox').classList.contains('zoomed')`);
  await B.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(400);
  const lbClosed = await B.evaluate(`document.getElementById('lightbox').hidden && location.hash === '#receive'`);
  check('tap image opens full-screen viewer, zooms, closes', lbOpen && zoomed && lbClosed, `open ${lbOpen}, zoom ${zoomed}, closed ${lbClosed}`);
  // Delete one item, then clear everything.
  await B.evaluate(`document.querySelector('.xfer.compact .xfer-del').click()`);
  await sleep(300);
  const afterDel = await B.evaluate(`document.querySelectorAll('.xfer').length + ' card, bar: ' + document.getElementById('xferCount').textContent`);
  check('delete removes one received item', afterDel.startsWith('1 card'), afterDel);
  await B.evaluate(`window.scrollTo(0, 0)`);
  const shot = await B.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 390, height: Math.min(r.pageH, 2400), scale: 1 } });
  writeFileSync(join(out, 'phone-receive-two.png'), Buffer.from(shot.result.data, 'base64'));
  await B.evaluate(`window.confirm = () => true; document.getElementById('clearAll').click()`);
  await sleep(300);
  const afterClear = await B.evaluate(`document.querySelectorAll('.xfer').length + ' cards, bar hidden: ' + document.getElementById('xferBar').hidden`);
  check('clear all empties the list', afterClear === '0 cards, bar hidden: true', afterClear);
  B.logs.forEach((l) => console.log(l));
  B.close();
} finally {
  server.kill();
}
console.log(pass ? 'LAYOUT PASS' : 'LAYOUT FAIL');
process.exit(pass ? 0 : 1);
