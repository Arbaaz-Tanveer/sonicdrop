// SonicDrop core: shared helpers (PRNG, hashing, CRC, bit packing).
// Classic script: attaches to globalThis.SD so it runs in pages, workers and Node.
(function (SD) {
  'use strict';

  // Deterministic 32-bit PRNG (mulberry32). Same sequence on every platform.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    };
  }

  // Mix several integers into one 32-bit seed.
  function hash32() {
    let h = 0x811C9DC5 | 0;
    for (let i = 0; i < arguments.length; i++) {
      let v = arguments[i] >>> 0;
      for (let b = 0; b < 4; b++) {
        h ^= v & 0xFF;
        h = Math.imul(h, 0x01000193);
        v >>>= 8;
      }
    }
    h ^= h >>> 16; h = Math.imul(h, 0x85EBCA6B);
    h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  // Fisher-Yates permutation of 0..n-1 from a seed.
  function permutation(n, seed) {
    const p = new Uint32Array(n);
    for (let i = 0; i < n; i++) p[i] = i;
    const r = rng(seed);
    for (let i = n - 1; i > 0; i--) {
      const j = r() % (i + 1);
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    return p;
  }

  // Pseudo-random bit sequence (0/1 bytes).
  function pnBits(n, seed) {
    const out = new Uint8Array(n);
    const r = rng(seed);
    let word = 0;
    for (let i = 0; i < n; i++) {
      if ((i & 31) === 0) word = r();
      out[i] = (word >>> (i & 31)) & 1;
    }
    return out;
  }

  const CRC32_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, init) {
    let c = (init === undefined ? 0xFFFFFFFF : init) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return c >>> 0;
  }

  function crc16(bytes, len) {
    let c = 0xFFFF;
    const n = len === undefined ? bytes.length : len;
    for (let i = 0; i < n; i++) {
      c ^= bytes[i] << 8;
      for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
    }
    return c;
  }

  // Bytes -> bits (MSB first), one bit per Uint8.
  function bytesToBits(bytes, out, offset) {
    const n = bytes.length * 8;
    out = out || new Uint8Array(n);
    offset = offset || 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      for (let k = 0; k < 8; k++) out[offset + i * 8 + k] = (b >>> (7 - k)) & 1;
    }
    return out;
  }

  function bitsToBytes(bits, nBytes, offset) {
    offset = offset || 0;
    const out = new Uint8Array(nBytes);
    for (let i = 0; i < nBytes; i++) {
      let b = 0;
      for (let k = 0; k < 8; k++) b = (b << 1) | (bits[offset + i * 8 + k] & 1);
      out[i] = b;
    }
    return out;
  }

  SD.util = { rng, hash32, permutation, pnBits, crc32, crc16, bytesToBits, bitsToBytes };
})(globalThis.SD = globalThis.SD || {});
