// End-to-end scenarios. Usage: node test/sim.cjs [modeId|all] [snr] [rt60] [ppm] [rxRate] [bytes]
const { SD, P, transmit, channel, receive } = require('./sim-lib.cjs');

function run(modeId, opts) {
  const bytes = opts.bytes || 6000;
  const r = SD.util.rng(42 + modeId);
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) data[i] = r() & 255;
  const t0 = Date.now();
  const tx = transmit(data, modeId, { frames: opts.frames });
  const ch = opts.clean ? { audio: tx.audio, rate: 48000 } : channel(tx.audio, opts);
  const t1 = Date.now();
  const rx = receive(ch.audio, ch.rate, tx.K, tx.mode.blockSize, tx.session);
  const t2 = Date.now();
  let match = false;
  if (rx.dec && rx.dec.done) {
    match = true;
    for (let i = 0; i < bytes; i++) if (rx.dec.data[i] !== data[i]) { match = false; break; }
  }
  const fr = rx.frames;
  const okCw = fr.reduce((a, f) => a + f.ok, 0), totCw = fr.reduce((a, f) => a + f.total, 0);
  const avg = (k) => (fr.length ? fr.reduce((a, f) => a + (f[k] || 0), 0) / fr.length : NaN);
  const txFrames = Math.ceil((tx.K * 1.25) / tx.mode.cws) + 1;
  console.log(
    `${tx.mode.name.padEnd(12)} K=${String(tx.K).padStart(3)} frames ${fr.length}/${opts.frames || txFrames} ` +
    `syncs=${rx.stats.syncs} hdrFail=${rx.stats.headerFail} cw ${okCw}/${totCw} ` +
    `evmSNR=${avg('snr').toFixed(1)}dB train=${avg('trainSnr').toFixed(1)}dB ppm=${avg('ppm').toFixed(1)} ` +
    `rawBER=${(avg('rawBer') * 100).toFixed(2)}% it=${avg('iters').toFixed(1)} ` +
    `${match ? 'FILE OK' : 'FAIL'}${rx.doneAt ? ' @' + rx.doneAt.toFixed(1) + 's' : ''} (rx ${t2 - t1}ms for ${(ch.audio.length / ch.rate).toFixed(1)}s)`
  );
  return match;
}

const a = process.argv.slice(2);
const modes = !a[0] || a[0] === 'all' ? P.modes.map((m) => m.id) : [+a[0]];
const opts = {
  snrDb: a[1] !== undefined ? +a[1] : 25,
  rt60: a[2] !== undefined ? +a[2] : 0.35,
  ppm: a[3] !== undefined ? +a[3] : 40,
  rxRate: a[4] !== undefined ? +a[4] : 44100,
  bytes: a[5] !== undefined ? +a[5] : 6000,
  clean: a[1] === 'clean',
};
console.log('opts', JSON.stringify(opts));
for (const m of modes) run(m, opts);
