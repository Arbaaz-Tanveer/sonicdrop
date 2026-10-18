// Goodput of candidate modulation/code-rate combinations across channels. Usage: CP=768 node test/ladder.cjs
const mk = (name, mod, bps, k, rate, symbols) => ({ key: name.toLowerCase(), name, mod, bps, k, rate, symbols });
globalThis.SD_PARAM_OVERRIDES = {
  CP: +(process.env.CP || 512),
  modes: [
    mk('B12', 'BPSK', 1, 1152, '1/2', 16), mk('Q12', 'QPSK', 2, 1152, '1/2', 16), mk('Q23', 'QPSK', 2, 1536, '2/3', 16),
    mk('Q34', 'QPSK', 2, 1728, '3/4', 16), mk('16Q12', '16-QAM', 4, 1152, '1/2', 24), mk('16Q23', '16-QAM', 4, 1536, '2/3', 24),
    mk('16Q34', '16-QAM', 4, 1728, '3/4', 24), mk('64Q12', '64-QAM', 6, 1152, '1/2', 32), mk('64Q23', '64-QAM', 6, 1536, '2/3', 32),
    mk('64Q56', '64-QAM', 6, 1920, '5/6', 32),
  ],
};
const { SD, P, SCENARIOS, transmit, channel, roomChannel, receive } = require('./sim-lib.cjs');
const bytes = 20000, r = SD.util.rng(3), data = new Uint8Array(bytes).map(() => r() & 255);
const chans = {
  'room1@22dB': (a) => roomChannel(a, 'room1', { snrDb: 22 }),
  'room1@30dB': (a) => roomChannel(a, 'room1', { snrDb: 30 }),
  'room1 static@30': (a) => roomChannel(a, 'room1', { snrDb: 30, moving: false }),
  near: (a) => channel(a, SCENARIOS.near),
  mid: (a) => channel(a, SCENARIOS.mid),
};
console.log(`CP ${P.CP}  goodput kbps (codeword success %)`);
console.log('mode'.padEnd(8), 'nominal'.padEnd(8), Object.keys(chans).map((c) => c.padEnd(18)).join(''));
for (const mode of P.modes) {
  const cells = [];
  for (const [name, fn] of Object.entries(chans)) {
    const tx = transmit(data, mode.id, { frames: Math.ceil((Math.ceil(bytes / mode.blockSize) * 1.8) / mode.cws) + 2 });
    const ch = fn(tx.audio);
    const rx = receive(ch.audio, ch.rate, tx.K, mode.blockSize, tx.session);
    const ok = rx.dec && rx.dec.done && rx.dec.data.subarray(0, bytes).every((v, i) => v === data[i]);
    const cw = rx.frames.reduce((a, f) => a + f.ok, 0), tot = rx.frames.reduce((a, f) => a + f.total, 0);
    cells.push(`${ok ? ((bytes * 8) / (rx.doneAt - 0.37) / 1000).toFixed(1) : '  - '} (${(100 * cw / Math.max(1, tot)).toFixed(0)}%)`.padEnd(18));
  }
  console.log(mode.name.padEnd(8), mode.kbps.toFixed(1).padEnd(8), cells.join(''));
}
