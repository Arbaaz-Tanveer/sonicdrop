// Gray-coded square QAM (and BPSK) with max-log soft demapping.
(function (SD) {
  'use strict';

  const cache = new Map();

  class QAM {
    constructor(bps) {
      this.bps = bps;
      if (bps === 1) {
        this.b = 1; this.L = 2; this.scale = 1;
        this.levels = Float64Array.from([1, -1]);   // gray index -> amplitude (bit 0 -> +1)
        this.levelBits = Uint8Array.from([0, 1]);   // level index (ascending amp) -> bits
        this.amps = Float64Array.from([-1, 1]);
        this.ampBits = Uint8Array.from([1, 0]);
        return;
      }
      const b = bps / 2, L = 1 << b;
      this.b = b; this.L = L;
      this.scale = 1 / Math.sqrt((2 * (L * L - 1)) / 3);
      this.amps = new Float64Array(L);      // ascending amplitudes
      this.ampBits = new Uint8Array(L);     // their gray labels
      this.levels = new Float64Array(L);    // label -> amplitude
      for (let i = 0; i < L; i++) {
        const a = (2 * i - (L - 1)) * this.scale;
        const g = i ^ (i >> 1);
        this.amps[i] = a; this.ampBits[i] = g; this.levels[g] = a;
      }
    }

    static get(bps) {
      let q = cache.get(bps);
      if (!q) { q = new QAM(bps); cache.set(bps, q); }
      return q;
    }

    // bits[off..off+bps) -> [re, im]
    map(bits, off, out) {
      if (this.bps === 1) { out[0] = bits[off] ? -1 : 1; out[1] = 0; return out; }
      const b = this.b;
      let gi = 0, gq = 0;
      for (let t = 0; t < b; t++) gi = (gi << 1) | bits[off + t];
      for (let t = 0; t < b; t++) gq = (gq << 1) | bits[off + b + t];
      out[0] = this.levels[gi]; out[1] = this.levels[gq];
      return out;
    }

    // Soft demap one symbol. z = equalized point, nv = noise variance of z (complex).
    // Writes bps LLRs (positive => bit 0) to llr[off..].
    demap(zr, zi, nv, llr, off) {
      const inv = 1 / nv;
      if (this.bps === 1) { llr[off] = clip(4 * zr * inv); return; }
      this._dim(zr, inv, llr, off);
      this._dim(zi, inv, llr, off + this.b);
    }

    _dim(y, inv, llr, off) {
      const b = this.b, L = this.L, amps = this.amps, bits = this.ampBits;
      for (let t = 0; t < b; t++) {
        let m0 = Infinity, m1 = Infinity;
        const sh = b - 1 - t;
        for (let i = 0; i < L; i++) {
          const d = (y - amps[i]) * (y - amps[i]);
          if ((bits[i] >> sh) & 1) { if (d < m1) m1 = d; } else if (d < m0) m0 = d;
        }
        llr[off + t] = clip((m1 - m0) * inv);
      }
    }

    // Nearest constellation point.
    decide(zr, zi, out) {
      out[0] = this._near(zr);
      out[1] = this.bps === 1 ? 0 : this._near(zi);
      return out;
    }

    _near(y) {
      const L = this.L, s = this.scale;
      let i = Math.round((y / s + (L - 1)) / 2);
      if (i < 0) i = 0; else if (i > L - 1) i = L - 1;
      return this.amps[i];
    }
  }

  function clip(x) { return x > 24 ? 24 : x < -24 ? -24 : x; }

  SD.QAM = QAM;
})(globalThis.SD = globalThis.SD || {});
