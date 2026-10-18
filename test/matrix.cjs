// Success matrix: every mode x every scenario. Prints net goodput when the file decodes.
const { SD, P, SCENARIOS, transmit, channel, receive } = require('./sim-lib.cjs');
const bytes = +process.argv[2] || 8000;
const r = SD.util.rng(9); const data = new Uint8Array(bytes).map(() => r() & 255);
const names = Object.keys(SCENARIOS);
console.log('mode'.padEnd(22), names.map((n) => n.padEnd(26)).join(''));
for (const mode of P.modes) {
  const cells = [];
  for (const n of names) {
    const sc = SCENARIOS[n];
    const tx = transmit(data, mode.id, {});
    const ch = sc.rt60 === 0 && sc.snrDb > 40 ? channel(tx.audio, { ...sc, rt60: 0 }) : channel(tx.audio, sc);
    const rx = receive(ch.audio, ch.rate, tx.K, mode.blockSize, tx.session);
    const ok = rx.dec && rx.dec.done && rx.dec.data.subarray(0, bytes).every((v, i) => v === data[i]);
    const cw = rx.frames.reduce((a, f) => a + f.ok, 0), tot = rx.frames.reduce((a, f) => a + f.total, 0);
    const snr = rx.frames.length ? rx.frames.reduce((a, f) => a + f.snr, 0) / rx.frames.length : NaN;
    const t = ok ? rx.doneAt - 0.37 : null;
    cells.push((ok ? `OK ${(bytes * 8 / t / 1000).toFixed(1)}kbps` : 'fail').padEnd(13) + `${cw}/${tot} ${snr.toFixed(0)}dB`.padEnd(13));
  }
  console.log(`${mode.id} ${mode.name} ${mode.mod} ${mode.rate}`.padEnd(22), cells.join(''));
}
