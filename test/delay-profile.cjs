require('./legacy-v1.cjs');  // use for v1 recordings; remove for recordings made with the current protocol
// Average power-delay profile of the real channel from the training estimates, in ms bins.
require('./sim-lib.cjs');
const SD = globalThis.SD, P = SD.params, fs = require('fs');
const b = fs.readFileSync(process.argv[2]);
const n = (b.length - 44) / 2, x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + i * 2) / 32768;
const dm = new SD.Demodulator();
const N = P.N, acc = new Float64Array(N), accB = [new Float64Array(N), new Float64Array(N)];
let frames = 0;
const oh = dm._decodeHeader.bind(dm);
dm._decodeHeader = function (pd) {
  const ok = oh(pd);
  if (!pd.ch) return ok;
  // Use only the sync-symbol estimate (not tracked) to see the raw channel. Split low/high band.
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < P.U; i++) { re[P.k0 + i] = pd.ch.Hr[i]; im[P.k0 + i] = pd.ch.Hi[i]; }
  SD.FFT.get(N).transform(re, im, true);
  let tot = 0; for (let t = 0; t < N; t++) tot += re[t] * re[t] + im[t] * im[t];
  for (let t = 0; t < N; t++) acc[t] += (re[t] * re[t] + im[t] * im[t]) / tot;
  frames++;
  return ok;
};
for (let p = 0; p < n; p += 4096) { dm.push(x.subarray(p, p + 4096)); dm.process(); }
let pk = 0; for (let t = 0; t < N; t++) if (acc[t] > acc[pk]) pk = t;
const tot = acc.reduce((a, v) => a + v, 0);
console.log(`frames ${frames}, main path at sample ${pk} (window starts ${P.delta} samples before first arrival)`);
const edges = [0, 1, 2, 4, 6, 8, 10.7, 13, 16, 21.3, 26, 32, 42.7];
let cum = 0;
for (let e = 0; e + 1 < edges.length; e++) {
  const a = Math.round(edges[e] * 48) + 0, z = Math.min(N, Math.round(edges[e + 1] * 48));
  let s = 0; for (let t = a; t < z; t++) s += acc[t];
  cum += s;
  console.log(`${String(edges[e]).padStart(5)}–${String(edges[e + 1]).padEnd(5)} ms  ${(100 * s / tot).toFixed(2).padStart(6)}%   energy after ${edges[e + 1]} ms: ${(100 * (1 - cum / tot)).toFixed(2)}%  -> SIR if CP ends here: ${(10 * Math.log10(cum / (tot - cum))).toFixed(1)} dB`);
}
