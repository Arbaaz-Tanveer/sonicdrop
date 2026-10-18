require('./legacy-v1.cjs');  // use for v1 recordings; remove for recordings made with the current protocol
// Extract real channel impulse responses from a recording (training-symbol estimates) -> test/rooms/<name>.json
require('./sim-lib.cjs');
const SD = globalThis.SD, P = SD.params, fs = require('fs');
const [wavPath, name] = process.argv.slice(2);
const b = fs.readFileSync(wavPath);
const n = (b.length - 44) / 2, x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + i * 2) / 32768;
const dm = new SD.Demodulator();
const irs = [];
const oh = dm._decodeHeader.bind(dm);
dm._decodeHeader = function (pd) {
  const ok = oh(pd);
  if (ok && pd.ch) {
    const N = P.N, re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < P.U; i++) { const k = P.k0 + i; re[k] = pd.ch.Hr[i]; im[k] = pd.ch.Hi[i]; re[N - k] = pd.ch.Hr[i]; im[N - k] = -pd.ch.Hi[i]; }
    SD.FFT.get(N).transform(re, im, true);
    // Rotate so the window back-off sits at the start; normalise to unit energy.
    let e = 0; for (let t = 0; t < N; t++) e += re[t] * re[t];
    const h = Array.from(re, (v) => +(v / Math.sqrt(e)).toFixed(6));
    let nm = 0; for (let i = 0; i < P.U; i++) nm += pd.ch.noise[i];
    let sg = 0; for (let i = 0; i < P.U; i++) sg += pd.ch.Hr[i] ** 2 + pd.ch.Hi[i] ** 2;
    irs.push({ t: +(this.buf.end() / 48000).toFixed(2), trainSnr: +(10 * Math.log10(sg / nm)).toFixed(1), h });
  }
  return ok;
};
for (let p = 0; p < n; p += 4096) { dm.push(x.subarray(p, p + 4096)); dm.process(); }
fs.writeFileSync(`${__dirname}/rooms/${name}.json`, JSON.stringify({ source: wavPath, fs: 48000, irs }));
console.log(`saved ${irs.length} impulse responses to test/rooms/${name}.json`, irs.map((r) => `${r.t}s:${r.trainSnr}dB`).join(' '));
