// Radix-2 complex FFT, in place on separate real/imag Float64Arrays.
(function (SD) {
  'use strict';

  const cache = new Map();

  class FFT {
    constructor(n) {
      if (n & (n - 1)) throw new Error('FFT size must be a power of two');
      this.n = n;
      this.cos = new Float64Array(n >> 1);
      this.sin = new Float64Array(n >> 1);
      for (let i = 0; i < n >> 1; i++) {
        this.cos[i] = Math.cos((2 * Math.PI * i) / n);
        this.sin[i] = Math.sin((2 * Math.PI * i) / n);
      }
      this.rev = new Uint32Array(n);
      const bits = Math.log2(n);
      for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
        this.rev[i] = r;
      }
    }

    static get(n) {
      let f = cache.get(n);
      if (!f) { f = new FFT(n); cache.set(n, f); }
      return f;
    }

    // Forward: X[k] = sum x[n] e^{-j2πkn/N}. Inverse has no 1/N scaling.
    transform(re, im, inverse) {
      const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      const sg = inverse ? -1 : 1;
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const c = cs[k], s = sg * sn[k];
            const tre = re[l] * c + im[l] * s;
            const tim = im[l] * c - re[l] * s;
            re[l] = re[j] - tre; im[l] = im[j] - tim;
            re[j] += tre; im[j] += tim;
          }
        }
      }
    }
  }

  SD.FFT = FFT;
})(globalThis.SD = globalThis.SD || {});
