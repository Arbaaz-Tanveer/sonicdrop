// OFDM numerology and speed modes. Both ends derive everything from this table.
(function (SD) {
  'use strict';

  const O = globalThis.SD_PARAM_OVERRIDES || {};   // test hook (e.g. try other cyclic prefixes)
  const P = {
    version: O.legacy ? 1 : 2,   // 2 = interleaved header + slot-local payload interleaver
    legacy: !!O.legacy,
    fs: 48000,       // internal sample rate (resampled on capture if the device differs)
    N: 2048,         // FFT size  -> 23.4375 Hz subcarrier spacing
    CP: O.CP || 768, // cyclic prefix (16 ms): absorbs room echoes (measured rooms reflect up to ~13 ms)
    W: 64,           // raised-cosine overlap between symbols (no clicks, less splatter)
    GAP: 480,        // silence after each frame so reverb decays before the next sync
    k0: 48,          // first used subcarrier (1125 Hz)
    U: 629,          // used subcarriers (1125 Hz .. 15844 Hz)
    pilotSpacing: 12,
    D: 576,          // data subcarriers per symbol
    ldpcN: 2304,
    hdrN: 576, hdrK: 144,
    delta: 48,       // FFT window back-off into the cyclic prefix
    preamble: 3,     // sync + train + header symbols
  };
  P.symLen = P.N + P.CP;

  const pilotIdx = [], dataIdx = [];
  for (let i = 0; i < P.U; i++) (i % P.pilotSpacing === 0 ? pilotIdx : dataIdx).push(i);
  if (dataIdx.length !== P.D) throw new Error('carrier layout mismatch ' + dataIdx.length);
  P.pilotIdx = Int32Array.from(pilotIdx);
  P.dataIdx = Int32Array.from(dataIdx);
  P.freqOf = (i) => ((P.k0 + i) * P.fs) / P.N;

  // Ladder chosen from simulations of a measured room (test/ladder.cjs): with a weak top band and
  // echoes, low code rates on denser constellations beat high code rates (QPSK 3/4 was dropped).
  const MODES = [
    { key: 'ultra',  name: 'Ultra-robust', mod: 'BPSK',    bps: 1, k: 1152, rate: '1/2', symbols: 16 },
    { key: 'robust', name: 'Robust',       mod: 'QPSK',    bps: 2, k: 1152, rate: '1/2', symbols: 16 },
    { key: 'normal', name: 'Normal',       mod: 'QPSK',    bps: 2, k: 1536, rate: '2/3', symbols: 16 },
    { key: 'quick',  name: 'Quick',        mod: '16-QAM',  bps: 4, k: 1152, rate: '1/2', symbols: 24 },
    // Faster modes (16-QAM 2/3, 64-QAM, 256-QAM) were removed at the user's request: real devices
    // in real rooms rarely sustain them. Adding an entry here re-enables one end to end.
  ];
  if (O.modes) { MODES.length = 0; O.modes.forEach((m) => MODES.push({ ...m })); }
  MODES.forEach((m, id) => {
    m.id = id;
    m.cws = (m.symbols * P.D * m.bps) / P.ldpcN;
    if (m.cws !== Math.floor(m.cws)) throw new Error('mode ' + m.key + ' not integral');
    m.blockSize = m.k / 8 - 4;                     // payload bytes per codeword (CRC32 appended)
    m.frameSamples = (P.preamble + m.symbols) * P.symLen + P.W + P.GAP;
    m.frameSeconds = m.frameSamples / P.fs;
    m.bitsPerFrame = m.cws * m.blockSize * 8;
    m.kbps = m.bitsPerFrame / m.frameSeconds / 1000;
    m.bytesPerSec = (m.cws * m.blockSize) / m.frameSeconds;
  });
  P.modes = MODES;
  P.maxSymbols = Math.max(...MODES.map((m) => m.symbols)) + P.preamble;

  SD.params = P;
})(globalThis.SD = globalThis.SD || {});
