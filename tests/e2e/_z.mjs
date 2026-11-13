import { chromium } from 'playwright'; import { readFileSync } from 'node:fs';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1000, height: 340 } });
const im = (f) => '<img style="width:320px;margin:5px;background:#fff" src="data:image/svg+xml;base64,' + readFileSync(f).toString('base64') + '">';
await p.setContent('<body style="margin:0;background:#ccc">' + process.argv.slice(3).map(im).join('') + '</body>');
await p.waitForTimeout(300); await p.screenshot({ path: process.argv[2] }); await b.close();
