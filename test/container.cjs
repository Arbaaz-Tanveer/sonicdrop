// Container round trips: plain, compressed, encrypted (right/wrong passphrase), and through the full modem.
require('../src/core/container.js');
const lib = require('./sim-lib.cjs'); const { SD, P } = lib;
(async () => {
  const te = new TextEncoder();
  const img = new Uint8Array(5000).map((_, i) => (i * 131) & 255);
  const files = [{ name: 'notes.txt', type: 'text/plain', data: te.encode('hello '.repeat(400)) },
                 { name: 'photo.bin', type: 'image/jpeg', data: img },
                 { name: 'message.txt', type: 'text/plain', data: te.encode('Sent with sound 🔊'), message: true }];
  const plain = await SD.container.pack(files, {});
  console.log('plain packed', plain.length, 'bytes; peek:', JSON.stringify(SD.container.peek(plain.subarray(0, 300)).meta.f.map((f) => f.n)));
  let r = await SD.container.unpack(plain);
  console.log('plain unpack verified', r.verified, 'compressed', r.compressed, r.files.map((f) => `${f.name}:${f.data.length}`).join(' '), 'msg:', new TextDecoder().decode(r.files[2].data));
  const enc = await SD.container.pack(files, { passphrase: 'correct horse' });
  console.log('encrypted packed', enc.length, 'peek', JSON.stringify(SD.container.peek(enc)));
  try { await SD.container.unpack(enc, 'wrong'); console.log('ERROR: wrong pass accepted'); } catch (e) { console.log('wrong passphrase rejected:', e.message); }
  r = await SD.container.unpack(enc, 'correct horse');
  console.log('encrypted unpack verified', r.verified, r.files.length, 'files');
  // Through the modem.
  const tx = lib.transmit(enc, 3, {});
  const ch = lib.channel(tx.audio, lib.SCENARIOS.near);
  const rx = lib.receive(ch.audio, ch.rate, tx.K, P.modes[3].blockSize, tx.session);
  r = await SD.container.unpack(rx.dec.data, 'correct horse');
  console.log('over-the-air (sim) encrypted transfer verified:', r.verified, r.files.map((f) => f.name).join(', '));
})();
