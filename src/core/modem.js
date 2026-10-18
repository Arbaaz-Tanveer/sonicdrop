// OFDM acoustic modem: frame builder (TX) and streaming receiver (RX).
//
// Frame = [sync][train][header][payload x S]   each symbol = CP + N samples
//   sync   : known QPSK on all carriers; matched-filter detection + channel estimate #1
//   train  : second known QPSK symbol; channel estimate #2, noise + clock-drift estimate
//   header : BPSK, rate-1/4 LDPC: mode, session, block count, packet id
//   payload: QAM data + BPSK pilots every 12th carrier, LDPC codewords interleaved
//            across the whole frame.
(function (SD) {
  'use strict';
  const P = SD.params;
  const U = SD.util;
  const { N, CP, W, U: NU, k0, D } = P;
  const TWO_PI = 2 * Math.PI;
  const KC = k0 + (NU - 1) / 2;   // band-centre carrier (decouples phase and slope fits)
  // Receiver tracking gains (tuned on real recordings; exposed for experiments).
  const TRACK = { mu: 0.25, slopeP: 0.5, slopeI: 0.12, bandBeta: 0.25, bandSpan: 4, nuBands: 12 };
  // Pilot positions as fractional pilot index for every used carrier (for band tracking).
  const PILOT_POS = (function () {
    const pos = new Float64Array(NU), pil = P.pilotIdx;
    for (let i = 0; i < NU; i++) pos[i] = Math.min(pil.length - 1, i / P.pilotSpacing);
    return pos;
  })();

  // ---------- shared tables ----------
  function qpskPN(seed) {
    const re = new Float64Array(NU), im = new Float64Array(NU);
    const bits = U.pnBits(NU * 2, seed), s = Math.SQRT1_2;
    for (let i = 0; i < NU; i++) { re[i] = bits[2 * i] ? -s : s; im[i] = bits[2 * i + 1] ? -s : s; }
    return { re, im };
  }
  const SYNC = qpskPN(0x51C0);
  const TRAIN = qpskPN(0x7A11);
  const PILOTS = [];
  for (let j = 0; j < P.maxSymbols; j++) {
    const b = U.pnBits(P.pilotIdx.length, U.hash32(0x9110, j));
    PILOTS.push(Float64Array.from(b, (x) => (x ? -1 : 1)));
  }
  const HDR_PN = U.pnBits(P.hdrN, 0x4EAD);
  // Header bits are scattered over all carriers: weak bands (speaker roll-off) must not hit
  // a contiguous run of the code's parity chain.
  const HDR_PERM = P.legacy ? Uint32Array.from({ length: P.hdrN }, (_, i) => i) : U.permutation(P.hdrN, 0x4E1D);
  // Payload interleaver. Codewords are grouped into the smallest run of whole symbols that holds a
  // whole number of codewords (BPSK 4 sym, QPSK 2, 16-QAM 1, 64-QAM 2 sym = 3 cw, 256-QAM 1 sym = 2 cw).
  // Inside a slot bits are scattered over every carrier (frequency diversity); a fade or a burst
  // later in the frame only costs the codewords in the affected slots.
  function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }
  function slotPermutation(mode, B) {
    const n = P.ldpcN, perSym = D * mode.bps;
    const slotBits = (n / gcd(n, perSym)) * perSym;
    const inner = U.permutation(slotBits, U.hash32(0x1E7E, mode.id));
    const perm = new Uint32Array(B);
    for (let q = 0; q < B; q++) perm[q] = Math.floor(q / slotBits) * slotBits + inner[q % slotBits];
    return perm;
  }
  const modeTables = new Map();
  function modeTable(mode) {
    let t = modeTables.get(mode.id);
    if (!t) {
      const B = mode.symbols * D * mode.bps;
      t = {
        B,
        perm: P.legacy ? U.permutation(B, U.hash32(0x1E7E, mode.id)) : slotPermutation(mode, B),
        pn: U.pnBits(B, U.hash32(0xB17E, mode.id)),
        code: SD.getCode(P.ldpcN, mode.k),
        qam: SD.QAM.get(mode.bps),
      };
      modeTables.set(mode.id, t);
    }
    return t;
  }
  const hdrCode = () => SD.getCode(P.hdrN, P.hdrK);

  // Raised-cosine taper.
  const RAMP = new Float64Array(W);
  for (let t = 0; t < W; t++) RAMP[t] = 0.5 * (1 - Math.cos((Math.PI * (t + 0.5)) / W));
  const TD_SCALE = 1 / Math.sqrt(2 * NU);

  // Time-domain body (N samples, unit RMS) of a symbol given used-carrier values.
  function symbolBody(Xre, Xim) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < NU; i++) {
      const k = k0 + i;
      re[k] = Xre[i]; im[k] = Xim[i];
      re[N - k] = Xre[i]; im[N - k] = -Xim[i];
    }
    SD.FFT.get(N).transform(re, im, true);
    for (let n = 0; n < N; n++) re[n] *= TD_SCALE;
    return re;
  }

  // ---------- header ----------
  function packHeader(h) {
    const b = new Uint8Array(18);
    b[0] = (P.version << 4) | (h.mode & 15);
    b[1] = (h.session >>> 8) & 255; b[2] = h.session & 255;
    b[3] = (h.K >>> 16) & 255; b[4] = (h.K >>> 8) & 255; b[5] = h.K & 255;
    b[6] = (h.baseId >>> 24) & 255; b[7] = (h.baseId >>> 16) & 255; b[8] = (h.baseId >>> 8) & 255; b[9] = h.baseId & 255;
    b[10] = h.flags || 0;
    b[11] = h.testStep || 0; b[12] = h.testTotal || 0;
    const c = U.crc16(b, 16);
    b[16] = c >>> 8; b[17] = c & 255;
    return b;
  }
  function unpackHeader(b) {
    const c = U.crc16(b, 16);
    if (((b[16] << 8) | b[17]) !== c) return null;
    const ver = b[0] >>> 4, mode = b[0] & 15;
    if (ver !== P.version || mode >= P.modes.length) return null;
    return {
      mode,
      session: (b[1] << 8) | b[2],
      K: (b[3] << 16) | (b[4] << 8) | b[5],
      baseId: ((b[6] << 24) | (b[7] << 16) | (b[8] << 8) | b[9]) >>> 0,
      flags: b[10], testStep: b[11], testTotal: b[12],
    };
  }

  // Codeword info bits = payload || CRC32(session, id, payload).
  function packetCRC(session, id, payload) {
    const pre = new Uint8Array([session >>> 8, session & 255, id >>> 24, (id >>> 16) & 255, (id >>> 8) & 255, id & 255]);
    return U.crc32(payload, U.crc32(pre) ^ 0xFFFFFFFF);
  }

  // ---------- TX ----------
  class Modulator {
    constructor(opts) {
      opts = opts || {};
      this.amp = opts.amp || 0.3;
    }

    // Returns Float32Array of the whole frame at P.fs.
    // header: {mode, session, K, baseId, flags, testStep, testTotal}; payloads: Uint8Array[] (blockSize each)
    frame(header, payloads) {
      const mode = P.modes[header.mode];
      const tab = modeTable(mode);
      const nsym = P.preamble + mode.symbols;
      const out = new Float32Array(nsym * P.symLen + W + P.GAP);
      const Xre = new Float64Array(NU), Xim = new Float64Array(NU);

      this._emit(out, 0, symbolBody(SYNC.re, SYNC.im));
      this._emit(out, 1, symbolBody(TRAIN.re, TRAIN.im));

      // Header symbol (BPSK).
      const hb = U.bytesToBits(packHeader(header));
      const hcw = hdrCode().encode(hb);
      this._pilots(Xre, Xim, 2);
      for (let d = 0; d < D; d++) { const c = P.dataIdx[HDR_PERM[d]]; Xre[c] = hcw[d] ^ HDR_PN[d] ? -1 : 1; Xim[c] = 0; }
      this._emit(out, 2, symbolBody(Xre, Xim));

      // Payload.
      const n = P.ldpcN, kBytes = mode.k / 8;
      const bits = new Uint8Array(tab.B);
      const info = new Uint8Array(mode.k);
      for (let c = 0; c < mode.cws; c++) {
        const id = (header.baseId + c) >>> 0;
        const pl = payloads[c];
        const bytes = new Uint8Array(kBytes);
        bytes.set(pl.subarray(0, mode.blockSize));
        const crc = packetCRC(header.session, id, bytes.subarray(0, mode.blockSize));
        bytes[kBytes - 4] = crc >>> 24; bytes[kBytes - 3] = (crc >>> 16) & 255; bytes[kBytes - 2] = (crc >>> 8) & 255; bytes[kBytes - 1] = crc & 255;
        U.bytesToBits(bytes, info);
        const cw = tab.code.encode(info);
        const base = c * n;
        for (let i = 0; i < n; i++) { const p = tab.perm[base + i]; bits[p] = cw[i] ^ tab.pn[p]; }
      }
      const pt = [0, 0], bps = mode.bps;
      for (let s = 0; s < mode.symbols; s++) {
        const j = P.preamble + s;
        this._pilots(Xre, Xim, j);
        for (let d = 0; d < D; d++) {
          tab.qam.map(bits, (s * D + d) * bps, pt);
          Xre[P.dataIdx[d]] = pt[0]; Xim[P.dataIdx[d]] = pt[1];
        }
        this._emit(out, j, symbolBody(Xre, Xim));
      }

      // Gain + clip (OFDM peaks are rare; hard limit just above).
      const a = this.amp;
      for (let i = 0; i < out.length; i++) {
        let v = out[i] * a;
        out[i] = v > 0.99 ? 0.99 : v < -0.99 ? -0.99 : v;
      }
      return out;
    }

    _pilots(Xre, Xim, j) {
      const pv = PILOTS[j];
      for (let p = 0; p < P.pilotIdx.length; p++) { Xre[P.pilotIdx[p]] = pv[p]; Xim[P.pilotIdx[p]] = 0; }
    }

    // Overlap-add symbol j (CP + body + postfix, tapered) into the frame.
    _emit(out, j, body) {
      const off = j * P.symLen, L = CP + N + W;
      for (let t = 0; t < L; t++) {
        let v;
        if (t < CP) v = body[N - CP + t];
        else if (t < CP + N) v = body[t - CP];
        else v = body[t - CP - N];
        if (t < W) v *= RAMP[t];
        else if (t >= CP + N) v *= RAMP[W - 1 - (t - CP - N)];
        out[off + t] += v;
      }
    }
  }

  // ---------- RX ----------
  const CORR_N = 2 * N;          // correlation FFT size
  const RHO_RING = 1 << 17;
  const DETECT_THR = 0.035;
  const DETECT_WIN = N + CP;     // look-ahead for the strongest path (CP-only partial matches peak one symbol early)

  // Detection template: sync symbol body.
  const TEMPLATE = (function () {
    const body = symbolBody(SYNC.re, SYNC.im);
    const re = new Float64Array(CORR_N), im = new Float64Array(CORR_N);
    let e = 0;
    for (let i = 0; i < N; i++) { re[i] = body[i]; e += body[i] * body[i]; }
    SD.FFT.get(CORR_N).transform(re, im, false);
    return { re, im, energy: e };
  })();

  class SampleBuffer {
    constructor(cap) { this.data = new Float32Array(cap); this.start = 0; this.len = 0; }
    end() { return this.start + this.len; }
    push(x, keepFrom) {
      if (this.len + x.length > this.data.length) {
        let drop = Math.max(0, Math.min(keepFrom - this.start, this.len));
        if (this.len - drop + x.length > this.data.length) drop = this.len + x.length - this.data.length;
        this.data.copyWithin(0, drop, this.len);
        this.start += drop; this.len -= drop;
      }
      this.data.set(x, this.len);
      this.len += x.length;
    }
    at(abs) { return this.data[abs - this.start]; }
    has(abs, n) { return abs >= this.start && abs + n <= this.end(); }
  }

  class Demodulator {
    constructor() {
      this.buf = new SampleBuffer(P.fs * 8);
      this.rho = new Float32Array(RHO_RING);
      this.corrPos = 0;       // next correlation lag to compute
      this.corrValid = 0;     // first lag with valid rho in ring
      this.scanPos = 0;       // next lag to scan for detections
      this.cand = null;
      this.pending = null;
      this.level = 0;
      this._cre = new Float64Array(CORR_N); this._cim = new Float64Array(CORR_N);
      this._fre = new Float64Array(N); this._fim = new Float64Array(N);
      this.stats = { syncs: 0, headerFail: 0, frames: 0 };
      this.sfoAvg = 0; this.sfoN = 0;   // long-term clock drift (rad/carrier/symbol)
    }

    push(samples) {
      let keep = Math.min(this.corrPos, this.scanPos);
      if (this.pending) keep = Math.min(keep, this.pending.T - N);
      this.buf.push(samples, keep - 64);
      let e = 0;
      for (let i = 0; i < samples.length; i++) e += samples[i] * samples[i];
      this.level = Math.sqrt(e / Math.max(1, samples.length));
    }

    // Run as far as buffered audio allows. Returns events.
    process() {
      const ev = [];
      for (let guard = 0; guard < 10000; guard++) {
        if (this.pending) {
          if (this.buf.end() < this.pending.needEnd) break;
          this._handlePending(ev);
          continue;
        }
        if (this.scanPos < this.corrPos) {
          this._scan();
          if (this.pending) continue;
          if (this.scanPos < this.corrPos && !this.cand) continue;
        }
        if (this.corrPos + CORR_N <= this.buf.end()) { this._corrBlock(); continue; }
        break;
      }
      return ev;
    }

    _corrBlock() {
      if (this.corrPos < this.scanPos - N) { this.corrPos = this.scanPos - N; this.corrValid = this.corrPos; }
      if (this.corrPos < this.buf.start) { this.corrPos = this.buf.start; this.corrValid = this.corrPos; }
      if (this.corrPos + CORR_N > this.buf.end()) return;
      const re = this._cre, im = this._cim, d0 = this.corrPos;
      const base = d0 - this.buf.start, data = this.buf.data;
      for (let i = 0; i < CORR_N; i++) { re[i] = data[base + i]; im[i] = 0; }
      const fft = SD.FFT.get(CORR_N);
      fft.transform(re, im, false);
      const T = TEMPLATE;
      for (let i = 0; i < CORR_N; i++) {
        const a = re[i], b = im[i];
        re[i] = a * T.re[i] + b * T.im[i];      // R * conj(T)
        im[i] = b * T.re[i] - a * T.im[i];
      }
      fft.transform(re, im, true);
      // Sliding energy via running sum.
      let e = 0;
      for (let m = 0; m < N; m++) e += data[base + m] * data[base + m];
      const L = CORR_N - N;
      for (let d = 0; d < L; d++) {
        const c = re[d] / CORR_N;
        this.rho[(d0 + d) & (RHO_RING - 1)] = (c * c) / (e * T.energy + 1e-12);
        const a = data[base + d], b = data[base + d + N];
        e += b * b - a * a;
        if (e < 0) e = 0;
      }
      this.corrPos = d0 + L;
    }

    _scan() {
      const end = this.corrPos;
      let d = Math.max(this.scanPos, this.corrValid);
      const rho = this.rho, M = RHO_RING - 1;
      for (; d < end; d++) {
        const r = rho[d & M];
        if (!this.cand) {
          if (r > DETECT_THR) this.cand = { first: d, maxD: d, maxRho: r };
          continue;
        }
        const c = this.cand;
        if (r > c.maxRho) { c.maxRho = r; c.maxD = d; }
        if (d - c.first >= DETECT_WIN) {
          // First significant arrival before the strongest path.
          let T = c.maxD;
          const lo = Math.max(c.maxD - (CP >> 1), this.corrValid);
          for (let x = lo; x < c.maxD; x++) if (rho[x & M] >= 0.25 * c.maxRho) { T = x; break; }
          this.cand = null;
          this.scanPos = d + 1;
          this.stats.syncs++;
          this.pending = { stage: 'hdr', T, peak: c.maxRho, retry: c.maxD + (CP >> 1), needEnd: T - P.delta + 2 * P.symLen + N + 8 };
          return;
        }
      }
      this.scanPos = d;
    }

    _fft(abs) {
      const re = this._fre, im = this._fim, data = this.buf.data, base = abs - this.buf.start;
      for (let i = 0; i < N; i++) { re[i] = data[base + i]; im[i] = 0; }
      SD.FFT.get(N).transform(re, im, false);
      const yr = new Float64Array(NU), yi = new Float64Array(NU);
      for (let i = 0; i < NU; i++) { yr[i] = re[k0 + i]; yi[i] = im[k0 + i]; }
      return { yr, yi };
    }

    _handlePending(ev) {
      const pd = this.pending;
      if (pd.stage === 'hdr') {
        const ok = this._decodeHeader(pd);
        if (!ok) {
          this.stats.headerFail++;
          ev.push({ type: 'sync-fail', peak: pd.peak });
          this.scanPos = Math.max(this.scanPos, pd.retry);
          this.pending = null;
          return;
        }
        const mode = P.modes[pd.header.mode];
        pd.mode = mode;
        pd.stage = 'payload';
        pd.needEnd = pd.T - P.delta + (P.preamble + mode.symbols - 1) * P.symLen + N + 8 + 32;
        ev.push({ type: 'header', header: pd.header, peak: pd.peak });
        return;
      }
      const res = this._decodePayload(pd);
      this.stats.frames++;
      ev.push(res);
      const frameStart = pd.T - CP;
      this.scanPos = Math.max(this.scanPos, frameStart + (P.preamble + pd.mode.symbols) * P.symLen - 256);
      this.pending = null;
    }

    // Channel estimation from sync+train, then header decode.
    _decodeHeader(pd) {
      const w0 = pd.T - P.delta;
      if (!this.buf.has(w0, 2 * P.symLen + N)) return false;
      const Y0 = this._fft(w0), Y1 = this._fft(w0 + P.symLen);
      const Hr = new Float64Array(NU), Hi = new Float64Array(NU);
      const H0r = new Float64Array(NU), H0i = new Float64Array(NU);
      for (let i = 0; i < NU; i++) {
        // H = Y * conj(X)  (|X| = 1)
        H0r[i] = Y0.yr[i] * SYNC.re[i] + Y0.yi[i] * SYNC.im[i];
        H0i[i] = Y0.yi[i] * SYNC.re[i] - Y0.yr[i] * SYNC.im[i];
        Hr[i] = Y1.yr[i] * TRAIN.re[i] + Y1.yi[i] * TRAIN.im[i];
        Hi[i] = Y1.yi[i] * TRAIN.re[i] - Y1.yr[i] * TRAIN.im[i];
      }
      // Phase drift between the two estimates: q = H1 * conj(H0) ~ e^{j(a + s (k - KC))}
      const qr = new Float64Array(NU), qi = new Float64Array(NU);
      for (let i = 0; i < NU; i++) {
        qr[i] = Hr[i] * H0r[i] + Hi[i] * H0i[i];
        qi[i] = Hi[i] * H0r[i] - Hr[i] * H0i[i];
      }
      const { a, s } = fitPhase(qr, qi, null, 1, 64);
      const noise = new Float64Array(NU);
      let sig = 0;
      for (let i = 0; i < NU; i++) {
        const ph = a + s * (k0 + i - KC), c = Math.cos(ph), sn = Math.sin(ph);
        const ar = H0r[i] * c - H0i[i] * sn, ai = H0r[i] * sn + H0i[i] * c;
        const dr = ar - Hr[i], di = ai - Hi[i];
        noise[i] = (dr * dr + di * di) / 2;
        Hr[i] = (ar + Hr[i]) / 2; Hi[i] = (ai + Hi[i]) / 2;
        sig += Hr[i] * Hr[i] + Hi[i] * Hi[i];
      }
      // Smooth noise over frequency; floor to avoid over-confident LLRs.
      const sm = smooth(noise, 24);
      let nmean = 0;
      for (let i = 0; i < NU; i++) nmean += sm[i];
      nmean /= NU;
      const floor = (sig / NU) * 1e-4;
      for (let i = 0; i < NU; i++) sm[i] = Math.max(sm[i], floor, nmean * 0.05);
      // Clock drift per symbol: trust the long-term estimate from earlier frames when available.
      const s0 = this.sfoN > 0 ? this.sfoAvg : s;
      pd.ch = { Hr, Hi, noise: sm, sPred: s0, nu: 1, tau: 0, shift: 0, sfo: s0 };
      pd.trainSnr = 10 * Math.log10(sig / NU / nmean);

      // Header symbol.
      const raw = new Float32Array(D), llr = new Float32Array(D);
      const z = this._symbol(pd, 2, SD.QAM.get(1), raw, null);
      if (!z) return false;
      for (let d = 0; d < D; d++) llr[d] = HDR_PN[d] ? -raw[HDR_PERM[d]] : raw[HDR_PERM[d]];
      const r = hdrCode().decode(llr, 40);
      if (!r.ok) return false;
      const hdr = unpackHeader(U.bitsToBytes(r.bits, 18));
      if (!hdr) return false;
      pd.header = hdr;
      return true;
    }

    // Demodulate OFDM symbol j: track phase/timing with pilots, equalize, soft-demap.
    // Writes D*bps LLRs to llr[off..]. Optionally collects constellation points.
    _symbol(pd, j, qam, llr, cons, off) {
      off = off || 0;
      const ch = pd.ch;
      const w = pd.T - P.delta + j * P.symLen + ch.shift;
      if (!this.buf.has(w, N)) return null;
      const { yr, yi } = this._fft(w);
      const Hr = ch.Hr, Hi = ch.Hi;
      // Predicted drift since last symbol (pure delay => phase linear in absolute k).
      rotate(Hr, Hi, ch.sPred * KC, ch.sPred);
      // Pilot residual: r = Y * conj(H X)
      const pil = P.pilotIdx, pv = PILOTS[j], np = pil.length;
      const rr = new Float64Array(np), ri = new Float64Array(np);
      for (let p = 0; p < np; p++) {
        const i = pil[p], x = pv[p];
        rr[p] = (yr[i] * Hr[i] + yi[i] * Hi[i]) * x;
        ri[p] = (yi[i] * Hr[i] - yr[i] * Hi[i]) * x;
      }
      // Common phase applied fully; slope through a PI loop (slope estimates are noisy).
      const fit = fitPhase(rr, ri, pil, P.pilotSpacing, 8);
      const sres = fit.s, sApplied = TRACK.slopeP * sres;
      rotate(Hr, Hi, fit.a, sApplied);
      // Real gain correction.
      let gn = 0, gd = 0;
      for (let p = 0; p < np; p++) {
        const i = pil[p], x = pv[p];
        gn += (yr[i] * Hr[i] + yi[i] * Hi[i]) * x;
        gd += Hr[i] * Hr[i] + Hi[i] * Hi[i];
      }
      const g = gn / (gd + 1e-30);
      if (g > 0.3 && g < 3) for (let i = 0; i < NU; i++) { Hr[i] *= g; Hi[i] *= g; }
      // Per-band tracking: pilots measure how H changed in each part of the band (movement
      // changes echoes differently at each frequency); smooth over neighbouring pilots, interpolate.
      if (TRACK.bandBeta > 0) {
        const qr = new Float64Array(np), qi = new Float64Array(np), w = new Float64Array(np);
        for (let p = 0; p < np; p++) {
          const i = pil[p], x = pv[p];
          qr[p] = (yr[i] * Hr[i] + yi[i] * Hi[i]) * x;     // Y X conj(H)
          qi[p] = (yi[i] * Hr[i] - yr[i] * Hi[i]) * x;
          w[p] = Hr[i] * Hr[i] + Hi[i] * Hi[i];
        }
        const sr = new Float64Array(np), si = new Float64Array(np), span = TRACK.bandSpan;
        for (let p = 0; p < np; p++) {
          let ar = 0, ai = 0, aw = 0;
          for (let q = Math.max(0, p - span); q <= Math.min(np - 1, p + span); q++) { ar += qr[q]; ai += qi[q]; aw += w[q]; }
          sr[p] = ar / (aw + 1e-30) - 1; si[p] = ai / (aw + 1e-30);   // ratio - 1
        }
        const beta = TRACK.bandBeta;
        for (let i = 0; i < NU; i++) {
          const f = PILOT_POS[i], a = Math.floor(f), b = Math.min(np - 1, a + 1), t = f - a;
          const dr = beta * (sr[a] * (1 - t) + sr[b] * t), di = beta * (si[a] * (1 - t) + si[b] * t);
          const hr = Hr[i], hi = Hi[i];
          Hr[i] = hr * (1 + dr) - hi * di; Hi[i] = hr * di + hi * (1 + dr);
        }
      }
      // Pilot noise relative to the training estimate, per frequency band (fades are band-specific).
      const NB = TRACK.nuBands;
      if (!ch.nuB) ch.nuB = new Float64Array(NB).fill(1);
      const bs = new Float64Array(NB), bc = new Float64Array(NB);
      let nu = 0;
      for (let p = 0; p < np; p++) {
        const i = pil[p], x = pv[p];
        const er = yr[i] - Hr[i] * x, ei = yi[i] - Hi[i] * x;
        const r = (er * er + ei * ei) / ch.noise[i];
        nu += r;
        const b = Math.min(NB - 1, Math.floor((p * NB) / np));
        bs[b] += r; bc[b]++;
      }
      nu /= np;
      ch.nu = 0.6 * ch.nu + 0.4 * Math.max(0.5, Math.min(nu, 50));
      for (let b = 0; b < NB; b++) {
        const v = bc[b] ? bs[b] / bc[b] : nu;
        ch.nuB[b] = 0.6 * ch.nuB[b] + 0.4 * Math.max(0.5, Math.min(v, 50));
      }
      // Drift tracking: accumulate timing drift (samples) and smooth the per-symbol slope.
      ch.tau += (-(ch.sPred + sApplied) * N) / TWO_PI;
      ch.sPred += TRACK.slopeI * sres;

      // Equalize, demap, decision-directed channel update.
      const bps = qam.bps, mu = TRACK.mu;
      const dec = [0, 0];
      const gate = qam.bps === 1 ? 0.5 : qam.scale * 0.5;
      let evm = 0, evmN = 0;
      for (let d = 0; d < D; d++) {
        const i = P.dataIdx[d];
        const hr = Hr[i], hi = Hi[i];
        const h2 = hr * hr + hi * hi + 1e-30;
        const zr = (yr[i] * hr + yi[i] * hi) / h2;
        const zi = (yi[i] * hr - yr[i] * hi) / h2;
        const nv = (ch.noise[i] * (NB > 1 ? ch.nuB[Math.min(NB - 1, Math.floor((PILOT_POS[i] * NB) / np))] : ch.nu)) / h2;
        qam.demap(zr, zi, nv, llr, off + d * bps);
        qam.decide(zr, zi, dec);
        const er = zr - dec[0], ei = zi - dec[1];
        evm += (er * er + ei * ei) * h2; evmN += h2;   // error power in the received domain
        if (cons && (d & 3) === (j & 3)) cons.push(zr, zi);
        if (Math.abs(er) < gate && Math.abs(ei) < gate) {
          // target H = Y / x
          const x2 = dec[0] * dec[0] + dec[1] * dec[1];
          const tr = (yr[i] * dec[0] + yi[i] * dec[1]) / x2;
          const ti = (yi[i] * dec[0] - yr[i] * dec[1]) / x2;
          Hr[i] += mu * (tr - hr); Hi[i] += mu * (ti - hi);
        }
      }
      for (let p = 0; p < np; p++) {
        const i = pil[p], x = pv[p];
        Hr[i] += mu * (yr[i] * x - Hr[i]); Hi[i] += mu * (yi[i] * x - Hi[i]);
      }
      // Move the FFT window when the clock drift has accumulated a few samples.
      if (Math.abs(ch.tau) >= 6) {
        const sh = Math.round(ch.tau);
        ch.shift += sh; ch.tau -= sh;
        rotate(Hr, Hi, (TWO_PI * sh * KC) / N, (TWO_PI * sh) / N);
      }
      ch.sfo = ch.sPred;
      pd.evm = (pd.evm || 0) + evm; pd.evmN = (pd.evmN || 0) + evmN;
      return true;
    }

    _decodePayload(pd) {
      const mode = pd.mode, tab = modeTable(mode), h = pd.header;
      const llr = new Float32Array(tab.B);
      const cons = [];
      let okSyms = true;
      pd.evm = 0; pd.evmN = 0;
      for (let s = 0; s < mode.symbols; s++) {
        const r = this._symbol(pd, P.preamble + s, tab.qam, llr, s % 2 === 0 && cons.length < 4000 ? cons : null, s * D * mode.bps);
        if (!r) { okSyms = false; break; }
      }
      const n = P.ldpcN, kBytes = mode.k / 8;
      const cwl = new Float32Array(n);
      const packets = [];
      let rawErr = 0, rawBits = 0, okCount = 0, iters = 0;
      for (let c = 0; c < mode.cws; c++) {
        const id = (h.baseId + c) >>> 0;
        const base = c * n;
        for (let i = 0; i < n; i++) { const p = tab.perm[base + i]; cwl[i] = tab.pn[p] ? -llr[p] : llr[p]; }
        const r = okSyms ? tab.code.decode(cwl, 40) : { ok: false, bits: null, iters: 0 };
        iters += r.iters;
        let data = null;
        if (r.ok) {
          const bytes = U.bitsToBytes(r.bits, kBytes);
          const pl = bytes.subarray(0, mode.blockSize);
          const crc = ((bytes[kBytes - 4] << 24) | (bytes[kBytes - 3] << 16) | (bytes[kBytes - 2] << 8) | bytes[kBytes - 1]) >>> 0;
          if (crc === packetCRC(h.session, id, pl)) {
            data = pl.slice();
            okCount++;
            for (let i = 0; i < n; i++) { rawBits++; if ((cwl[i] < 0 ? 1 : 0) !== r.bits[i]) rawErr++; }
          }
        }
        packets.push({ id, data });
      }
      // Diagnostics.
      const ch = pd.ch;
      const snrBins = new Float32Array(64);
      for (let b = 0; b < 64; b++) {
        let s = 0, nn = 0;
        const i0 = Math.floor((b * NU) / 64), i1 = Math.floor(((b + 1) * NU) / 64);
        for (let i = i0; i < i1; i++) { s += ch.Hr[i] * ch.Hr[i] + ch.Hi[i] * ch.Hi[i]; nn += ch.noise[i] * ch.nu; }
        snrBins[b] = 10 * Math.log10(s / nn + 1e-12);
      }
      if (okCount > 0) {
        this.sfoAvg = this.sfoN ? 0.7 * this.sfoAvg + 0.3 * ch.sPred : ch.sPred;
        this.sfoN++;
      }
      const evmDb = pd.evmN ? 10 * Math.log10(pd.evm / pd.evmN + 1e-12) : 0;
      const driftPerSym = (-ch.sfo * N) / TWO_PI;
      return {
        type: 'frame', header: h, mode: mode.id, packets,
        ok: okCount, total: mode.cws,
        snr: -evmDb, trainSnr: pd.trainSnr, snrBins,
        rawBer: rawBits ? rawErr / rawBits : null,
        ppm: (driftPerSym / P.symLen) * 1e6,
        iters: iters / mode.cws,
        constellation: Float32Array.from(cons),
        peak: pd.peak,
      };
    }
  }

  // Multiply H by e^{j(a + s (k - KC))} for all used carriers.
  function rotate(Hr, Hi, a, s) {
    if (a === 0 && s === 0) return;
    for (let i = 0; i < NU; i++) {
      const ph = a + s * (k0 + i - KC), c = Math.cos(ph), sn = Math.sin(ph);
      const r = Hr[i] * c - Hi[i] * sn, im = Hr[i] * sn + Hi[i] * c;
      Hr[i] = r; Hi[i] = im;
    }
  }

  // Fit phase(k) = a + s (k - KC) to complex samples z (weights = |z|).
  // idx: local carrier index per sample (null => 0..n-1), spacing: carriers between samples,
  // lag: sample lag for the slope estimate (long lags => much less noise).
  function fitPhase(zr, zi, idx, spacing, lag) {
    const n = zr.length;
    let sr = 0, si = 0;
    for (let i = 0; i + lag < n; i++) {
      sr += zr[i + lag] * zr[i] + zi[i + lag] * zi[i];
      si += zi[i + lag] * zr[i] - zr[i + lag] * zi[i];
    }
    const s = Math.atan2(si, sr) / (lag * spacing);
    let cr = 0, ci = 0;
    for (let i = 0; i < n; i++) {
      const k = k0 + (idx ? idx[i] : i);
      const ph = -s * (k - KC), c = Math.cos(ph), sn = Math.sin(ph);
      cr += zr[i] * c - zi[i] * sn; ci += zr[i] * sn + zi[i] * c;
    }
    return { a: Math.atan2(ci, cr), s };
  }

  function smooth(x, half) {
    const n = x.length, out = new Float64Array(n);
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
      out[i] = (pre[b] - pre[a]) / (b - a);
    }
    return out;
  }

  SD.Modulator = Modulator;
  SD.Demodulator = Demodulator;
  SD.modem = { packHeader, unpackHeader, packetCRC, symbolBody, TRACK };
})(globalThis.SD = globalThis.SD || {});
