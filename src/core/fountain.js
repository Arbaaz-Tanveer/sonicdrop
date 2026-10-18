// Systematic random linear fountain code over GF(2).
// Packet ids 0..K-1 are the source blocks themselves; ids >= K are dense random
// XOR combinations. Any K independent packets rebuild the file, so a receiver can
// start listening at any moment and every lost frame is replaced by later ones.
(function (SD) {
  'use strict';
  const U = SD.util;

  function coeffs(session, id, K) {
    const W = (K + 31) >>> 5;
    const c = new Uint32Array(W);
    const r = U.rng(U.hash32(session, id, 0xF0F0));
    for (let w = 0; w < W; w++) c[w] = r();
    const tail = K & 31;
    if (tail) c[W - 1] &= (1 << tail) - 1;
    let any = 0;
    for (let w = 0; w < W; w++) any |= c[w];
    if (!any) c[(id % K) >>> 5] |= 1 << ((id % K) & 31);
    return c;
  }

  function xorInto(dst, src, off, len) {
    for (let i = 0; i < len; i++) dst[i] ^= src[off + i];
  }

  class FountainEncoder {
    constructor(data, blockSize, session) {
      this.B = blockSize;
      this.K = Math.max(1, Math.ceil(data.length / blockSize));
      this.session = session;
      this.blocks = new Uint8Array(this.K * blockSize);
      this.blocks.set(data);
    }
    packet(id) {
      const B = this.B, K = this.K;
      if (id < K) return this.blocks.slice(id * B, (id + 1) * B);
      const c = coeffs(this.session, id, K), out = new Uint8Array(B);
      for (let w = 0; w < c.length; w++) {
        let word = c[w];
        while (word) {
          const bit = 31 - Math.clz32(word & -word);
          word &= word - 1;
          xorInto(out, this.blocks, ((w << 5) + bit) * B, B);
        }
      }
      return out;
    }
  }

  class FountainDecoder {
    constructor(K, blockSize, session) {
      this.K = K; this.B = blockSize; this.session = session;
      this.W = (K + 31) >>> 5;
      this.known = new Uint8Array(K);
      this.data = new Uint8Array(K * blockSize);
      this.pivots = new Array(K).fill(null);
      this.numKnown = 0; this.numPivots = 0;
      this.seen = new Set();
      this.received = 0;
      this.done = false;
    }
    get rank() { return this.numKnown + this.numPivots; }

    // Returns true when the packet added new information.
    add(id, payload) {
      if (this.done || this.seen.has(id)) return false;
      this.seen.add(id);
      this.received++;
      let gained;
      if (id < this.K) {
        if (this.known[id]) return false;
        const row = this.pivots[id];
        this._setKnown(id, payload);
        if (row) {
          // That pivot row lost its pivot column: reduce it and re-insert.
          this.pivots[id] = null; this.numPivots--;
          row.coef[id >>> 5] &= ~(1 << (id & 31));
          xorInto(row.pay, payload, 0, this.B);
          gained = this._insert(row);
        } else gained = true;
      } else {
        gained = this._insert({ coef: coeffs(this.session, id, this.K), pay: payload.slice() });
      }
      if (this.rank === this.K) this._solve();
      return gained;
    }

    _setKnown(c, pay) {
      this.known[c] = 1;
      this.data.set(pay.subarray(0, this.B), c * this.B);
      this.numKnown++;
    }

    _insert(row) {
      const { coef, pay } = row, B = this.B, W = this.W;
      for (let w = 0; w < W; w++) {
        let word;
        while ((word = coef[w]) !== 0) {
          const bit = 31 - Math.clz32(word & -word);
          const c = (w << 5) + bit;
          if (this.known[c]) {
            coef[w] = word & (word - 1);
            xorInto(pay, this.data, c * B, B);
            continue;
          }
          const pv = this.pivots[c];
          if (pv) {
            const pc = pv.coef;
            for (let x = w; x < W; x++) coef[x] ^= pc[x];
            xorInto(pay, pv.pay, 0, B);
            continue;
          }
          this.pivots[c] = row; this.numPivots++;
          return true;
        }
      }
      return false;
    }

    _solve() {
      const B = this.B;
      for (let c = this.K - 1; c >= 0; c--) {
        const row = this.pivots[c];
        if (!row) continue;
        const { coef, pay } = row;
        coef[c >>> 5] &= ~(1 << (c & 31));
        for (let w = c >>> 5; w < this.W; w++) {
          let word = coef[w];
          while (word) {
            const bit = 31 - Math.clz32(word & -word);
            word &= word - 1;
            xorInto(pay, this.data, ((w << 5) + bit) * B, B);
          }
        }
        this.pivots[c] = null;
        this._setKnown(c, pay);
      }
      this.numPivots = 0;
      this.done = true;
    }
  }

  SD.FountainEncoder = FountainEncoder;
  SD.FountainDecoder = FountainDecoder;
})(globalThis.SD = globalThis.SD || {});
