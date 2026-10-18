// Transfer container: bundles files/text, compresses, optionally encrypts, and
// carries a SHA-256 so the receiver can prove the bytes are exactly what was sent.
//
//   'SDR1' | flags u8 (1=encrypted, 2=deflate) | bodyLen u32 | body
//   body (plain)     = metaLen u32 | meta JSON | payload (deflated if flag 2)
//   body (encrypted) = salt[16] | iv[12] | iterations u32 | AES-256-GCM(plain body)
(function (SD) {
  'use strict';
  const MAGIC = [0x53, 0x44, 0x52, 0x31];
  const F_ENC = 1, F_ZIP = 2;
  const ITER = 250000;
  const te = new TextEncoder(), td = new TextDecoder();

  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function readU32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function concat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function b64(bytes) {
    let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  async function streamBytes(bytes, stream, limit) {
    const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (limit !== undefined && n > limit) {   // refuse decompression bombs
        reader.cancel().catch(() => {});
        throw new Error('Transfer expands beyond its declared size');
      }
      parts.push(value);
    }
    return concat(parts);
  }
  const MAX_ITER = 2000000;   // PBKDF2 cost comes from the sender: cap it so a hostile value can't hang the tab
  const canZip = typeof CompressionStream !== 'undefined';

  async function deriveKey(pass, salt, iter) {
    const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // files: [{name, type, data: Uint8Array, message?: bool}]
  async function pack(files, opts) {
    opts = opts || {};
    const payload = concat(files.map((f) => f.data));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
    let flags = 0, body = payload;
    if (canZip && opts.compress !== false && payload.length > 64) {
      const z = await streamBytes(payload, new CompressionStream('deflate-raw'));
      if (z.length < payload.length * 0.95) { body = z; flags |= F_ZIP; }
    }
    const meta = {
      v: 1,
      f: files.map((f) => ({ n: f.name, t: f.type || 'application/octet-stream', s: f.data.length, m: f.message ? 1 : 0 })),
      h: b64(hash),
    };
    const mj = te.encode(JSON.stringify(meta));
    let inner = concat([Uint8Array.from(u32(mj.length)), mj, body]);
    if (opts.passphrase) {
      const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKey(opts.passphrase, salt, ITER);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, inner));
      inner = concat([salt, iv, Uint8Array.from(u32(ITER)), ct]);
      flags |= F_ENC;
    }
    return concat([Uint8Array.from(MAGIC), Uint8Array.from([flags]), Uint8Array.from(u32(inner.length)), inner]);
  }

  // Parse what we can from the first bytes (file names before the transfer finishes).
  function peek(prefix) {
    if (!prefix || prefix.length < 9) return null;
    for (let i = 0; i < 4; i++) if (prefix[i] !== MAGIC[i]) return { bad: true };
    const flags = prefix[4], total = readU32(prefix, 5);
    const out = { encrypted: !!(flags & F_ENC), compressed: !!(flags & F_ZIP), total: total + 9 };
    if (out.encrypted || prefix.length < 13) return out;
    const ml = readU32(prefix, 9);
    if (ml > 0 && prefix.length >= 13 + ml) {
      try { out.meta = JSON.parse(td.decode(prefix.subarray(13, 13 + ml))); } catch (e) { /* partial */ }
    }
    return out;
  }

  async function unpack(bytes, passphrase) {
    for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new Error('Not a SonicDrop transfer');
    const flags = bytes[4], len = readU32(bytes, 5);
    let inner = bytes.subarray(9, 9 + len);
    if (flags & F_ENC) {
      if (!passphrase) { const e = new Error('Passphrase required'); e.code = 'PASS'; throw e; }
      const salt = inner.subarray(0, 16), iv = inner.subarray(16, 28), iter = readU32(inner, 28);
      if (iter < 1000 || iter > MAX_ITER) throw new Error('Unsupported encryption parameters');
      const key = await deriveKey(passphrase, salt, iter);
      try {
        inner = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, inner.subarray(32)));
      } catch (e) {
        const err = new Error('Wrong passphrase'); err.code = 'PASS'; throw err;
      }
    }
    const ml = readU32(inner, 0);
    if (ml > inner.length - 4) throw new Error('Corrupted transfer');
    const meta = JSON.parse(td.decode(inner.subarray(4, 4 + ml)));
    if (!meta || !Array.isArray(meta.f) || meta.f.length > 1000) throw new Error('Corrupted transfer');
    let declared = 0;
    for (const f of meta.f) {
      if (typeof f.n !== 'string' || !(f.s >= 0)) throw new Error('Corrupted transfer');
      declared += f.s;
    }
    let payload = inner.subarray(4 + ml);
    if (flags & F_ZIP) payload = await streamBytes(payload, new DecompressionStream('deflate-raw'), declared);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
    const verified = b64(hash) === meta.h;
    const files = [];
    let o = 0;
    for (const f of meta.f) {
      files.push({ name: f.n.slice(0, 255), type: String(f.t || ''), data: payload.subarray(o, o + f.s), message: !!f.m });
      o += f.s;
    }
    return { files, verified, encrypted: !!(flags & F_ENC), compressed: !!(flags & F_ZIP) };
  }

  SD.container = { pack, unpack, peek };
})(globalThis.SD = globalThis.SD || {});
