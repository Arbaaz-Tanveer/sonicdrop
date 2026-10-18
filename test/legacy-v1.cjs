// Settings that decode recordings made with protocol v1 (10.7 ms CP, original speed ladder).
const mk = (name, mod, bps, k, rate, symbols) => ({ key: name.toLowerCase(), name, mod, bps, k, rate, symbols });
globalThis.SD_PARAM_OVERRIDES = { legacy: true, CP: 512, modes: [
  mk('Ultra-robust', 'BPSK', 1, 1152, '1/2', 16), mk('Robust', 'QPSK', 2, 1152, '1/2', 16), mk('Normal', 'QPSK', 2, 1728, '3/4', 16),
  mk('Quick', '16-QAM', 4, 1152, '1/2', 24), mk('Fast', '16-QAM', 4, 1728, '3/4', 24), mk('Turbo', '64-QAM', 6, 1536, '2/3', 32),
  mk('Hyper', '64-QAM', 6, 1920, '5/6', 32), mk('Cable', '256-QAM', 8, 1920, '5/6', 32) ] };
