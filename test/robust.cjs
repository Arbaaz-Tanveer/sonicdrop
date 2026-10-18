// Robustness cases: late join, big clock offsets, 96 kHz capture, burst noise, large cable transfer.
const { SD, P, SCENARIOS, transmit, channel, receive, gaussGen } = require('./sim-lib.cjs');
function file(n, seed) { const r = SD.util.rng(seed); return new Uint8Array(n).map(() => r() & 255); }
function check(name, data, modeId, sc, mutate, txOpts) {
  const tx = transmit(data, modeId, txOpts || {});
  let ch = channel(tx.audio, sc);
  if (mutate) ch = mutate(ch) || ch;
  const t0 = Date.now();
  const rx = receive(ch.audio, ch.rate, tx.K, P.modes[modeId].blockSize, tx.session);
  const ok = rx.dec && rx.dec.done && rx.dec.data.subarray(0, data.length).every((v, i) => v === data[i]);
  const cw = rx.frames.reduce((a, f) => a + f.ok, 0), tot = rx.frames.reduce((a, f) => a + f.total, 0);
  const ppm = rx.frames.length ? rx.frames[rx.frames.length - 1].ppm.toFixed(0) : '-';
  console.log(name.padEnd(44), ok ? 'OK  ' : 'FAIL', `frames ${rx.frames.length} cw ${cw}/${tot} K=${tx.K} recv=${rx.dec ? rx.dec.received : 0} ppmEst=${ppm}`,
    ok ? `done@${rx.doneAt.toFixed(1)}s` : '', `cpu ${(Date.now() - t0)}ms/${(ch.audio.length / ch.rate).toFixed(0)}s`);
}
const d = file(10000, 1);
check('late join (skip first 45%)', d, 2, SCENARIOS.near, (ch) => ({ audio: ch.audio.subarray(Math.floor(ch.audio.length * 0.45)), rate: ch.rate }), { frames: 20 });
check('clock +250 ppm', d, 2, { ...SCENARIOS.near, ppm: 250 });
check('clock -250 ppm', d, 3, { ...SCENARIOS.near, ppm: -250 });
check('capture at 96 kHz', d, 3, { ...SCENARIOS.near, rxRate: 96000 });
check('capture at 32 kHz', d, 2, { ...SCENARIOS.near, rxRate: 32000 });
check('noise bursts (door slams)', d, 2, SCENARIOS.near, (ch) => {
  const g = gaussGen(5);
  for (let b = 0; b < 6; b++) { const s = Math.floor(ch.rate * (1.2 + b * 1.7)); for (let i = s; i < s + ch.rate * 0.25 && i < ch.audio.length; i++) ch.audio[i] += 0.3 * g(); }
});
check('quiet sender (-30 dB level)', d, 1, SCENARIOS.mid, (ch) => { for (let i = 0; i < ch.audio.length; i++) ch.audio[i] *= 0.03; });
const big = file(120000, 2);
check('cable 120 KB @ Quick mode', big, 3, SCENARIOS.cable);
