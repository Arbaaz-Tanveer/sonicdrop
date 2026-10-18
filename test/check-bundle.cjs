// Syntax-check every inline script of dist/index.html and the embedded worker/worklet sources.
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../dist/index.html', 'utf8');
const re = /<script>\n([\s\S]*?)\n<\/script>/g;
let m, n = 0, bundle = null;
while ((m = re.exec(html))) {
  new Function(m[1]); n++;
  if (m[1].startsWith('window.SD_BUNDLE')) { const window = {}; new Function('window', m[1])(window); bundle = window.SD_BUNDLE; }
}
new Function(bundle.worker);
new Function('registerProcessor', 'AudioWorkletProcessor', bundle.worklet);
console.log(`ok: ${n} inline scripts, worker ${(bundle.worker.length / 1024).toFixed(0)} KB, worklet ${bundle.worklet.length} B`);
