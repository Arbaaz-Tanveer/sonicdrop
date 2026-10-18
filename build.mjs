// Build: bundle everything into dist/index.html (one self-contained, offline file) plus a service
// worker, manifest, icon, link-preview image and Cloudflare _headers for when it is hosted.
// Usage: node build.mjs            (SITE_URL=https://example.com node build.mjs to set the public URL)
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const SITE_URL = (process.env.SITE_URL || 'https://sonicdrop.arbaazt.workers.dev').replace(/\/$/, '');
// Normalise line endings: browsers hash inline scripts after converting CRLF to LF, and Windows
// checkouts may add CRLF, so hash exactly what the browser will see.
const src = (p) => readFileSync(join(root, 'src', p), 'utf8').replace(/\r\n?/g, '\n');
const CORE = ['util', 'fft', 'ldpc', 'params', 'qam', 'modem', 'resampler', 'fountain'].map((f) => `core/${f}.js`);
const PAGE = ['core/util.js', 'core/params.js', 'core/container.js', 'app/app.js'];

const workerSrc = CORE.map(src).join('\n;\n') + '\n;\n' + src('engine-worker.js');
const workletSrc = src('capture-worklet.js');

const safeJSON = (s) => JSON.stringify(s).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
const scriptBodies = [
  `window.SD_BUNDLE = { worker: ${safeJSON(workerSrc)}, worklet: ${safeJSON(workletSrc)} };`,
  ...PAGE.map(src),
];
for (const b of scriptBodies) if (/<\/script/i.test(b)) throw new Error('script contains </script>');
const inline = scriptBodies.map((b) => `\n${b}\n`);
// Only these exact scripts may run: the CSP lists their SHA-256 hashes instead of 'unsafe-inline'.
const hashes = inline.map((b) => `'sha256-${createHash('sha256').update(b, 'utf8').digest('base64')}'`);

const CSP = [
  "default-src 'none'",
  `script-src ${hashes.join(' ')} blob:`,       // blob: = the DSP worker and mic worklet built from the bundle
  "worker-src 'self' blob:",
  "style-src 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src blob: data: mediastream:",
  "connect-src 'none'",                          // the page cannot talk to any server
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const DESC = 'Send files and messages between devices through sound. No internet, no pairing, no servers: everything runs in your browser.';
let html = src('index.html');
html = html.replace('<!--CSP-->', [
  `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
  '<link rel="manifest" href="manifest.webmanifest">',
  '<link rel="apple-touch-icon" href="icon.svg">',
  `<link rel="canonical" href="${SITE_URL}/">`,
  '<meta property="og:type" content="website">',
  '<meta property="og:title" content="SonicDrop: send files through sound">',
  `<meta property="og:description" content="${DESC}">`,
  `<meta property="og:url" content="${SITE_URL}/">`,
  `<meta property="og:image" content="${SITE_URL}/og.png">`,
  '<meta property="og:image:width" content="1200">',
  '<meta property="og:image:height" content="630">',
  '<meta name="twitter:card" content="summary_large_image">',
  '<meta name="twitter:creator" content="@ArbaazTanveer">',
  '<meta name="twitter:title" content="SonicDrop: send files through sound">',
  `<meta name="twitter:description" content="${DESC}">`,
  `<meta name="twitter:image" content="${SITE_URL}/og.png">`,
].join('\n'));
html = html.replace('<link rel="stylesheet" href="app/style.css">', () => `<style>\n${src('app/style.css')}\n</style>`);
html = html.replace(/<!--SCRIPTS-->[\s\S]*<!--\/SCRIPTS-->/, () => inline.map((b) => `<script>${b}</script>`).join('\n'));

const build = createHash('sha256').update(html).digest('hex').slice(0, 10);
html = html.replace('</title>', `</title>\n<meta name="build" content="${build}">`);

const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, 'index.html'), html);
if (existsSync(join(root, 'assets', 'og.png'))) copyFileSync(join(root, 'assets', 'og.png'), join(dist, 'og.png'));

const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="#07080d"/><path d="M14 32h6l5-12 7 24 6-18 4 6h8" fill="none" stroke="url(#g)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
writeFileSync(join(dist, 'icon.svg'), icon);
writeFileSync(join(dist, 'manifest.webmanifest'), JSON.stringify({
  name: 'SonicDrop', short_name: 'SonicDrop', description: DESC,
  start_url: './', display: 'standalone', background_color: '#07080d', theme_color: '#07080d',
  icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
}, null, 2));
writeFileSync(join(dist, 'sw.js'), `// Offline support: network first, cache fallback. Same-origin GETs only.
const CACHE = 'sonicdrop-${build}';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))));
});
`);
// Cloudflare static-assets headers (also honoured by most static hosts that read _headers).
writeFileSync(join(dist, '_headers'), `/*
  Content-Security-Policy: ${CSP}; frame-ancestors 'none'; upgrade-insecure-requests
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: microphone=(self), camera=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), midi=(), browsing-topics=()
  Cross-Origin-Opener-Policy: same-origin
  Strict-Transport-Security: max-age=31536000
/
  Cache-Control: public, max-age=0, must-revalidate
/index.html
  Cache-Control: public, max-age=0, must-revalidate
/sw.js
  Cache-Control: no-cache
/og.png
  Cache-Control: public, max-age=86400
`);
console.log(`dist/index.html  ${(html.length / 1024).toFixed(0)} KB  build ${build}  (${hashes.length} script hashes, site ${SITE_URL})`);
