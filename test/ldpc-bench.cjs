// BLER of the LDPC codes over BPSK/AWGN. Usage: node test/ldpc-bench.cjs [n] [k] [trials]
require('../src/core/util.js');
require('../src/core/ldpc.js');
const SD = globalThis.SD;

function gauss(r) {
  let u = 0, v = 0;
  while (u === 0) u = r() / 4294967296;
  v = r() / 4294967296;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function bench(code, ebn0List, trials, label) {
  const r = SD.util.rng(1234);
  const { n, k } = code;
  const rate = k / n;
  const info = new Uint8Array(k);
  const llr = new Float32Array(n);
  const out = [];
  for (const ebn0 of ebn0List) {
    const esn0 = ebn0 + 10 * Math.log10(rate);
    const sigma = Math.sqrt(1 / (2 * Math.pow(10, esn0 / 10)));
    let fails = 0, iters = 0;
    for (let t = 0; t < trials; t++) {
      for (let i = 0; i < k; i++) info[i] = r() & 1;
      const cw = code.encode(info);
      for (let i = 0; i < n; i++) {
        const y = (cw[i] ? -1 : 1) + sigma * gauss(r);
        llr[i] = (2 * y) / (sigma * sigma);
      }
      const res = code.decode(llr, 40);
      iters += res.iters;
      let bad = !res.ok;
      for (let i = 0; i < k && !bad; i++) if (res.bits[i] !== info[i]) bad = true;
      if (bad) fails++;
    }
    out.push(`${ebn0.toFixed(1)}dB:${(fails / trials).toFixed(3)}(${(iters / trials).toFixed(1)}it)`);
  }
  console.log(label.padEnd(28), out.join('  '));
}

const trials = +process.argv[2] || 200;
const profiles = {
  'd3': [[1, 3]],
  'd3/8 80:20': [[0.8, 3], [0.2, 8]],
  'd3/6 85:15': [[0.85, 3], [0.15, 6]],
  'd3/10 85:15': [[0.85, 3], [0.15, 10]],
  'd4': [[1, 4]],
};
const sets = [
  [2304, 1152, [1.0, 1.5, 2.0, 2.5]],
  [2304, 1536, [2.0, 2.5, 3.0, 3.5]],
  [2304, 1728, [2.5, 3.0, 3.5, 4.0]],
  [2304, 1920, [3.5, 4.0, 4.5, 5.0]],
];
const t0 = Date.now();
for (const [n, k, ebs] of sets) {
  for (const [name, deg] of Object.entries(profiles)) {
    const code = new SD.LDPC(n, k, SD.util.hash32(n, k, 0x5D0C), deg);
    bench(code, ebs, trials, `n${n} k${k} ${name}`);
  }
}
for (const [name, deg] of Object.entries({ d5: [[1, 5]], d6: [[1, 6]], d8: [[1, 8]] })) {
  const code = new SD.LDPC(576, 144, SD.util.hash32(576, 144, 0x5D0C), deg);
  bench(code, [0.5, 1.0, 1.5, 2.0], trials, `hdr n576 k144 ${name}`);
}
console.log('time', Date.now() - t0, 'ms');
