// SonicDrop engine: all signal processing runs here, off the UI thread.
/* global SD, importScripts */
if (!self.SD || !self.SD.Demodulator) {
  importScripts('core/util.js', 'core/fft.js', 'core/ldpc.js', 'core/params.js', 'core/qam.js',
    'core/modem.js', 'core/resampler.js', 'core/fountain.js');
}
(function () {
  'use strict';
  const P = SD.params;
  const MAX_K = 40000;        // ~5 MB: bounds receiver memory whatever a transmitter claims
  const MAX_SESSIONS = 8;
  let tx = null, rx = null;

  const post = (m, tr) => self.postMessage(m, tr || []);

  self.onmessage = (e) => {
    const m = e.data;
    try {
      switch (m.cmd) {
        case 'warmup': warmup(); break;
        case 'tx-start': txStart(m); break;
        case 'tx-frames': txFrames(m.count || 1); break;
        case 'tx-stop': tx = null; break;
        case 'rx-start': rxStart(m); break;
        case 'rx-audio': if (rx) rxAudio(m.samples); break;
        case 'rx-stop': rx = null; break;
      }
    } catch (err) {
      post({ evt: 'error', message: String(err && err.stack || err) });
    }
  };

  // Build the LDPC codes ahead of time so the first frame isn't delayed.
  function warmup() {
    const t0 = Date.now();
    SD.getCode(P.hdrN, P.hdrK);
    new Set(P.modes.map((m) => m.k)).forEach((k) => SD.getCode(P.ldpcN, k));
    post({ evt: 'ready', ms: Date.now() - t0 });
  }

  // ---------------- TX ----------------
  function testPlan() {
    const plan = [];
    P.modes.forEach((m, step) => { plan.push({ mode: m.id, step }); plan.push({ mode: m.id, step }); });
    return plan;
  }

  function txStart(m) {
    tx = { mod: new SD.Modulator({ amp: m.amp || 0.3 }), session: m.session & 0xFFFF, nextId: 0, frame: 0 };
    if (m.test) {
      tx.plan = testPlan();
      post({ evt: 'tx-ready', test: true, frames: tx.plan.length, seconds: tx.plan.reduce((a, s) => a + P.modes[s.mode].frameSeconds, 0) });
      return;
    }
    const mode = P.modes[m.mode];
    tx.mode = mode;
    tx.enc = new SD.FountainEncoder(new Uint8Array(m.data), mode.blockSize, tx.session);
    post({ evt: 'tx-ready', K: tx.enc.K, blockSize: mode.blockSize, cws: mode.cws, frameSeconds: mode.frameSeconds });
  }

  function txFrames(count) {
    for (let i = 0; i < count && tx; i++) {
      let header, payloads = [], mode, step = null;
      if (tx.plan) {
        if (tx.frame >= tx.plan.length) { post({ evt: 'tx-end' }); return; }
        const s = tx.plan[tx.frame];
        mode = P.modes[s.mode]; step = s.step;
        header = { mode: mode.id, session: tx.session, K: 0, baseId: tx.nextId, flags: 1, testStep: step, testTotal: P.modes.length };
        for (let c = 0; c < mode.cws; c++) {
          const r = SD.util.rng(SD.util.hash32(tx.session, tx.nextId + c));
          const pl = new Uint8Array(mode.blockSize);
          for (let b = 0; b < pl.length; b++) pl[b] = r() & 255;
          payloads.push(pl);
        }
      } else {
        mode = tx.mode;
        header = { mode: mode.id, session: tx.session, K: tx.enc.K, baseId: tx.nextId };
        for (let c = 0; c < mode.cws; c++) payloads.push(tx.enc.packet(tx.nextId + c));
      }
      const samples = tx.mod.frame(header, payloads);
      post({ evt: 'tx-frame', samples, info: { baseId: tx.nextId, cws: mode.cws, mode: mode.id, step, index: tx.frame, seconds: samples.length / P.fs } }, [samples.buffer]);
      tx.nextId += mode.cws;
      tx.frame++;
    }
  }

  // ---------------- RX ----------------
  function rxStart(m) {
    rx = {
      rate: m.rate,
      rs: new SD.Resampler(m.rate, P.fs),
      dm: new SD.Demodulator(),
      sessions: new Map(),
      samples: 0,
      lastStatus: 0,
    };
    post({ evt: 'rx-started', rate: m.rate });
  }

  function rxAudio(samples) {
    rx.samples += samples.length;
    const x = rx.rs.process(samples);
    rx.dm.push(x);
    const evs = rx.dm.process();
    const t = rx.samples / rx.rate;
    for (const ev of evs) handle(ev, t);
    if (t - rx.lastStatus > 0.1) {
      rx.lastStatus = t;
      const st = rx.dm.stats;
      post({ evt: 'rx-status', t, level: rx.dm.level, syncs: st.syncs, headerFail: st.headerFail, frames: st.frames, busy: !!rx.dm.pending });
    }
  }

  function handle(ev, t) {
    if (ev.type === 'header') { post({ evt: 'rx-header', t, header: ev.header }); return; }
    if (ev.type === 'sync-fail') { post({ evt: 'rx-syncfail', t }); return; }
    if (ev.type !== 'frame') return;
    const h = ev.header, mode = P.modes[ev.mode];
    const stats = {
      mode: ev.mode, ok: ev.ok, total: ev.total, snr: ev.snr, trainSnr: ev.trainSnr, ppm: ev.ppm,
      rawBer: ev.rawBer, iters: ev.iters, snrBins: ev.snrBins, constellation: ev.constellation, peak: ev.peak,
    };
    if (h.flags & 1) {
      post({ evt: 'rx-test', t, step: h.testStep, steps: h.testTotal, session: h.session, stats }, [ev.constellation.buffer]);
      return;
    }
    if (!h.K || h.K > MAX_K) return;
    let s = rx.sessions.get(h.session);
    if (s && (s.dec.K !== h.K || s.mode !== ev.mode)) s = null;   // corrupted/changed: start over
    if (!s) {
      s = { dec: new SD.FountainDecoder(h.K, mode.blockSize, h.session), mode: ev.mode, headLen: 0, reported: false };
      rx.sessions.set(h.session, s);
      while (rx.sessions.size > MAX_SESSIONS) rx.sessions.delete(rx.sessions.keys().next().value);
      post({ evt: 'rx-new', t, session: h.session, K: h.K, mode: ev.mode, blockSize: mode.blockSize });
    }
    const wasDone = s.dec.done;
    let gained = 0;
    for (const pk of ev.packets) if (pk.data && s.dec.add(pk.id, pk.data)) gained++;
    // Contiguous prefix of known blocks -> lets the UI show file names early.
    let head = null, n = 0;
    const maxHead = Math.min(s.dec.K, Math.ceil(4096 / mode.blockSize));
    while (n < maxHead && s.dec.known[n]) n++;
    if (n > s.headLen) { s.headLen = n; head = s.dec.data.slice(0, n * mode.blockSize); }
    post({
      evt: 'rx-frame', t, session: h.session, stats,
      progress: {
        K: s.dec.K, rank: s.dec.rank, known: s.dec.known.slice(), received: s.dec.received,
        gained, gainedBytes: gained * mode.blockSize, done: s.dec.done,
      },
      head,
    }, [ev.constellation.buffer]);
    if (s.dec.done && !wasDone && !s.reported) {
      s.reported = true;
      const data = s.dec.data.slice();
      post({ evt: 'rx-done', t, session: h.session, data }, [data.buffer]);
    }
  }
})();
