import { chromium } from 'playwright';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const SP = process.argv[2];
// the same 80 icons as the API sweep
const files = readFileSync(SP + '/pick.txt', 'utf8').trim().split('\n');
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); const page = await b.newPage();
await page.route('**/_vercel/**', (r) => r.fulfill({ status: 200, body: '' }));
await page.goto('http://127.0.0.1:8765/');
await page.addScriptTag({ url: '/assets/geometry.js' });
const errs = {}; const slow = []; let ok = 0;
for (const f of files) {
  const svg = readFileSync(f, 'utf8');
  for (const [name, opts] of [['gap2', { gap: 2 }], ['line3', { line: 3 }]]) {
    const t = Date.now();
    const out = await page.evaluate(async ([svg, opts]) => {
      const colors = [...new Set((svg.match(/#[0-9a-fA-F]{6}\b/g) || []).map((c) => c.slice(1).toLowerCase()))];
      const map = Object.fromEntries(colors.map((c) => [c, '000000']));
      try { return await SvgGeometry.cutOut(svg, Object.assign({ map, cut: [], worker: false }, opts)); } catch (e) { return 'ERR ' + e.message; }
    }, [svg, opts]);
    const dt = (Date.now() - t) / 1000;
    if (dt > 3) slow.push([dt, name, f.split('/').pop()]);
    if (out.startsWith('ERR')) { const k = name + ': ' + out.slice(0, 90); errs[k] = (errs[k] || 0) + 1; }
    else { ok++; writeFileSync(`${SP}/bsweep/${name}-${f.split('/').pop()}`, out); }
  }
}
console.log('ok', ok); console.log(errs); console.log('slow', slow.sort((a, b) => b[0] - a[0]).slice(0, 8));
await b.close();
