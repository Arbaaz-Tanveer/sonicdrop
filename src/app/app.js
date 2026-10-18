// SonicDrop UI: roles, file picking, audio I/O, live stats and visualizations.
/* global SD */
(function () {
  'use strict';
  const P = SD.params;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('sd.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('sd.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  const MODE_HINT = {
    ultra: 'far away / noisy', robust: 'across a room', normal: '1–2 m', quick: 'about 1 m, held still',
    fast: 'under 50 cm, still', turbo: 'very close, quiet', hyper: 'touching, quiet', cable: 'audio cable',
  };
  // Rough link SNR (dB, as measured by the receiver) each mode needs, from simulation.
  const MODE_SNR = [0, 4, 6.5, 10];

  // Received files come from whoever is transmitting nearby, so their claimed MIME type is untrusted.
  // Only well-known passive types keep it; anything else (HTML, SVG, scripts...) becomes a plain
  // download so it can never render inside this page's origin.
  const SAFE_TYPES = /^(image\/(png|jpeg|webp|gif|avif|bmp|heic|heif)|application\/pdf|text\/plain|text\/csv|audio\/(mpeg|mp4|ogg|wav|webm|aac|flac)|video\/(mp4|webm|quicktime)|application\/(zip|x-zip-compressed|msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-excel|vnd\.ms-powerpoint|json|epub\+zip))$/i;
  const safeType = (t) => (SAFE_TYPES.test(String(t || '')) ? String(t).toLowerCase() : 'application/octet-stream');

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(n < 10485760 ? 2 : 1) + ' MB';
  }
  function fmtDur(s) {
    if (!isFinite(s)) return '–';
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + ' s';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  }
  function fmtClock(s) { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  function fmtKbps(k) { return (k >= 10 ? k.toFixed(0) : k.toFixed(1)) + '<small> kbps</small>'; }
  let toastT = 0;
  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms || 3500);
  }
  function randSession() { return (crypto.getRandomValues(new Uint16Array(1))[0] | 1) & 0xFFFF; }

  // ---------------- engine worker ----------------
  let worker = null;
  const handlers = {};
  function engine() {
    if (worker) return worker;
    if (window.SD_BUNDLE) {
      const url = URL.createObjectURL(new Blob([window.SD_BUNDLE.worker], { type: 'text/javascript' }));
      worker = new Worker(url);
    } else {
      worker = new Worker('engine-worker.js');
    }
    worker.onmessage = (e) => { const fn = handlers[e.data.evt]; if (fn) fn(e.data); };
    worker.onerror = (e) => { console.error(e); toast('Engine error: ' + (e.message || e)); };
    worker.postMessage({ cmd: 'warmup' });
    return worker;
  }
  handlers.error = (m) => { console.error(m.message); toast('Engine error, see console'); };

  function workletURL() {
    if (window.SD_BUNDLE) return URL.createObjectURL(new Blob([window.SD_BUNDLE.worklet], { type: 'text/javascript' }));
    return 'capture-worklet.js';
  }

  // ---------------- wake lock ----------------
  let wake = null;
  async function keepAwake(on) {
    try {
      if (on && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
      if (!on && wake) { await wake.release(); wake = null; }
    } catch (e) { /* not available */ }
  }

  // ---------------- routing ----------------
  const SCREENS = ['home', 'send', 'receive', 'test'];
  let current = 'home';
  function route() {
    let name = location.hash.replace('#', '') || 'home';
    if (!SCREENS.includes(name)) name = 'home';
    if (current === 'send' && name !== 'send') stopTx();
    if (current === 'test' && name !== 'test') stopTestTx();
    if (current === 'receive' && name !== 'receive') stopRx();
    current = name;
    SCREENS.forEach((s) => $('screen-' + s).classList.toggle('active', s === name));
    $('backBtn').hidden = name === 'home';
    window.scrollTo(0, 0);
    if (name !== 'home') engine();
    if (name === 'send') renderModes();
  }
  window.addEventListener('hashchange', route);
  $('backBtn').onclick = () => { location.hash = ''; };
  document.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => { location.hash = b.dataset.go; }; });

  // ---------------- audio output ----------------
  class Player {
    constructor() {
      const AC = window.AudioContext || window.webkitAudioContext;
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* iOS 17+ only */ }
      this.ctx = new AC({ latencyHint: 'playback' });
      this.ctx.resume();
      this.gain = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0;
      this.gain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.next = 0;
      this.sched = [];
      this.sources = new Set();
    }
    setVolume(v) { this.gain.gain.value = v; }
    enqueue(samples, info) {
      const ctx = this.ctx;
      const buf = ctx.createBuffer(1, samples.length, P.fs);
      if (buf.copyToChannel) buf.copyToChannel(samples, 0); else buf.getChannelData(0).set(samples);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain);
      const t = Math.max(this.next, ctx.currentTime + 0.15);
      src.start(t);
      this.next = t + buf.duration;
      this.sched.push({ start: t, end: this.next, info });
      this.sources.add(src);
      src.onended = () => this.sources.delete(src);
    }
    ahead() { return this.next - this.ctx.currentTime; }
    now() { return this.ctx.currentTime; }
    stop() {
      this.sources.forEach((s) => { try { s.stop(); } catch (e) { /* already stopped */ } });
      this.sources.clear();
      try { this.ctx.close(); } catch (e) { /* closed */ }
    }
  }

  // ---------------- waterfall ----------------
  const PALETTE = (function () {
    const stops = [[0, [5, 6, 10]], [0.22, [30, 27, 75]], [0.45, [124, 58, 237]], [0.7, [34, 211, 238]], [1, [240, 253, 255]]];
    const p = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      let a = 0; while (a < stops.length - 2 && x > stops[a + 1][0]) a++;
      const [x0, c0] = stops[a], [x1, c1] = stops[a + 1], t = (x - x0) / (x1 - x0);
      for (let c = 0; c < 3; c++) p[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * t;
    }
    return p;
  })();

  // Scrolling spectrogram. Fixed, small internal resolution (CSS scales it to a fixed height),
  // capped at 30 fps, so it never grows and stays cheap on phones. Labels live in HTML.
  const WF_COLS = 360, WF_ROWS = 120;
  class Waterfall {
    constructor(canvas) {
      this.c = canvas; this.an = null; this.raf = 0; this.fmax = 17500; this.hi = 120; this.last = 0;
      canvas.width = WF_COLS; canvas.height = WF_ROWS;
      this.g = canvas.getContext('2d');
      this.col = this.g.createImageData(1, WF_ROWS);
      const wrap = document.createElement('div'); wrap.className = 'wf-wrap';
      canvas.parentNode.insertBefore(wrap, canvas); wrap.append(canvas);
      const pct = (f) => (1 - f / this.fmax) * 100 + '%';
      for (const khz of [2, 5, 10, 15]) {
        const l = document.createElement('span'); l.className = 'wf-label'; l.textContent = khz + ' kHz';
        l.style.top = pct(khz * 1000); wrap.append(l);
      }
      const band = document.createElement('span'); band.className = 'wf-band';
      band.style.top = pct(P.freqOf(P.U - 1));
      band.style.height = ((P.freqOf(P.U - 1) - P.freqOf(0)) / this.fmax) * 100 + '%';
      band.title = 'Data band'; wrap.append(band);
    }
    attach(analyser) {
      this.an = analyser;
      analyser.minDecibels = -120; analyser.maxDecibels = -10;
      this.bins = new Uint8Array(analyser.frequencyBinCount);
      this.hi = 120;
    }
    start() {
      this.g.fillStyle = '#05060a'; this.g.fillRect(0, 0, WF_COLS, WF_ROWS);
      const loop = (now) => {
        this.raf = requestAnimationFrame(loop);
        if (now - this.last < 32) return;
        this.last = now;
        this.draw();
      };
      cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(loop);
    }
    stop() { cancelAnimationFrame(this.raf); this.raf = 0; }
    draw() {
      if (!this.an) return;
      const g = this.g, H = WF_ROWS, W = WF_COLS;
      this.an.getByteFrequencyData(this.bins);
      // Auto-range: map a window below the (slowly decaying) peak onto the palette.
      let m = 0;
      for (let i = 0; i < this.bins.length; i++) if (this.bins[i] > m) m = this.bins[i];
      this.hi = Math.max(this.hi * 0.995, m, 60);
      const hi = this.hi, lo = hi - 130, span = hi - lo;
      g.drawImage(this.c, -1, 0);
      const binHz = this.an.context.sampleRate / this.an.fftSize, d = this.col.data;
      const fStep = this.fmax / H;
      for (let y = 0; y < H; y++) {
        // Peak of the bins covered by this row, so narrow tones don't vanish.
        const b0 = Math.floor(((H - 1 - y) * fStep) / binHz), b1 = Math.min(this.bins.length - 1, Math.floor(((H - y) * fStep) / binHz));
        let raw = 0;
        for (let k = b0; k <= b1; k++) if (this.bins[k] > raw) raw = this.bins[k];
        const v = Math.max(0, Math.min(255, Math.round(((raw - lo) / span) * 200)));
        const o = y * 4;
        d[o] = PALETTE[v * 3]; d[o + 1] = PALETTE[v * 3 + 1]; d[o + 2] = PALETTE[v * 3 + 2]; d[o + 3] = 255;
      }
      g.putImageData(this.col, W - 1, 0);
    }
  }

  // ---------------- small canvases ----------------
  function setupCanvas(c) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth || c.width, h = c.clientHeight || c.height;
    if (c.width !== Math.floor(w * dpr)) { c.width = Math.floor(w * dpr); c.height = Math.floor(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }

  function drawConstellation(points, modeId) {
    const c = $('consCanvas'); if (!c.offsetParent) return;
    const { g, w, h } = setupCanvas(c);
    g.fillStyle = '#05060a'; g.fillRect(0, 0, w, h);
    const R = 1.45, sx = (x) => ((x + R) / (2 * R)) * w, sy = (y) => ((R - y) / (2 * R)) * h;
    g.strokeStyle = '#1b2030'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    const mode = P.modes[modeId];
    // Ideal points.
    const bps = mode.bps;
    let ideal = [];
    if (bps === 1) ideal = [[1, 0], [-1, 0]];
    else {
      const L = 1 << (bps / 2), s = 1 / Math.sqrt((2 * (L * L - 1)) / 3);
      for (let i = 0; i < L; i++) for (let q = 0; q < L; q++) ideal.push([(2 * i - L + 1) * s, (2 * q - L + 1) * s]);
    }
    g.strokeStyle = 'rgba(167,139,250,.55)';
    const r = Math.max(2, Math.min(6, (w / (1 << Math.ceil(bps / 2))) * 0.18));
    for (const [x, y] of ideal) { g.beginPath(); g.arc(sx(x), sy(y), r, 0, 6.283); g.stroke(); }
    g.fillStyle = 'rgba(34,211,238,.55)';
    for (let i = 0; i < points.length; i += 2) g.fillRect(sx(points[i]) - 0.8, sy(points[i + 1]) - 0.8, 1.6, 1.6);
  }

  function drawSnr(bins) {
    const c = $('snrCanvas'); if (!c.offsetParent) return;
    const { g, w, h } = setupCanvas(c);
    g.fillStyle = '#05060a'; g.fillRect(0, 0, w, h);
    const max = 40, bw = w / bins.length;
    for (let i = 0; i < bins.length; i++) {
      const v = Math.max(0, Math.min(max, bins[i])), bh = (v / max) * (h - 18);
      const t = v / max;
      g.fillStyle = t > 0.45 ? '#22d3ee' : t > 0.25 ? '#a78bfa' : t > 0.12 ? '#fbbf24' : '#f87171';
      g.fillRect(i * bw + 1, h - 14 - bh, Math.max(1, bw - 2), bh);
    }
    g.fillStyle = '#8b93a8'; g.font = '10px ui-monospace, monospace';
    g.fillText('1 kHz', 2, h - 3); g.fillText('8 kHz', w / 2 - 14, h - 3); g.fillText('16 kHz', w - 38, h - 3);
    g.fillText('40 dB', 2, 10);
  }

  function drawSpark(c, vals) {
    const { g, w, h } = setupCanvas(c);
    g.clearRect(0, 0, w, h);
    if (vals.length < 2) return;
    const max = Math.max(...vals, 1);
    g.strokeStyle = '#22d3ee'; g.lineWidth = 1.5; g.beginPath();
    vals.forEach((v, i) => { const x = (i / (vals.length - 1)) * w, y = h - 2 - (v / max) * (h - 4); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  }

  function drawGrid(c, known, K, done) {
    const w = c.clientWidth || 300;
    const cols = Math.max(8, Math.min(K, Math.floor(w / (K > 2000 ? 4 : K > 500 ? 7 : 12))));
    const rows = Math.ceil(K / cols), cell = w / cols;
    const hCss = Math.min(window.innerWidth < 640 ? 84 : 150, Math.max(14, rows * cell));
    c.style.height = hCss + 'px';
    const { g } = setupCanvas(c);
    const ch = hCss / rows;
    g.clearRect(0, 0, w, hCss);
    const gap = cell > 6 ? 1.5 : 0.5;
    for (let i = 0; i < K; i++) {
      const x = (i % cols) * cell, y = Math.floor(i / cols) * ch;
      g.fillStyle = known[i] ? (done ? '#34d399' : '#22d3ee') : '#1a1f2d';
      g.fillRect(x + gap / 2, y + gap / 2, cell - gap, ch - gap);
    }
  }

  // ================= SEND =================
  const send = { files: [], imgQ: LS.get('imgQ', 'medium'), mode: Math.min(LS.get('mode', 2), P.modes.length - 1), player: null, wf: new Waterfall($('txWaterfall')), active: false, est: 0 };
  const IMG_Q = { large: [2048, 0.82], medium: [1280, 0.72], small: [720, 0.6] };

  $('drop').onclick = () => $('fileInput').click();
  $('drop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } };
  $('fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  ['dragenter', 'dragover'].forEach((t) => $('drop').addEventListener(t, (e) => { e.preventDefault(); $('drop').classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => $('drop').addEventListener(t, (e) => { e.preventDefault(); $('drop').classList.remove('over'); }));
  $('drop').addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  document.addEventListener('paste', (e) => {
    if (current !== 'send' || send.active) return;
    const fs = [...(e.clipboardData && e.clipboardData.files || [])];
    if (fs.length) { e.preventDefault(); addFiles(fs); }
  });
  $('msgInput').oninput = () => updatePayload();
  $('volInput').oninput = () => {
    $('volVal').textContent = $('volInput').value + '%';
    if (send.player) send.player.setVolume($('volInput').value / 100);
    if (test.player) test.player.setVolume($('volInput').value / 100);
  };
  $('imgSeg').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.q === send.imgQ);
    b.onclick = () => {
      send.imgQ = b.dataset.q; LS.set('imgQ', send.imgQ);
      $('imgSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      updatePayload();
    };
  });

  function isShrinkable(f) { return /^image\/(jpeg|png|webp|bmp|heic|heif|avif)$/i.test(f.type); }

  function addFiles(list) {
    for (const file of list) {
      send.files.push({ file, name: file.name || 'file', type: file.type || 'application/octet-stream', size: file.size, img: isShrinkable(file), thumb: file.type.startsWith('image/') ? URL.createObjectURL(file) : null, variants: {} });
    }
    renderFiles(); updatePayload();
  }

  function renderFiles() {
    const box = $('fileList'); box.innerHTML = '';
    send.files.forEach((f, i) => {
      const row = el('div', 'file');
      const th = el('div', 'th', f.thumb ? '' : esc((f.name.split('.').pop() || '').slice(0, 4)));
      if (f.thumb) th.style.backgroundImage = `url("${f.thumb}")`;
      const v = f.img && send.imgQ !== 'original' ? f.variants[send.imgQ] : null;
      const meta = el('div', 'meta', `<div class="nm">${esc(f.name)}</div><div class="sz">${fmtBytes(f.size)}${v ? ` → ${fmtBytes(v.data.length)}` : ''}</div>`);
      const rm = el('button', 'rm', '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>');
      rm.setAttribute('aria-label', 'Remove ' + f.name);
      rm.onclick = () => { if (f.thumb) URL.revokeObjectURL(f.thumb); send.files.splice(i, 1); renderFiles(); updatePayload(); };
      row.append(th, meta, rm);
      box.append(row);
    });
    $('imgOpt').hidden = !send.files.some((f) => f.img);
  }

  async function shrink(f, q) {
    const [maxDim, quality] = IMG_Q[q];
    let bmp;
    try { bmp = await createImageBitmap(f.file, { imageOrientation: 'from-image' }); } catch (e) { return null; }
    const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    let blob = await new Promise((r) => c.toBlob(r, 'image/webp', quality));
    if (!blob || blob.type !== 'image/webp') blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
    if (!blob) return null;
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    return { data: new Uint8Array(await blob.arrayBuffer()), type: blob.type, name: f.name.replace(/\.[^.]+$/, '') + '.' + ext };
  }

  async function fileData(f) {
    if (f.img && send.imgQ !== 'original') {
      if (!f.variants[send.imgQ]) f.variants[send.imgQ] = (await shrink(f, send.imgQ)) || 'orig';
      const v = f.variants[send.imgQ];
      if (v !== 'orig' && v.data.length < f.size) return v;
    }
    return { data: new Uint8Array(await f.file.arrayBuffer()), type: f.type, name: f.name };
  }

  let payloadSeq = 0;
  async function updatePayload() {
    const seq = ++payloadSeq;
    const msg = $('msgInput').value;
    let bytes = new TextEncoder().encode(msg).length;
    for (const f of send.files) {
      if (f.img && send.imgQ !== 'original') {
        if (!f.variants[send.imgQ]) {
          $('payloadInfo').textContent = 'Optimizing photos…';
          f.variants[send.imgQ] = (await shrink(f, send.imgQ)) || 'orig';
          if (seq !== payloadSeq) return;
          renderFiles();
        }
        const v = f.variants[send.imgQ];
        bytes += v !== 'orig' && v.data.length < f.size ? v.data.length : f.size;
      } else bytes += f.size;
    }
    if (seq !== payloadSeq) return;
    const has = send.files.length > 0 || msg.trim().length > 0;
    send.est = has ? bytes + 120 + send.files.length * 40 : 0;
    $('payloadInfo').textContent = !has ? 'Nothing selected yet' : send.est > MAX_SEND ? `${fmtBytes(send.est)}: too big (limit ${fmtBytes(MAX_SEND)})` : `${fmtBytes(send.est)} to send`;
    $('txBtn').disabled = !has;
    renderModes();
  }

  const MAX_SEND = 5 * 1024 * 1024;   // receivers cap transfers at 40k blocks (~5.2 MB)

  function etaFor(mode, bytes) {
    if (!bytes) return null;
    const K = Math.ceil(bytes / mode.blockSize);
    return Math.ceil((K * 1.03) / mode.cws) * mode.frameSeconds;
  }

  function renderModes() {
    const box = $('modeList'); box.innerHTML = '';
    const reco = LS.get('reco', null);
    P.modes.forEach((m) => {
      const b = el('button', 'mode' + (m.id === send.mode ? ' on' : ''));
      const eta = etaFor(m, send.est);
      const bars = Array.from({ length: P.modes.length }, (_, i) => `<i class="${i <= m.id ? 'f' : ''}" style="height:${4 + i * 3}px"></i>`).join('');
      b.innerHTML = `<span class="mn">${m.name}${reco === m.id ? '<span class="badge">TESTED</span>' : ''}</span><span class="mk">${m.kbps.toFixed(m.kbps < 10 ? 1 : 0)} kbps</span>` +
        `<span class="mt">${eta ? '≈ ' + fmtDur(eta) : MODE_HINT[m.key]}</span><span class="mx">${m.mod} · ${eta ? MODE_HINT[m.key] : m.rate}</span>` +
        `<span class="bars">${bars}</span>`;
      b.title = `${m.mod}, LDPC rate ${m.rate}. Works best: ${MODE_HINT[m.key]}`;
      b.onclick = () => { send.mode = m.id; LS.set('mode', m.id); renderModes(); };
      box.append(b);
    });
  }

  $('txBtn').onclick = startTx;
  $('txStop').onclick = () => stopTx();

  async function startTx() {
    if (send.active) return;
    const player = new Player();             // must be created inside the click for autoplay rules
    player.setVolume($('volInput').value / 100);
    send.player = player;
    send.active = true;
    $('txBtn').disabled = true;
    try {
      const files = [];
      for (const f of send.files) files.push(await fileData(f));
      const msg = $('msgInput').value;
      if (msg.trim()) files.push({ name: 'message.txt', type: 'text/plain', data: new TextEncoder().encode(msg), message: true });
      const pass = $('passInput').value;
      const bytes = await SD.container.pack(files, { passphrase: pass || null });
      if (!send.active) return;
      if (bytes.length > MAX_SEND) {
        toast(`That's ${fmtBytes(bytes.length)} after compression. The limit is ${fmtBytes(MAX_SEND)} (it would take too long over sound). Try smaller photos.`, 6000);
        stopTx();
        return;
      }
      const mode = P.modes[send.mode];
      send.session = randSession();
      send.K = 0; send.frames = 0; send.req = false; send.bytes = bytes.length;
      const names = files.map((f) => f.name);
      $('txWhat').textContent = `${names.length > 1 ? names.length + ' items' : names[0]} · ${fmtBytes(bytes.length)}${pass ? ' · encrypted' : ''}`;
      $('txRate').innerHTML = fmtKbps(mode.kbps);
      $('txPackets').textContent = '0';
      $('txBar').style.width = '0%';
      $('sendCompose').hidden = true; $('sendLive').hidden = false;
      send.wf.attach(player.analyser); send.wf.start();
      keepAwake(true);
      handlers['tx-ready'] = (m) => {
        if (!send.active) return;
        send.K = m.K;
        $('txPass').textContent = fmtDur(Math.ceil(m.K / m.cws) * m.frameSeconds);
        pump();
      };
      handlers['tx-frame'] = (m) => {
        send.req = false;
        if (!send.active) return;
        send.player.enqueue(m.samples, m.info);
        send.frames++;
        pump();
      };
      engine().postMessage({ cmd: 'tx-start', data: bytes.buffer, mode: mode.id, session: send.session, amp: 0.3 }, [bytes.buffer]);
      send.timer = setInterval(() => { pump(); txTick(); }, 200);
    } catch (e) {
      console.error(e);
      toast('Could not prepare transfer: ' + e.message);
      stopTx();
    }
  }

  function pump() {
    if (!send.active || send.req || !send.K) return;
    if (send.player.ahead() < 1.8) { send.req = true; engine().postMessage({ cmd: 'tx-frames', count: 1 }); }
  }

  function txTick() {
    const pl = send.player; if (!pl) return;
    const now = pl.now();
    const first = pl.sched[0];
    if (!first) return;
    $('txElapsed').textContent = fmtClock(now - first.start);
    let sent = 0;
    for (const s of pl.sched) { if (s.end <= now) sent += s.info.cws; else if (s.start < now) sent += Math.floor(s.info.cws * (now - s.start) / (s.end - s.start)); }
    $('txPackets').textContent = sent.toLocaleString();
    const pct = send.K ? (sent / send.K) * 100 : 0;
    $('txBar').style.width = Math.min(100, pct) + '%';
    $('txHint').textContent = pct >= 100
      ? `Every block has gone out ${Math.floor(pct / 100)}× · still sending repair packets until you stop. The receiver usually finishes around 100–110%.`
      : `Sent ${pct.toFixed(0)}% of one full pass. Receivers can start listening at any moment.`;
  }

  function stopTx() {
    if (!send.active && !send.player) return;
    send.active = false;
    clearInterval(send.timer);
    send.wf.stop();
    if (send.player) send.player.stop();
    send.player = null;
    if (worker) worker.postMessage({ cmd: 'tx-stop' });
    keepAwake(false);
    $('sendCompose').hidden = false; $('sendLive').hidden = true;
    $('txBtn').disabled = !(send.files.length || $('msgInput').value.trim());
  }

  // ================= SPEED TEST (sender side) =================
  const test = { player: null, active: false, wf: new Waterfall($('testWaterfall')) };
  $('testPlayBtn').onclick = startTestTx;
  $('testMeasureBtn').onclick = () => { location.hash = 'receive'; setTimeout(() => { if (!recv.active) startRx(); }, 50); };
  $('testStop').onclick = stopTestTx;

  // Speed-test button text follows the mode table (2 frames per mode).
  $('testPlayDesc').textContent = `This device sends all ${P.modes.length} speeds in turn (about ${Math.round(P.modes.reduce((a, m) => a + 2 * m.frameSeconds, 0))} seconds).`;

  function renderTestSteps(curStep, doneUpTo) {
    const box = $('testSteps'); box.innerHTML = '';
    P.modes.forEach((m, i) => {
      box.append(el('div', 'tstep' + (i === curStep ? ' cur' : i < doneUpTo ? ' done' : ''), `<b>${m.name}</b><br>${m.kbps.toFixed(m.kbps < 10 ? 1 : 0)} kbps`));
    });
  }

  function startTestTx() {
    if (test.active) return;
    const player = new Player();
    player.setVolume($('volInput').value / 100);
    test.player = player; test.active = true; test.req = false; test.ended = false; test.ready = false;
    $('testTx').hidden = false;
    renderTestSteps(-1, 0);
    test.wf.attach(player.analyser); test.wf.start();
    keepAwake(true);
    handlers['tx-ready'] = (m) => { test.ready = true; $('testTxWhat').textContent = `≈ ${fmtDur(m.seconds)}`; testPump(); };
    handlers['tx-frame'] = (m) => { test.req = false; if (!test.active) return; test.player.enqueue(m.samples, m.info); testPump(); };
    handlers['tx-end'] = () => { test.req = false; test.ended = true; };
    engine().postMessage({ cmd: 'tx-start', test: true, session: randSession(), amp: 0.3 });
    test.timer = setInterval(() => {
      testPump();
      const pl = test.player; if (!pl) return;
      const now = pl.now();
      const cur = pl.sched.find((s) => s.start <= now && s.end > now);
      const last = pl.sched[pl.sched.length - 1];
      if (cur) renderTestSteps(cur.info.step, cur.info.step);
      if (test.ended && last && now > last.end + 0.3) {
        renderTestSteps(-1, 99);
        toast('Test signal finished. Results are on the measuring device.');
        stopTestTx(true);
      }
    }, 200);
  }
  function testPump() {
    if (!test.active || test.req || test.ended || !test.ready) return;
    if (test.player.ahead() < 1.8) { test.req = true; engine().postMessage({ cmd: 'tx-frames', count: 1 }); }
  }
  function stopTestTx(keepSteps) {
    if (!test.active) return;
    test.active = false;
    clearInterval(test.timer);
    test.wf.stop();
    if (test.player) test.player.stop();
    test.player = null;
    if (worker) worker.postMessage({ cmd: 'tx-stop' });
    keepAwake(false);
    if (keepSteps !== true) $('testTx').hidden = true;
  }

  // ================= RECEIVE =================
  const recv = { active: false, wf: new Waterfall($('rxWaterfall')), transfers: new Map(), ignored: new Set(), speed: [], spark: [], frames: 0, okFrames: 0, test: null, lastFrameT: -1 };

  $('rxBtn').onclick = startRx;
  $('rxStop').onclick = () => stopRx();

  async function startRx() {
    if (recv.active) return;
    $('rxErr').hidden = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx;
    try {
      ctx = new AC();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('Microphone needs a secure page (https:// or localhost).'), { name: 'Insecure' });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, voiceIsolation: false },
      });
      await ctx.resume();
      recv.ctx = ctx; recv.stream = stream;
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0;
      src.connect(an);
      const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
      recv.rec = { buf: new Float32Array(Math.round(ctx.sampleRate * 30)), pos: 0, filled: false, rate: ctx.sampleRate };
      const toEngine = (samples) => {
        if (!recv.active) return;
        const r = recv.rec, n = samples.length;
        for (let i = 0; i < n; i++) { r.buf[r.pos++] = samples[i]; if (r.pos === r.buf.length) { r.pos = 0; r.filled = true; } }
        engine().postMessage({ cmd: 'rx-audio', samples }, [samples.buffer]);
      };
      let worklet = false;
      if (ctx.audioWorklet) {
        try {
          await ctx.audioWorklet.addModule(workletURL());
          worklet = true;
        } catch (e) {
          console.warn('AudioWorklet unavailable here (e.g. opened as a local file), using ScriptProcessor', e);
        }
      }
      if (worklet) {
        const node = new AudioWorkletNode(ctx, 'sd-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
        node.port.onmessage = (e) => toEngine(e.data);
        src.connect(node); node.connect(sink);
        recv.node = node;
      } else {
        const sp = ctx.createScriptProcessor(4096, 1, 1);
        sp.onaudioprocess = (e) => toEngine(new Float32Array(e.inputBuffer.getChannelData(0)));
        src.connect(sp); sp.connect(sink);
        recv.node = sp;
      }
      engine().postMessage({ cmd: 'rx-start', rate: ctx.sampleRate });
      recv.active = true;
      recv.speed = []; recv.spark = []; recv.frames = 0; recv.okFrames = 0; recv.lastFrameT = -1;
      $('recvIdle').hidden = true; $('recvLive').hidden = false;
      recv.wf.attach(an); recv.wf.start();
      setRxState('idle', 'Listening…');
      keepAwake(true);
      const track = stream.getAudioTracks()[0];
      const st = track && track.getSettings ? track.getSettings() : {};
      $('diagText').textContent = `Mic at ${ctx.sampleRate} Hz${st.echoCancellation ? ' · echo cancellation could not be disabled' : ''}${st.autoGainControl ? ' · auto gain on' : ''}`;
      recv.tick = setInterval(rxTick, 500);
    } catch (e) {
      console.error(e);
      try { if (ctx) ctx.close(); } catch (x) { /* ignore */ }
      const msg = e.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in the browser settings and try again.'
        : e.name === 'Insecure' ? e.message
        : e.name === 'NotFoundError' ? 'No microphone found on this device.'
        : 'Could not start the microphone: ' + e.message;
      $('rxErr').textContent = msg; $('rxErr').hidden = false;
    }
  }

  function stopRx() {
    if (!recv.active) return;
    recv.active = false;
    clearInterval(recv.tick);
    recv.wf.stop();
    try { recv.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { recv.ctx.close(); } catch (e) { /* ignore */ }
    if (worker) worker.postMessage({ cmd: 'rx-stop' });
    keepAwake(false);
    $('recvIdle').hidden = false; $('recvLive').hidden = true;
  }

  // Debug: save the last 30 s of raw microphone audio as a WAV (for offline analysis).
  $('recBtn').onclick = () => {
    const r = recv.rec; if (!r) return;
    const n = r.filled ? r.buf.length : r.pos;
    const pcm = new DataView(new ArrayBuffer(44 + n * 2));
    const w = (o, str) => { for (let i = 0; i < str.length; i++) pcm.setUint8(o + i, str.charCodeAt(i)); };
    w(0, 'RIFF'); pcm.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); pcm.setUint32(16, 16, true); pcm.setUint16(20, 1, true);
    pcm.setUint16(22, 1, true); pcm.setUint32(24, r.rate, true); pcm.setUint32(28, r.rate * 2, true); pcm.setUint16(32, 2, true);
    pcm.setUint16(34, 16, true); w(36, 'data'); pcm.setUint32(40, n * 2, true);
    const start = r.filled ? r.pos : 0;
    for (let i = 0; i < n; i++) {
      const v = r.buf[(start + i) % r.buf.length];
      pcm.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(v * 32767))), true);
    }
    const a = el('a'); a.href = URL.createObjectURL(new Blob([pcm], { type: 'audio/wav' }));
    a.download = `sonicdrop-mic-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.wav`;
    document.body.append(a); a.click(); a.remove();
  };

  function setRxState(kind, text) {
    const p = $('rxPill');
    p.className = 'pill ' + kind;
    $('rxState').textContent = text;
  }

  handlers['rx-status'] = (m) => {
    if (!recv.active) return;
    recv.t = m.t;
    const db = 20 * Math.log10(m.level + 1e-9);
    $('rxLevel').style.width = Math.max(0, Math.min(100, ((db + 70) / 60) * 100)) + '%';
    if (m.busy) setRxState('lock', 'Receiving frame…');
    else if (recv.lastFrameT > 0 && m.t - recv.lastFrameT < 3) { /* keep locked label */ }
    else setRxState('idle', db < -62 ? 'Listening… (very quiet, check the mic)' : 'Listening…');
  };
  handlers['rx-header'] = (m) => {
    const mode = P.modes[m.header.mode];
    setRxState('lock', `Locked · ${mode.name}${m.header.flags & 1 ? ' (speed test)' : ''}`);
    $('rxMode').innerHTML = `${mode.name}<small> ${mode.mod}</small>`;
  };
  handlers['rx-syncfail'] = () => { /* weak sync: ignore quietly */ };

  function frameStats(m) {
    const s = m.stats, mode = P.modes[s.mode];
    recv.frames++;
    if (s.ok === s.total) recv.okFrames++;
    recv.lastFrameT = m.t;
    $('rxFrames').innerHTML = `${recv.okFrames}<small>/${recv.frames}</small>`;
    const q = s.snr < 6 ? 'weak' : s.snr < 12 ? 'fair' : s.snr < 18 ? 'good' : 'excellent';
    $('rxSnr').innerHTML = `${s.snr.toFixed(0)}<small> dB ${q}</small>`;
    let best = 0;
    MODE_SNR.forEach((need, i) => { if (i < P.modes.length && s.snr >= need + 1) best = i; });
    $('diagText').textContent = `${mode.name} · ${mode.mod} rate ${mode.rate} · ${s.ok}/${s.total} codewords OK · ` +
      `pre-FEC errors ${s.rawBer === null ? '–' : (s.rawBer * 100).toFixed(2) + '%'} · clock offset ${s.ppm.toFixed(0)} ppm · ` +
      `this link looks good for up to ${P.modes[best].name}`;
    drawConstellation(s.constellation, s.mode);
    drawSnr(s.snrBins);
  }

  function pushSpeed(t, bytes) {
    recv.speed.push({ t, bytes });
    while (recv.speed.length && t - recv.speed[0].t > 8) recv.speed.shift();
  }
  function rxTick() {
    if (!recv.active) return;
    const t = recv.t || 0;
    while (recv.speed.length && t - recv.speed[0].t > 8) recv.speed.shift();
    let kbps = 0;
    if (recv.speed.length && t - recv.lastFrameT < 4) {
      const span = Math.max(2, t - recv.speed[0].t + 1);
      kbps = recv.speed.reduce((a, s) => a + s.bytes, 0) * 8 / span / 1000;
    }
    $('rxSpeed').innerHTML = kbps ? fmtKbps(kbps) : '–';
    recv.spark.push(kbps); if (recv.spark.length > 40) recv.spark.shift();
    drawSpark($('rxSpark'), recv.spark);
  }

  // ---- transfers ----
  const MAX_CARDS = 6;
  function removeTransfer(session) {
    const T = recv.transfers.get(session);
    if (!T) return;
    T.urls.forEach((u) => URL.revokeObjectURL(u));
    T.card.remove();
    recv.transfers.delete(session);
    recv.ignored.add(session);   // late frames of a deleted transfer are ignored
    updateXferBar();
  }
  function updateXferBar() {
    const n = recv.transfers.size, done = [...recv.transfers.values()].filter((T) => T.done).length;
    $('xferBar').hidden = n === 0;
    $('xferCount').textContent = `${done} received${n > done ? ` · ${n - done} in progress` : ''}`;
  }
  $('clearAll').onclick = () => {
    const anyDone = [...recv.transfers.values()].some((T) => T.done);
    if (anyDone && !confirm('Remove all received files from this page? Download anything you want to keep first.')) return;
    [...recv.transfers.keys()].forEach(removeTransfer);
    toast('Cleared');
  };
  handlers['rx-new'] = (m) => {
    if (recv.ignored.has(m.session)) return;
    const T = { session: m.session, K: m.K, mode: m.mode, blockSize: m.blockSize, startT: m.t, meta: null, peek: null, done: false, known: new Uint8Array(m.K), rank: 0, bytes: 0, urls: [] };
    // Older transfers collapse to a compact row; only the last few are kept.
    for (const old of recv.transfers.values()) {
      old.card.classList.add('compact');
      const tg = old.card.querySelector('.xfer-toggle'); tg.hidden = false; tg.textContent = 'Show';
    }
    recv.transfers.set(m.session, T);
    while (recv.transfers.size > MAX_CARDS) removeTransfer(recv.transfers.keys().next().value);
    const card = el('div', 'card xfer');
    card.innerHTML = `<div class="xfer-head"><div class="xfer-ic"><svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 4v12M7 11l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>` +
      `<div style="min-width:0;flex:1"><div class="xfer-title">Incoming transfer</div><div class="xfer-sub">starting…</div></div>` +
      `<button class="btn xfer-toggle" hidden>Show</button>` +
      `<button class="icon-btn xfer-del" aria-label="Delete" title="Delete"><svg viewBox="0 0 24 24" width="17" height="17"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>` +
      `<div class="bar"><div class="bar-fill"></div></div><canvas class="grid-canvas"></canvas><div class="xfer-body"></div>`;
    card.querySelector('.xfer-toggle').onclick = () => {
      card.classList.toggle('compact');
      card.querySelector('.xfer-toggle').textContent = card.classList.contains('compact') ? 'Show' : 'Hide';
    };
    card.querySelector('.xfer-del').onclick = () => removeTransfer(m.session);
    T.card = card;
    $('xferList').prepend(card);
    updateXferBar();
    toast('Incoming transfer detected');
  };

  handlers['rx-frame'] = (m) => {
    if (!recv.active) return;
    frameStats(m);
    const T = recv.transfers.get(m.session);
    if (!T) return;
    pushSpeed(m.t, m.progress.gainedBytes);
    T.known = m.progress.known; T.rank = m.progress.rank; T.lastT = m.t;
    T.bytes = T.rank * T.blockSize;
    if (m.head && !T.meta) {
      const pk = SD.container.peek(m.head);
      if (pk && !pk.bad) {
        T.peek = pk;
        if (pk.meta) T.meta = pk.meta;
      }
    }
    renderTransfer(T);
  };

  function transferTitle(T) {
    if (T.meta) {
      const f = T.meta.f;
      if (f.length === 1) return f[0].m ? 'Message' : f[0].n;
      return `${f.length} items · ${f.filter((x) => !x.m).map((x) => x.n).slice(0, 2).join(', ')}${f.length > 2 ? '…' : ''}`;
    }
    if (T.peek && T.peek.encrypted) return '🔒 Encrypted transfer';
    return 'Incoming transfer';
  }

  function renderTransfer(T) {
    const card = T.card, mode = P.modes[T.mode];
    card.querySelector('.xfer-title').textContent = transferTitle(T);
    const total = T.peek ? T.peek.total : T.K * T.blockSize;
    const pct = Math.min(100, (T.rank / T.K) * 100);
    card.querySelector('.bar-fill').style.width = pct + '%';
    if (!T.done) {
      const elapsed = (T.lastT || T.startT) - T.startT + mode.frameSeconds;
      const rate = T.rank / Math.max(elapsed, mode.frameSeconds);   // blocks per second
      const eta = rate > 0 ? (T.K - T.rank) / rate : Infinity;
      card.querySelector('.xfer-sub').textContent = `${pct.toFixed(0)}% · ${fmtBytes(Math.min(total, T.bytes))} of ${fmtBytes(total)} · ${mode.name} · ETA ${fmtDur(eta)}`;
    }
    drawGrid(card.querySelector('.grid-canvas'), T.known, T.K, T.done);
  }

  handlers['rx-done'] = async (m) => {
    const T = recv.transfers.get(m.session);
    if (!T) return;
    T.done = true; T.data = new Uint8Array(m.data); T.doneT = m.t;
    T.known = new Uint8Array(T.K).fill(1); T.rank = T.K;
    renderTransfer(T);
    const secs = m.t - T.startT + P.modes[T.mode].frameSeconds;
    T.avgKbps = (T.data.length * 8) / secs / 1000;
    T.card.querySelector('.xfer-ic').classList.add('done');
    await openTransfer(T, null);
  };

  async function openTransfer(T, pass) {
    const body = T.card.querySelector('.xfer-body');
    const total = T.peek ? T.peek.total : T.data.length;
    const bytes = T.data.subarray(0, total);
    let res;
    try {
      res = await SD.container.unpack(bytes, pass);
    } catch (e) {
      if (e.code === 'PASS') {
        T.card.querySelector('.xfer-title').textContent = '🔒 Encrypted transfer';
        T.card.querySelector('.xfer-sub').textContent = `Received ${fmtBytes(total)} · enter the passphrase to unlock`;
        body.innerHTML = `<div class="passbox"><input type="password" placeholder="Passphrase" autocomplete="off"><button class="btn primary">Unlock</button></div>${pass ? '<p class="err">Wrong passphrase, try again.</p>' : ''}`;
        const inp = body.querySelector('input');
        const go = () => openTransfer(T, inp.value);
        body.querySelector('button').onclick = go;
        inp.onkeydown = (ev) => { if (ev.key === 'Enter') go(); };
        inp.focus();
        return;
      }
      body.innerHTML = `<p class="err">Could not open the transfer: ${esc(e.message)}</p>`;
      return;
    }
    T.meta = { f: res.files.map((f) => ({ n: f.name, t: f.type, s: f.data.length, m: f.message ? 1 : 0 })) };
    T.card.querySelector('.xfer-title').textContent = transferTitle(T);
    T.card.querySelector('.xfer-sub').textContent = `${fmtBytes(total)} in ${fmtDur(T.doneT - T.startT + P.modes[T.mode].frameSeconds)} · average ${T.avgKbps.toFixed(1)} kbps${res.encrypted ? ' · decrypted' : ''}`;
    body.innerHTML = '';
    if (res.verified) body.append(el('div', 'verified', '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 12l5 5 9-10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg> SHA-256 verified · bit-exact copy'));
    else body.append(el('p', 'err', 'Integrity check failed: the data may be corrupted.'));
    const list = el('div', 'xfer-files');
    for (const f of res.files) {
      if (f.message) {
        const text = new TextDecoder().decode(f.data);
        const box = el('div', 'preview-msg'); box.textContent = text;
        const acts = el('div', 'acts'); acts.style.marginTop = '8px'; acts.style.display = 'flex'; acts.style.gap = '8px';
        const cp = el('button', 'btn', 'Copy');
        cp.onclick = () => { navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed')); };
        acts.append(cp);
        if (/^https?:\/\/\S+$/.test(text.trim())) { const a = el('a', 'btn', 'Open link'); a.href = text.trim(); a.target = '_blank'; a.rel = 'noopener noreferrer'; acts.append(a); }
        list.append(box, acts);
        continue;
      }
      const type = safeType(f.type);
      const blob = new Blob([f.data], { type });
      const url = URL.createObjectURL(blob);
      T.urls.push(url);
      const row = el('div', 'rfile');
      const isImg = /^image\//.test(type);
      const th = el('div', 'th', isImg ? '' : esc((f.name.split('.').pop() || 'file').slice(0, 4)));
      if (isImg) { th.style.backgroundImage = `url("${url}")`; th.classList.add('zoomable'); th.onclick = () => openLightbox(url, f.name); th.title = 'View full size'; }
      const meta = el('div', 'meta', `<div class="nm" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</div><div class="xfer-sub">${fmtBytes(f.data.length)} · ${esc(type)}</div>`);
      meta.style.minWidth = '0';
      const acts = el('div', 'acts');
      const dl = el('a', 'btn primary', 'Download'); dl.href = url; dl.download = f.name;
      acts.append(dl);
      if (navigator.canShare) {
        try {
          const file = new File([blob], f.name, { type });
          if (navigator.canShare({ files: [file] })) {
            const sh = el('button', 'btn', 'Share');
            sh.onclick = () => navigator.share({ files: [file] }).catch(() => {});
            acts.append(sh);
          }
        } catch (e) { /* File constructor unsupported */ }
      }
      row.append(th, meta, acts);
      list.append(row);
      if (isImg && res.files.length <= 3) {
        const img = el('img', 'preview-img zoomable'); img.src = url; img.alt = f.name; img.title = 'Tap to view full size';
        img.onclick = () => openLightbox(url, f.name);
        list.append(img);
      }
      if (type === 'application/pdf') { const a = el('a', 'btn', 'Open PDF'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; acts.prepend(a); }
    }
    body.append(list);
    updateXferBar();
    const tg = T.card.querySelector('.xfer-toggle');
    tg.hidden = false; tg.textContent = T.card.classList.contains('compact') ? 'Show' : 'Hide';
    // Bring the finished files into view only if they are below the screen; the monitor stays put otherwise.
    const rect = T.card.getBoundingClientRect();
    if (rect.top > window.innerHeight - 160) T.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('Transfer complete ✓');
    if (navigator.vibrate) try { navigator.vibrate([60, 40, 60]); } catch (e) { /* ignore */ }
  }

  // ---- full-screen image viewer ----
  const lb = { open: false, pushed: false };
  function openLightbox(url, name) {
    const box = $('lightbox'), img = $('lbImg');
    img.src = url; img.alt = name;
    box.classList.remove('zoomed');
    $('lbName').textContent = name;
    $('lbDl').href = url; $('lbDl').download = name;
    box.hidden = false; lb.open = true;
    document.body.style.overflow = 'hidden';
    try { history.pushState({ lightbox: 1 }, ''); lb.pushed = true; } catch (e) { lb.pushed = false; }
  }
  function closeLightbox(fromHistory) {
    if (!lb.open) return;
    lb.open = false;
    $('lightbox').hidden = true;
    $('lbImg').removeAttribute('src');
    document.body.style.overflow = '';
    if (!fromHistory && lb.pushed) { lb.pushed = false; history.back(); }
    lb.pushed = false;
  }
  $('lbClose').onclick = () => closeLightbox();
  $('lightbox').onclick = (e) => { if (e.target === $('lightbox') || e.target === $('lbScroll')) closeLightbox(); };
  // Tap/click toggles between fit-to-screen and full resolution (scroll to pan).
  $('lbImg').onclick = (e) => {
    const box = $('lightbox'), img = $('lbImg'), sc = $('lbScroll');
    const r = img.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    box.classList.toggle('zoomed');
    if (box.classList.contains('zoomed')) {
      sc.scrollLeft = fx * img.naturalWidth - sc.clientWidth / 2;
      sc.scrollTop = fy * img.naturalHeight - sc.clientHeight / 2;
    }
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && lb.open) closeLightbox(); });
  window.addEventListener('popstate', () => { if (lb.open) closeLightbox(true); });

  // ---- speed test (measuring side) ----
  handlers['rx-test'] = (m) => {
    if (!recv.active || !(m.step >= 0 && m.step < P.modes.length)) return;
    frameStats(m);
    const s = m.stats, mode = P.modes[s.mode];
    if (!recv.test || recv.test.session !== m.session) {
      recv.test = { session: m.session, rows: P.modes.map(() => ({ ok: 0, total: 0, frames: 0, snr: [] })), maxStep: -1 };
      $('testCard').hidden = false;
      $('testCard').open = true;
      $('testReco').hidden = true;
    }
    const tt = recv.test;
    const row = tt.rows[m.step];
    row.ok += s.ok; row.total += s.total; row.frames++; row.snr.push(s.snr);
    tt.maxStep = Math.max(tt.maxStep, m.step);
    pushSpeed(m.t, s.ok * mode.blockSize);
    renderTest(m.step);
    clearTimeout(tt.timer);
    tt.timer = setTimeout(() => finishTest(), (mode.frameSeconds * 2 + 1.5) * 1000);
    if (m.step === m.steps - 1 && row.frames >= 2) finishTest();
  };

  function renderTest(curStep) {
    const tt = recv.test, box = $('testTable');
    box.innerHTML = '';
    if (!tt.final) $('testProg').textContent = `measuring ${P.modes[curStep] ? P.modes[curStep].name : ''}…`;
    P.modes.forEach((m, i) => {
      const r = tt.rows[i];
      const seen = r.frames > 0, missed = !seen && i < tt.maxStep;
      const ratio = r.total ? r.ok / r.total : 0;
      const cls = !seen ? (missed || tt.final ? ' fail' : '') : ratio >= 0.999 ? '' : ratio > 0 ? ' part' : ' fail';
      const snr = r.snr.length ? (r.snr.reduce((a, b) => a + b, 0) / r.snr.length).toFixed(0) + ' dB' : '';
      const status = !seen ? (missed || tt.final ? 'no signal' : '…') : ratio >= 0.999 ? `✓ ${m.kbps.toFixed(0)} kbps` : ratio > 0 ? `${(ratio * 100).toFixed(0)}% → ~${(m.kbps * ratio).toFixed(0)} kbps` : '✗ failed';
      const rowEl = el('div', 'trow' + cls + (i === curStep && !tt.final ? ' cur' : ''),
        `<span class="tn">${m.name}</span><span class="tk">${m.kbps.toFixed(m.kbps < 10 ? 1 : 0)} kbps</span>` +
        `<span class="tbar"><i style="width:${seen ? Math.max(4, ratio * 100) : 0}%"></i></span><span class="ts">${status}${snr ? ' · ' + snr : ''}</span>`);
      box.append(rowEl);
    });
  }

  function finishTest() {
    const tt = recv.test; if (!tt || tt.final) return;
    tt.final = true;
    clearTimeout(tt.timer);
    // Fountain coding turns partial success into speed: pick the highest delivered rate
    // (nominal x success), counting only modes that got at least half their codewords through.
    let best = -1, bestRate = 0;
    tt.rows.forEach((r, i) => {
      const ratio = r.total ? r.ok / r.total : 0, rate = P.modes[i].kbps * ratio;
      if (ratio >= 0.5 && rate > bestRate * 1.05) { best = i; bestRate = rate; }
    });
    renderTest(-1);
    const box = $('testReco'); box.hidden = false;
    if (best < 0) {
      box.innerHTML = 'No speed got through reliably. Move the devices closer, raise the sender volume and try again in a quieter spot.';
      $('testProg').textContent = 'no speed got through';
      return;
    }
    const m = P.modes[best];
    const r = tt.rows[best];
    // Fold to a one-line summary so the live monitor and files stay in view.
    $('testProg').innerHTML = `best: <b>${m.name}</b> · ~${bestRate.toFixed(0)} kbps`;
    $('testCard').open = false;
    const safe = r.ok < r.total && best > 0 ? P.modes[best - 1] : null;
    LS.set('reco', best);
    box.innerHTML = `Best speed for this link: <b>${m.name}</b> (${m.mod}), delivering about <b>${bestRate.toFixed(0)} kbps</b>. Select it on the <b>sending</b> device.` +
      (safe && r.ok / r.total < 0.8 ? ` If it struggles, use <b>${safe.name}</b>, or keep both devices still.` : '') +
      `<br><span class="muted small">A 1 MB file would take about ${fmtDur((1048576 * 8) / (bestRate * 1000))} at this speed.</span>`;
  }

  // ---------------- boot ----------------
  if (location.protocol === 'http:' && !/^(localhost|127\.|\[::1\])/.test(location.hostname)) {
    $('rxErr').textContent = 'Heads up: browsers only allow the microphone on https:// pages or localhost. Sending works here, but to receive, open the https version.';
    $('rxErr').hidden = false;
  }
  route();
  if ('serviceWorker' in navigator && location.protocol === 'https:' && window.SD_BUNDLE) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
  }
})();
