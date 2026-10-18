// Acoustic channel simulator + end-to-end transfer harness.
for (const f of ['util', 'fft', 'ldpc', 'params', 'qam', 'modem', 'resampler', 'fountain'])
  require(`../src/core/${f}.js`);
const SD = globalThis.SD;
const P = SD.params;

function gaussGen(seed) {
  const r = SD.util.rng(seed);
  let spare = null;
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0; while (u === 0) u = r() / 4294967296;
    const v = r() / 4294967296, m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
}

// Room impulse response: direct path, early reflections, exponential diffuse tail,
// shaped by a crude speaker/mic band-pass (applied in the frequency domain later).
function roomIR(fs, { rt60 = 0.35, drrDb = 3, seed = 7, reflections = 8, reflAmp = 1 } = {}) {
  const g = gaussGen(seed), r = SD.util.rng(seed + 1);
  const len = Math.min(Math.round(fs * rt60 * 1.2), fs);
  const h = new Float64Array(Math.max(len, 256));
  const d0 = 30;
  h[d0] = 1;
  for (let i = 0; i < reflections; i++) {
    const d = d0 + 40 + (r() % Math.round(fs * 0.015));
    h[d] += reflAmp * (((r() % 1000) / 1000) * 0.5 + 0.15) * (r() & 1 ? 1 : -1);
  }
  let tailE = 0;
  const tail = new Float64Array(h.length);
  const start = d0 + Math.round(fs * 0.004);
  for (let n = start; n < h.length; n++) {
    const t = (n - start) / fs;
    tail[n] = g() * Math.exp((-6.91 * t) / rt60);
    tailE += tail[n] * tail[n];
  }
  let directE = 0;
  for (let n = 0; n < h.length; n++) directE += h[n] * h[n];
  const want = directE / Math.pow(10, drrDb / 10);
  const sc = Math.sqrt(want / tailE);
  for (let n = 0; n < h.length; n++) h[n] += tail[n] * sc;
  return h;
}

function bandShape(f, lo, hi) {
  // 2nd-order high-pass at lo, 2nd-order low-pass at hi (magnitude only, plus a mild tilt)
  const hp = Math.pow(f / lo, 2) / Math.sqrt(1 + Math.pow(f / lo, 4));
  const lp = 1 / Math.sqrt(1 + Math.pow(f / hi, 4));
  return hp * lp;
}

// Overlap-add convolution with IR, band shaping applied to the IR spectrum.
function convolve(x, h, fs, lo, hi) {
  const M = 1 << 16;
  const fft = SD.FFT.get(M);
  const Hr = new Float64Array(M), Hi = new Float64Array(M);
  for (let i = 0; i < h.length; i++) Hr[i] = h[i];
  fft.transform(Hr, Hi, false);
  for (let k = 0; k < M; k++) {
    const f = (Math.min(k, M - k) * fs) / M;
    const s = f === 0 ? 0 : bandShape(f, lo, hi);
    Hr[k] *= s; Hi[k] *= s;
  }
  const L = M - h.length;
  const y = new Float64Array(x.length + h.length);
  const re = new Float64Array(M), im = new Float64Array(M);
  for (let p = 0; p < x.length; p += L) {
    re.fill(0); im.fill(0);
    const n = Math.min(L, x.length - p);
    for (let i = 0; i < n; i++) re[i] = x[p + i];
    fft.transform(re, im, false);
    for (let k = 0; k < M; k++) {
      const a = re[k], b = im[k];
      re[k] = a * Hr[k] - b * Hi[k]; im[k] = a * Hi[k] + b * Hr[k];
    }
    fft.transform(re, im, true);
    for (let i = 0; i < M && p + i < y.length; i++) y[p + i] += re[i] / M;
  }
  return y;
}

// Build a transmission: leading silence + frames for a file.
function transmit(data, modeId, { frames, session = 0x1234, amp = 0.3, leadSec = 0.37, startId = 0 } = {}) {
  const mode = P.modes[modeId];
  const enc = new SD.FountainEncoder(data, mode.blockSize, session);
  const mod = new SD.Modulator({ amp });
  const parts = [new Float32Array(Math.round(leadSec * P.fs))];
  frames = frames || Math.ceil((enc.K * 1.25) / mode.cws) + 1;
  let id = startId;
  for (let f = 0; f < frames; f++) {
    const pls = [];
    for (let c = 0; c < mode.cws; c++) pls.push(enc.packet(id + c));
    parts.push(mod.frame({ mode: modeId, session, K: enc.K, baseId: id }, pls));
    id += mode.cws;
  }
  parts.push(new Float32Array(P.fs));
  let n = 0; for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return { audio: out, K: enc.K, session, mode };
}

// Full channel: room, noise, device clock offset and sample rate.
function channel(x, { snrDb = 25, rt60 = 0.35, drrDb = 3, reflections = 8, reflAmp = 1, ppm = 40, rxRate = 44100, lo = 700, hi = 11000, seed = 3, noiseGain = 1 } = {}) {
  let y = x;
  if (rt60 > 0) y = convolve(x, roomIR(P.fs, { rt60, drrDb, seed, reflections, reflAmp }), P.fs, lo, hi);
  // In-band signal power measured on the active part.
  let e = 0, cnt = 0;
  for (let i = 0; i < y.length; i++) if (Math.abs(x[i] || 0) > 1e-4) { e += y[i] * y[i]; cnt++; }
  const sp = e / Math.max(1, cnt);
  // Noise power for the requested SNR inside the used band (band fraction of Nyquist).
  const bandFrac = (P.U * P.fs / P.N) / (P.fs / 2);
  const np = (sp / Math.pow(10, snrDb / 10)) / bandFrac;
  const g = gaussGen(seed + 99), sd = Math.sqrt(np) * noiseGain;
  const z = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) z[i] = y[i] + sd * g();
  // Receiver clock: runs at rxRate*(1+ppm) relative to the sender's 48k.
  const rs = new SD.Resampler(P.fs, rxRate * (1 + ppm * 1e-6));
  return { audio: rs.process(z), rate: rxRate };
}

// Replica of a real room: the measured impulse responses from a recording, morphing from one to the
// next once per second (the way the channel changed while the phone was held), plus noise and clock offset.
function convolveRaw(x, h) {
  const M = 1 << 16, fft = SD.FFT.get(M);
  const Hr = new Float64Array(M), Hi = new Float64Array(M);
  for (let i = 0; i < h.length; i++) Hr[i] = h[i];
  fft.transform(Hr, Hi, false);
  const L = M - h.length, y = new Float64Array(x.length + h.length);
  const re = new Float64Array(M), im = new Float64Array(M);
  for (let p = 0; p < x.length; p += L) {
    re.fill(0); im.fill(0);
    const n = Math.min(L, x.length - p);
    for (let i = 0; i < n; i++) re[i] = x[p + i];
    fft.transform(re, im, false);
    for (let k = 0; k < M; k++) { const a = re[k], b = im[k]; re[k] = a * Hr[k] - b * Hi[k]; im[k] = a * Hi[k] + b * Hr[k]; }
    fft.transform(re, im, true);
    for (let i = 0; i < M && p + i < y.length; i++) y[p + i] += re[i] / M;
  }
  return y;
}
function roomChannel(x, room, { snrDb = 22, ppm = 15, rxRate = 48000, moving = true, seed = 5, tailMs = 16 } = {}) {
  const R = typeof room === 'string' ? require(`./rooms/${room}.json`) : room;
  // Extend each measured (cyclic, 42.7 ms) response with an exponential tail continuing its decay.
  const g = gaussGen(seed);
  const tailLen = Math.round(0.12 * P.fs), tau = (tailMs / 1000) * P.fs;
  const irs = R.irs.map((r) => {
    const h = new Float64Array(r.h.length + tailLen);
    h.set(r.h);
    let lvl = 0; for (let t = r.h.length - 480; t < r.h.length; t++) lvl += r.h[t] * r.h[t];
    lvl = Math.sqrt(lvl / 480);
    for (let t = 0; t < tailLen; t++) h[r.h.length + t] = lvl * Math.exp(-t / tau) * g();
    return h;
  });
  const sec = P.fs, nIr = moving ? irs.length : 1;
  let y = new Float64Array(x.length + irs[0].length);
  const need = Math.min(nIr, Math.ceil(x.length / sec) + 2);
  for (let k = 0; k < need; k++) {
    const yk = convolveRaw(x, irs[k % irs.length]);
    for (let t = 0; t < y.length; t++) {
      let w;
      if (!moving) w = 1;
      else { const pos = t / sec, d = Math.abs(pos - k); w = d < 1 ? 1 - d : 0; if (k === need - 1 && pos > k) w = 1; if (k === 0 && pos < 0) w = 1; }
      if (w) y[t] += w * (yk[t] || 0);
    }
  }
  let e = 0, cnt = 0;
  for (let i = 0; i < y.length; i++) if (Math.abs(x[i] || 0) > 1e-4) { e += y[i] * y[i]; cnt++; }
  const bandFrac = (P.U * P.fs / P.N) / (P.fs / 2);
  const sd = Math.sqrt((e / cnt / Math.pow(10, snrDb / 10)) / bandFrac);
  const gn = gaussGen(seed + 7), z = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) z[i] = y[i] + sd * gn();
  const rs = new SD.Resampler(P.fs, rxRate * (1 + ppm * 1e-6));
  return { audio: rs.process(z), rate: rxRate };
}

function receive(audio, rate, K, blockSize, session, { chunk = 4096, onFrame } = {}) {
  const rs = new SD.Resampler(rate, P.fs);
  const dm = new SD.Demodulator();
  let dec = null;
  const frames = [];
  let doneAt = null;
  for (let p = 0; p < audio.length; p += chunk) {
    const x = rs.process(audio.subarray(p, Math.min(audio.length, p + chunk)));
    dm.push(x);
    for (const ev of dm.process()) {
      if (ev.type !== 'frame') continue;
      frames.push(ev);
      if (onFrame) onFrame(ev);
      if (!dec) dec = new SD.FountainDecoder(ev.header.K, P.modes[ev.mode].blockSize, ev.header.session);
      for (const pk of ev.packets) if (pk.data) dec.add(pk.id, pk.data);
      if (dec.done && doneAt === null) doneAt = p / rate;
    }
  }
  return { frames, dec, doneAt, stats: dm.stats };
}

const SCENARIOS = {
  near: { snrDb: 30, rt60: 0.4, drrDb: 15, reflections: 6, reflAmp: 0.25, ppm: 40, rxRate: 44100 },
  mid: { snrDb: 24, rt60: 0.45, drrDb: 7, reflections: 6, reflAmp: 0.5, ppm: -60, rxRate: 48000 },
  far: { snrDb: 15, rt60: 0.5, drrDb: 1, reflections: 8, reflAmp: 0.7, ppm: 90, rxRate: 44100 },
  cable: { snrDb: 45, rt60: 0, ppm: 20, rxRate: 48000 },
};

module.exports = { roomChannel, SCENARIOS, SD, P, roomIR, convolve, transmit, channel, receive, gaussGen };
