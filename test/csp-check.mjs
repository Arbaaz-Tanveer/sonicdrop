// Regression for the hash-based CSP: the built page must boot (scripts allowed) with no CSP violations.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = spawn(process.execPath, [join(root, 'serve.mjs'), '--port', '8096'], { stdio: 'ignore' });
await sleep(800);
const b = await launch('csp', 9373, []);
await b.send('Page.navigate', { url: 'http://localhost:8096/#send' });
await sleep(2000);
const modes = await b.evaluate(`document.querySelectorAll('#modeList .mode').length`);
const violations = b.logs.filter((l) => /Content Security Policy|Refused/i.test(l));
b.logs.forEach((l) => console.log(l));
const ok = modes > 0 && !violations.length;
console.log(ok ? `CSP PASS (app booted, ${modes} speed modes, no violations)` : `CSP FAIL (modes ${modes}, ${violations.length} violations)`);
b.close();
server.kill();
process.exit(ok ? 0 : 1);
