// Local server. Serves dist/ (or src/ with --dev).
//   node serve.mjs            http://localhost:8080
//   node serve.mjs --https    also https://<your-LAN-IP>:8443 so phones on the same Wi-Fi
//                             can use their microphone (self-signed cert, accept the warning once).
import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { dirname, join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dev = args.includes('--dev');
const wantHttps = args.includes('--https');
const port = +(args[args.indexOf('--port') + 1] || 0) || 8080;
const base = join(root, dev ? 'src' : 'dist');
if (!existsSync(join(base, 'index.html'))) {
  console.error(dev ? 'src/index.html missing' : 'dist/ missing: run "node build.mjs" first');
  process.exit(1);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png' };

function handler(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(base, p));
  if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
}

const lanIPs = Object.values(networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);

http.createServer(handler).listen(port, () => {
  console.log(`SonicDrop (${dev ? 'dev: src/' : 'dist/'})`);
  console.log(`  this computer:  http://localhost:${port}`);
  for (const ip of lanIPs) console.log(`  same Wi-Fi:     http://${ip}:${port}   (sending only: phones need https to use the mic)`);
});

if (wantHttps) {
  const dir = join(root, '.cert');
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanIPs.map((ip) => 'IP:' + ip)].join(',');
    const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '825',
      '-subj', '/CN=SonicDrop local', '-addext', 'subjectAltName=' + san], { stdio: 'inherit' });
    if (r.status !== 0) { console.error('openssl failed; install OpenSSL or run without --https'); process.exit(1); }
  }
  const hp = port === 8080 ? 8443 : port + 1;
  https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, handler).listen(hp, () => {
    for (const ip of lanIPs) console.log(`  same Wi-Fi:     https://${ip}:${hp}  (accept the certificate warning once; mic works)`);
  });
}
