// Render the link-preview card (tools/og-card.html) to assets/og.png at 1200x630 with headless Edge/Chrome.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../test/cdp.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const b = await launch('og', 9363, []);
await b.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });
await b.send('Page.navigate', { url: 'file:///' + join(root, 'tools', 'og-card.html').split(String.fromCharCode(92)).join('/') });
await sleep(1200);
const r = await b.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 } });
writeFileSync(join(root, 'assets', 'og.png'), Buffer.from(r.result.data, 'base64'));
b.close();
console.log('wrote assets/og.png');
process.exit(0);
