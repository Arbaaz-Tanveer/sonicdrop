// Every mode over the replica of a real recorded room. Usage: CP=768 node test/room-sim.cjs [room] [snrDb] [bytes] [static]
if (process.env.CP) globalThis.SD_PARAM_OVERRIDES = { CP: +process.env.CP };
const { SD, P, transmit, roomChannel, receive } = require('./sim-lib.cjs');
const [room = 'room1', snr = '22', bytes = '24000', still] = process.argv.slice(2);
const r = SD.util.rng(3); const data = new Uint8Array(+bytes).map(() => r() & 255);
console.log(`room ${room}, CP ${P.CP} (${(P.CP / 48).toFixed(1)} ms), noise SNR ${snr} dB, ${bytes} bytes, ${still ? 'static' : 'moving'}`);
for (const mode of P.modes) {
  const tx = transmit(data, mode.id, { frames: Math.ceil((Math.ceil(+bytes / mode.blockSize) * 1.6) / mode.cws) + 2 });
  const ch = roomChannel(tx.audio, room, { snrDb: +snr, moving: !still });
  const rx = receive(ch.audio, ch.rate, tx.K, mode.blockSize, tx.session);
  const ok = rx.dec && rx.dec.done && rx.dec.data.subarray(0, +bytes).every((v, i) => v === data[i]);
  const cw = rx.frames.reduce((a, f) => a + f.ok, 0), tot = rx.frames.reduce((a, f) => a + f.total, 0);
  const snrM = rx.frames.length ? rx.frames.reduce((a, f) => a + f.snr, 0) / rx.frames.length : NaN;
  const goodput = ok ? (+bytes * 8) / (rx.doneAt - 0.37) / 1000 : 0;
  console.log(`${mode.name.padEnd(13)} ${mode.mod.padEnd(7)} ${mode.rate}  nominal ${mode.kbps.toFixed(1).padStart(5)} kbps  cw ${String(cw).padStart(4)}/${String(tot).padEnd(4)} (${(100 * cw / Math.max(1, tot)).toFixed(0).padStart(3)}%)  snr ${snrM.toFixed(1)}  ${ok ? 'FILE OK  goodput ' + goodput.toFixed(1) + ' kbps' : 'incomplete'}`);
}
