// Streaming windowed-sinc resampler (Kaiser window, 32 taps, 1024 phases).
(function (SD) {
  'use strict';

  const HALF = 16, PHASES = 1024;

  function bessel0(x) {
    let s = 1, t = 1;
    for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; }
    return s;
  }

  const tables = new Map();
  function table(cutoff) {
    const key = cutoff.toFixed(5);
    let tb = tables.get(key);
    if (tb) return tb;
    const beta = 8, i0b = bessel0(beta);
    tb = new Float32Array(PHASES * 2 * HALF);
    for (let p = 0; p < PHASES; p++) {
      const frac = p / PHASES;
      let sum = 0;
      for (let t = 0; t < 2 * HALF; t++) {
        const x = t - (HALF - 1) - frac;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
        const r = x / HALF;
        const win = Math.abs(r) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - r * r)) / i0b;
        const v = cutoff * sinc * win;
        tb[p * 2 * HALF + t] = v;
        sum += v;
      }
      for (let t = 0; t < 2 * HALF; t++) tb[p * 2 * HALF + t] /= sum;  // unity DC gain
    }
    tables.set(key, tb);
    return tb;
  }

  class Resampler {
    constructor(inRate, outRate) {
      this.setRates(inRate, outRate);
      this.buf = new Float32Array(1 << 16);
      this.len = HALF - 1;       // leading zeros so output 0 aligns with input 0
      this.t = HALF - 1;
    }
    setRates(inRate, outRate) {
      this.step = inRate / outRate;
      this.pass = Math.abs(this.step - 1) < 1e-9;
      this.tb = table(Math.min(1, outRate / inRate) * 0.97);
    }
    process(input) {
      if (this.pass) return input instanceof Float32Array ? input : Float32Array.from(input);
      if (this.len + input.length > this.buf.length) {
        const nb = new Float32Array(Math.max(this.buf.length * 2, this.len + input.length));
        nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
      }
      this.buf.set(input, this.len);
      this.len += input.length;
      const maxOut = Math.ceil((this.len - this.t) / this.step) + 2;
      const out = new Float32Array(Math.max(0, maxOut));
      const tb = this.tb, buf = this.buf, W2 = 2 * HALF;
      let n = 0, t = this.t;
      while (true) {
        const it = Math.floor(t);
        if (it + HALF >= this.len) break;
        const p = Math.min(PHASES - 1, Math.round((t - it) * PHASES)) ;
        const base = it - (HALF - 1), tbo = p * W2;
        let acc = 0;
        for (let k = 0; k < W2; k++) acc += buf[base + k] * tb[tbo + k];
        out[n++] = acc;
        t += this.step;
      }
      // Drop consumed input, keep history.
      const keepFrom = Math.max(0, Math.floor(t) - (HALF - 1));
      buf.copyWithin(0, keepFrom, this.len);
      this.len -= keepFrom;
      this.t = t - keepFrom;
      return out.subarray(0, n);
    }
  }

  SD.Resampler = Resampler;
})(globalThis.SD = globalThis.SD || {});
