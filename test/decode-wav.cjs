// Decode a recorded WAV offline with full diagnostics.
// Usage: node test/decode-wav.cjs recording.wav [passphrase]
require('./sim-lib.cjs');
require('../src/core/container.js');
const SD = globalThis.SD, P = SD.params;
const fs = require('fs');

function readWav(path) {
  const b = fs.readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12, fmt = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), len = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(o + 8), ch: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') {
      const n = Math.floor(len / (fmt.bits / 8) / fmt.ch), x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const p = o + 8 + i * fmt.ch * (fmt.bits / 8);
        x[i] = fmt.bits === 16 ? b.readInt16LE(p) / 32768 : fmt.bits === 32 && fmt.format === 3 ? b.readFloatLE(p) : fmt.bits === 24 ? (b.readIntLE(p, 3) / 8388608) : 0;
      }
      return { x, rate: fmt.rate };
    }
    o += 8 + len + (len & 1);
  }
  throw new Error('no data chunk');
}

(async () => {
  const { x, rate } = readWav(process.argv[2]);
  let peak = 0, e = 0; for (const v of x) { peak = Math.max(peak, Math.abs(v)); e += v * v; }
  console.log(`${process.argv[2]}: ${(x.length / rate).toFixed(1)} s @ ${rate} Hz, peak ${(20 * Math.log10(peak + 1e-9)).toFixed(1)} dBFS, rms ${(10 * Math.log10(e / x.length + 1e-12)).toFixed(1)} dBFS`);
  const rs = new SD.Resampler(rate, P.fs), dm = new SD.Demodulator();
  const sessions = new Map();
  for (let p = 0; p < x.length; p += 4096) {
    dm.push(rs.process(x.subarray(p, p + 4096)));
    for (const ev of dm.process()) {
      const t = (p / rate).toFixed(2);
      if (ev.type === 'sync-fail') console.log(`${t}s  sync at peak ${ev.peak.toFixed(3)} but header failed`);
      if (ev.type !== 'frame') continue;
      const h = ev.header, m = P.modes[ev.mode];
      console.log(`${t}s  frame ${m.name.padEnd(12)} session ${h.session} K=${h.K} id=${h.baseId} ${h.flags & 1 ? 'TEST ' : ''}cw ${ev.ok}/${ev.total} snr ${ev.snr.toFixed(1)} dB (train ${ev.trainSnr.toFixed(1)}) rawBER ${ev.rawBer === null ? '-' : (ev.rawBer * 100).toFixed(2) + '%'} ppm ${ev.ppm.toFixed(0)} peak ${ev.peak.toFixed(2)}`);
      console.log('        snr by band (dB):', Array.from(ev.snrBins).filter((_, i) => i % 4 === 0).map((v) => v.toFixed(0)).join(' '));
      if (!h.K || h.flags & 1) continue;
      let s = sessions.get(h.session);
      if (!s) { s = new SD.FountainDecoder(h.K, m.blockSize, h.session); sessions.set(h.session, s); }
      for (const pk of ev.packets) if (pk.data) s.add(pk.id, pk.data);
      console.log(`        progress ${s.rank}/${s.K}${s.done ? ' DONE' : ''}`);
    }
  }
  console.log('detector stats', dm.stats);
  for (const [id, s] of sessions) {
    if (!s.done) { console.log(`session ${id}: incomplete ${s.rank}/${s.K}`); continue; }
    try {
      const r = await SD.container.unpack(s.data, process.argv[3]);
      console.log(`session ${id}: verified=${r.verified} files:`, r.files.map((f) => `${f.name} (${f.data.length} B)`).join(', '));
    } catch (err) { console.log(`session ${id}: decoded but container error: ${err.message}`); }
  }
})();
