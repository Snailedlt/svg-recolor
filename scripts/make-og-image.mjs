// Renders the link previews: the logo and name, what the site does, and the rainbow
// snail before and after, recolored by the real engine.
//   static/og-image.png              1200x630, for the site's Open Graph / Twitter tags
//   docs/github-social-preview.png   1280x640, for the repo's Settings > Social preview;
//                                    follows GitHub's template: everything important
//                                    stays inside a 40pt (80px) border
//
//   cd tests/e2e && npm ci            # once: this script borrows its Playwright
//   node scripts/make-og-image.mjs    # from the repo root
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'tests/e2e/package.json'));
const { chromium } = require('playwright');

const read = (file) => readFileSync(path.join(root, file));
const uri = (type, data) => `data:${type};base64,${Buffer.from(data).toString('base64')}`;
const logo = uri('image/svg+xml', read('static/favicon/favicon.svg'));
const snail = read('static/examples/rainbow-snail.svg').toString('utf8');
const font = uri('font/woff2', read('static/fonts/Inter-400-800-latin.woff2'));

function recolored(svg, mode, color) {
    const py = 'import sys, recolor as r; print(r.recolor(sys.stdin.read(), r.Options(mode=sys.argv[1], color=sys.argv[2])).svg)';
    return execFileSync(process.env.PYTHON || 'python3', ['-c', py, mode, color], { cwd: root, input: svg, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

const after = recolored(snail, 'colorize', 'a855f7');
const figure = (svg, label) => `<figure style="margin:0;display:grid;justify-items:center;gap:10px">
    <img src="${uri('image/svg+xml', svg)}" width="268" height="225" style="object-fit:contain">
    <figcaption style="font:600 22px Inter;color:#9aa3b5;letter-spacing:.02em">${label}</figcaption></figure>`;

// pad: [vertical, horizontal] distance from the edge to the content.
const card = (width, height, pad) => `<!doctype html><html><head><style>
    @font-face { font-family: Inter; src: url(${font}) format('woff2'); font-weight: 400 800; }
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
</style></head><body>
<div id="card" style="width:${width}px;height:${height}px;box-sizing:border-box;padding:${pad[0]}px ${pad[1]}px;display:flex;flex-direction:column;justify-content:space-between;
        background:radial-gradient(900px 500px at 85% 10%, #2a1f5c 0%, transparent 60%), radial-gradient(700px 400px at 0% 100%, #0f3b3a 0%, transparent 60%), #0f1117;
        color:#f3f4f8;font-family:Inter">
    <div style="display:flex;align-items:center;gap:18px">
        <img src="${logo}" width="64" height="64" style="border-radius:14px">
        <span style="font:800 44px Inter;letter-spacing:-.01em">SVG Recolor</span>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="max-width:500px">
            <div style="font:800 56px/1.05 Inter;letter-spacing:-.02em">Recolor any SVG in seconds</div>
            <div style="margin-top:22px;font:500 26px/1.4 Inter;color:#b8bfd0">Six modes that keep the shading. Code for 24 frameworks. Free API and MCP server.</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
            ${figure(snail, 'Original')}
            <svg width="54" height="40" viewBox="0 0 54 40" style="margin-bottom:40px"><path d="M4 20h40M32 8l13 12-13 12" fill="none" stroke="#9aa3b5" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            ${figure(after, 'Colorize')}
        </div>
    </div>
    <div style="font:600 24px Inter;color:#8b93a7">svg-recolor.jorgenkh.no</div>
</div></body></html>`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
for (const [out, width, height, pad, safe] of [
    ['static/og-image.png', 1200, 630, [64, 72], 0],
    ['docs/github-social-preview.png', 1280, 640, [96, 104], 80],
]) {
    await page.setViewportSize({ width, height });
    await page.setContent(card(width, height, pad));
    await page.evaluate(() => document.fonts.ready);
    if (safe) { // GitHub's template: nothing important within `safe` px of an edge
        const outside = await page.evaluate((safe) => [...document.querySelectorAll('#card img, #card span, #card figcaption, #card div:not(#card)')]
            .filter((el) => !el.children.length || el.tagName === 'IMG').map((el) => el.getBoundingClientRect())
            .filter((r) => r.width && (r.left < safe || r.top < safe || r.right > innerWidth - safe || r.bottom > innerHeight - safe)).length, safe);
        if (outside) throw new Error(`${out}: ${outside} element(s) inside the ${safe}px border`);
    }
    writeFileSync(path.join(root, out), await page.screenshot({ type: 'png' }));
    console.log(`wrote ${out}`);
}
await browser.close();
