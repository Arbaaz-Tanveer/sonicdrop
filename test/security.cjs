// Hostile-input tests for the container (what a malicious transmitter could send).
require('../src/core/util.js');
require('../src/core/container.js');
const SD = globalThis.SD;
const te = new TextEncoder();
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function container(flags, inner) { return Uint8Array.from([0x53, 0x44, 0x52, 0x31, flags, ...u32(inner.length), ...inner]); }
async function deflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
let fails = 0;
async function expectReject(name, bytes, pass) {
  const t0 = Date.now();
  try { await SD.container.unpack(bytes, pass); console.log('FAIL ', name, '(accepted)'); fails++; }
  catch (e) { console.log('PASS ', name.padEnd(48), `rejected: ${e.message} (${Date.now() - t0} ms)`); }
}
(async () => {
  // 1. Decompression bomb: declares 10 bytes, inflates to 200 MB.
  const bomb = await deflate(new Uint8Array(200 * 1024 * 1024));
  const meta = te.encode(JSON.stringify({ v: 1, f: [{ n: 'x.txt', t: 'text/plain', s: 10 }], h: '' }));
  await expectReject(`zip bomb (${(bomb.length / 1024).toFixed(0)} KB -> 200 MB)`, container(2, [...u32(meta.length), ...meta, ...bomb]));
  // 2. Absurd PBKDF2 cost (would hang the tab for hours).
  await expectReject('PBKDF2 iterations = 4e9', container(1, [...new Uint8Array(28), ...u32(0xFFFFFFF0), ...new Uint8Array(64)]), 'pw');
  // 3. Metadata length beyond the data.
  await expectReject('metadata length overflow', container(0, [...u32(0x7FFFFFFF), 1, 2, 3]));
  // 4. Malformed metadata.
  const bad = te.encode('{"v":1,"f":"nope"}');
  await expectReject('malformed metadata', container(0, [...u32(bad.length), ...bad]));
  // 5. Wrong passphrase.
  const enc = await SD.container.pack([{ name: 'a.txt', type: 'text/plain', data: te.encode('secret') }], { passphrase: 'right' });
  await expectReject('wrong passphrase', enc, 'wrong');
  // 6. Tampered ciphertext (AES-GCM authentication).
  const tampered = enc.slice(); tampered[tampered.length - 5] ^= 1;
  await expectReject('tampered ciphertext', tampered, 'right');
  // 7. Integrity: tampered plaintext payload is flagged (not silently accepted).
  const plain = await SD.container.pack([{ name: 'a.bin', type: 'application/octet-stream', data: new Uint8Array(100).fill(7) }], { compress: false });
  plain[plain.length - 1] ^= 1;
  const r = await SD.container.unpack(plain);
  console.log(r.verified ? 'FAIL  tampered payload passed SHA-256' : 'PASS  tampered payload fails the SHA-256 check');
  if (r.verified) fails++;
  console.log(fails ? `SECURITY TESTS: ${fails} FAILED` : 'SECURITY TESTS PASS');
  process.exit(fails ? 1 : 0);
})();
