// Real-world regression: decode a v1 recording and count codewords (higher = better receiver).
// Usage: node test/recording-regression.cjs ../sonicdrop-mic-*.wav
require('./legacy-v1.cjs');  // the reference recording was made with protocol v1
// Count decoded codewords on a real recording for different receiver tracking settings.
require('./sim-lib.cjs');
const SD = globalThis.SD, fs = require('fs');
const b = fs.readFileSync(process.argv[2]);
const n = (b.length - 44) / 2, x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + i * 2) / 32768;
const T = SD.modem.TRACK, base = { ...T };
function run(cfg) {
  Object.assign(T, base, cfg);
  const dm = new SD.Demodulator(); let ok = 0, tot = 0, fr = 0;
  for (let p = 0; p < n; p += 4096) { dm.push(x.subarray(p, p + 4096)); for (const ev of dm.process()) if (ev.type === 'frame') { ok += ev.ok; tot += ev.total; fr++; } }
  console.log(JSON.stringify(cfg).padEnd(60), `codewords ${ok}/${tot}  frames ${fr}`);
}
const variants = [ {} ];
for (const v of variants) run(v);
