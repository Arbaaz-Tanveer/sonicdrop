// LDPC codes with an IRA (irregular repeat-accumulate) structure:
//   H = [ H_info | dual-diagonal ]  -> linear-time encoding, no generator matrix.
// The parity-check matrix is built deterministically from a seed, so the
// sender and receiver construct the identical code with no data exchanged.
// Decoding: layered normalized min-sum with early termination.
(function (SD) {
  'use strict';
  const { rng } = SD.util;

  class LDPC {
    // degrees: array of [fraction, degree] for info bits, e.g. [[1, 3]].
    constructor(n, k, seed, degrees) {
      this.n = n; this.k = k; this.m = n - k;
      const m = this.m;
      const r = rng(seed);

      // Per-info-bit degree.
      const deg = new Uint8Array(k);
      let pos = 0;
      degrees.forEach(([frac, d], i) => {
        const cnt = i === degrees.length - 1 ? k - pos : Math.round(frac * k);
        for (let j = 0; j < cnt && pos < k; j++) deg[pos++] = d;
      });
      // Shuffle degrees so high-degree bits are spread over the codeword.
      for (let i = k - 1; i > 0; i--) { const j = r() % (i + 1); const t = deg[i]; deg[i] = deg[j]; deg[j] = t; }

      let E = 0;
      for (let j = 0; j < k; j++) E += deg[j];

      // Socket pool: each check appears ~E/m times.
      const pool = new Uint32Array(E);
      for (let e = 0; e < E; e++) pool[e] = e % m;
      for (let i = E - 1; i > 0; i--) { const j = r() % (i + 1); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }

      const checkVars = Array.from({ length: m }, () => []);
      const varChecks = Array.from({ length: k }, () => []);
      const mark = new Int32Array(k).fill(-1);
      let p = 0;
      for (let j = 0; j < k; j++) {
        const S = varChecks[j];
        for (let d = 0; d < deg[j]; d++) {
          let chosen = -1;
          for (let tries = 0; tries < 60 && p + tries < E; tries++) {
            const idx = tries === 0 ? p : p + (r() % (E - p));
            const c = pool[idx];
            if (!this._ok(c, S, checkVars, mark, j, true)) continue;
            // swap into position p
            const t = pool[p]; pool[p] = pool[idx]; pool[idx] = t;
            chosen = c; break;
          }
          if (chosen < 0) {
            // Relax the 4-cycle rule; still forbid duplicate/adjacent checks.
            for (let tries = 0; tries < 400; tries++) {
              const c = p < E && tries < 200 ? pool[p + (r() % (E - p))] : r() % m;
              if (this._ok(c, S, checkVars, mark, j, false)) { chosen = c; break; }
            }
            if (chosen < 0) throw new Error('LDPC construction failed');
          }
          p++;
          S.push(chosen);
          for (const v of checkVars[chosen]) mark[v] = j;
          checkVars[chosen].push(j);
        }
      }

      // CSR rows: info vars then parity vars (dual diagonal).
      const rowStart = new Uint32Array(m + 1);
      let total = 0;
      for (let c = 0; c < m; c++) { rowStart[c] = total; total += checkVars[c].length + (c === 0 ? 1 : 2); }
      rowStart[m] = total;
      const col = new Uint32Array(total);
      for (let c = 0; c < m; c++) {
        let e = rowStart[c];
        for (const v of checkVars[c]) col[e++] = v;
        col[e++] = k + c;
        if (c > 0) col[e++] = k + c - 1;
      }
      this.rowStart = rowStart; this.col = col; this.edges = total;
      this.checkInfo = checkVars.map((a) => Uint32Array.from(a));
      this.maxRow = 0;
      for (let c = 0; c < m; c++) this.maxRow = Math.max(this.maxRow, rowStart[c + 1] - rowStart[c]);
      this._R = new Float32Array(total);
      this._L = new Float32Array(n);
      this._Q = new Float32Array(this.maxRow);
    }

    _ok(c, S, checkVars, mark, j, strict) {
      for (let i = 0; i < S.length; i++) {
        const s = S[i];
        if (s === c || s === c + 1 || s === c - 1) return false;
      }
      if (strict) {
        const vs = checkVars[c];
        for (let i = 0; i < vs.length; i++) if (mark[vs[i]] === j) return false;
      }
      return true;
    }

    // info: Uint8Array(k) of 0/1 -> codeword Uint8Array(n)
    encode(info, out) {
      const k = this.k, m = this.m;
      out = out || new Uint8Array(this.n);
      out.set(info.subarray(0, k), 0);
      let prev = 0;
      for (let c = 0; c < m; c++) {
        const vs = this.checkInfo[c];
        let s = 0;
        for (let i = 0; i < vs.length; i++) s ^= info[vs[i]];
        prev ^= s;
        out[k + c] = prev;
      }
      return out;
    }

    // llr: Float32Array(n), positive => bit 0. Returns {ok, iters, bits (n hard bits)}.
    decode(llr, maxIter, alpha) {
      maxIter = maxIter || 30;
      alpha = alpha || 0.78;
      const { m, rowStart, col } = this;
      const R = this._R, L = this._L, Q = this._Q;
      R.fill(0);
      L.set(llr);
      let iter = 0, ok = false;
      for (iter = 1; iter <= maxIter; iter++) {
        for (let c = 0; c < m; c++) {
          const s0 = rowStart[c], s1 = rowStart[c + 1];
          let min1 = Infinity, min2 = Infinity, minIdx = -1, sgn = 0;
          for (let e = s0; e < s1; e++) {
            const q = L[col[e]] - R[e];
            Q[e - s0] = q;
            const a = q < 0 ? -q : q;
            if (q < 0) sgn ^= 1;
            if (a < min1) { min2 = min1; min1 = a; minIdx = e; } else if (a < min2) min2 = a;
          }
          const m1 = alpha * min1, m2 = alpha * min2;
          for (let e = s0; e < s1; e++) {
            const q = Q[e - s0];
            let mag = e === minIdx ? m2 : m1;
            const neg = sgn ^ (q < 0 ? 1 : 0);
            const rn = neg ? -mag : mag;
            R[e] = rn;
            L[col[e]] = q + rn;
          }
        }
        // Syndrome check.
        ok = true;
        for (let c = 0; c < m && ok; c++) {
          let par = 0;
          for (let e = rowStart[c]; e < rowStart[c + 1]; e++) par ^= L[col[e]] < 0 ? 1 : 0;
          if (par) ok = false;
        }
        if (ok) break;
      }
      const bits = new Uint8Array(this.n);
      for (let i = 0; i < this.n; i++) bits[i] = L[i] < 0 ? 1 : 0;
      return { ok, iters: Math.min(iter, maxIter), bits };
    }
  }

  // Code cache keyed by (n, k): built once, identical everywhere.
  const codes = new Map();
  function getCode(n, k) {
    const key = n + ':' + k;
    let c = codes.get(key);
    if (!c) {
      const rate = k / n;
      // Degree profiles tuned empirically for these block lengths (see test/ldpc-bench).
      let deg;
      if (rate <= 0.3) deg = [[1, 6]];
      else if (rate <= 0.55) deg = [[1, 4]];
      else if (rate <= 0.8) deg = [[0.8, 3], [0.2, 8]];
      else deg = [[1, 4]];
      c = new LDPC(n, k, SD.util.hash32(n, k, 0x5D0C), deg);
      codes.set(key, c);
    }
    return c;
  }

  SD.LDPC = LDPC;
  SD.getCode = getCode;
})(globalThis.SD = globalThis.SD || {});
