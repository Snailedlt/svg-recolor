// Renders every icon and the social preview image from static/logo.svg.
//
//   cd tests/e2e && npm ci            # once: this script borrows its Playwright
//   node scripts/make-icons.mjs       # from the repo root
//
// Writes static/favicon/* (PNG sizes, favicon.ico) and static/og-image.png. The
// recolored snails in the preview come from the real engine (recolor.py).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'tests/e2e/package.json'));
const { chromium } = require('playwright');

const BG = '#0f1117';
const logo = readFileSync(path.join(root, 'static/logo.svg'), 'utf8');
const rainbow = readFileSync(path.join(root, 'static/examples/rainbow-snail.svg'), 'utf8');
const uri = (svg) => 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
const font = (file) => 'data:font/woff2;base64,' + readFileSync(path.join(root, 'static/fonts', file)).toString('base64');

function recolored(svg, mode, color) {
    const py = 'import sys, recolor as r; print(r.recolor(sys.stdin.read(), r.Options(mode=sys.argv[1], color=sys.argv[2])).svg)';
    return execFileSync(process.env.PYTHON || 'python3', ['-c', py, mode, color], { cwd: root, input: svg, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function shot(html, width, height, out) {
    await page.setViewportSize({ width, height });
    await page.setContent(`<!doctype html><html><head><style>
        @font-face { font-family: Inter; src: url(${font('Inter-400-800-latin.woff2')}) format('woff2'); font-weight: 400 800; }
        html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
    </style></head><body>${html}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const buf = await page.screenshot({ type: 'png', omitBackground: true });
    if (out) writeFileSync(path.join(root, out), buf);
    return buf;
}

// Transparent icons (browser tabs) and solid ones (home screens, which mask the shape).
const plain = (size) => `<img src="${uri(logo)}" width="${size}" height="${size}" style="display:block">`;
const tile = (size, scale) => `<div style="width:${size}px;height:${size}px;background:${BG};display:grid;place-items:center">
    <img src="${uri(logo)}" width="${Math.round(size * scale)}" height="${Math.round(size * scale)}"></div>`;

await shot(plain(96), 96, 96, 'static/favicon/favicon-96x96.png');
await shot(tile(180, 0.82), 180, 180, 'static/favicon/apple-touch-icon.png');
await shot(tile(192, 0.7), 192, 192, 'static/favicon/web-app-manifest-192x192.png'); // maskable: keep the snail in the safe zone
await shot(tile(512, 0.7), 512, 512, 'static/favicon/web-app-manifest-512x512.png');
const ico = await Promise.all([16, 32, 48].map((s) => shot(plain(s), s, s)));

// favicon.ico: an ICO container holding PNG images (supported by every current browser).
const header = Buffer.alloc(6 + 16 * ico.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(ico.length, 4);
let offset = header.length;
ico.forEach((png, i) => {
    const size = [16, 32, 48][i];
    const e = 6 + 16 * i;
    header.writeUInt8(size, e); header.writeUInt8(size, e + 1); header.writeUInt8(0, e + 2); header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += png.length;
});
writeFileSync(path.join(root, 'static/favicon/favicon.ico'), Buffer.concat([header, ...ico]));

// Social preview, 1200x630: the rainbow snail (static/examples/rainbow-snail.svg) before
// and after, with the name and what it does.
const snail = (svg, label) => `<figure style="margin:0;display:grid;justify-items:center;gap:10px">
    <img src="${uri(svg)}" width="268" height="225" style="object-fit:contain">
    <figcaption style="font:600 22px Inter;color:#9aa3b5;letter-spacing:.02em">${label}</figcaption></figure>`;
const og = `<div style="width:1200px;height:630px;box-sizing:border-box;padding:64px 72px;display:flex;flex-direction:column;justify-content:space-between;
        background:radial-gradient(900px 500px at 85% 10%, #2a1f5c 0%, transparent 60%), radial-gradient(700px 400px at 0% 100%, #0f3b3a 0%, transparent 60%), ${BG};
        color:#f3f4f8;font-family:Inter">
    <div style="display:flex;align-items:center;gap:18px">
        <img src="${uri(logo)}" width="64" height="64">
        <span style="font:800 44px Inter;letter-spacing:-.01em">SVG Recolor</span>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="max-width:500px">
            <div style="font:800 56px/1.05 Inter;letter-spacing:-.02em">Recolor any SVG in seconds</div>
            <div style="margin-top:22px;font:500 26px/1.4 Inter;color:#b8bfd0">Six modes that keep the shading. Code for 24 frameworks. Free API and MCP server.</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
            ${snail(rainbow, 'Original')}
            <svg width="54" height="40" viewBox="0 0 54 40" style="margin-bottom:40px"><path d="M4 20h40M32 8l13 12-13 12" fill="none" stroke="#9aa3b5" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            ${snail(recolored(rainbow, 'colorize', 'a855f7'), 'Colorize')}
        </div>
    </div>
    <div style="font:600 24px Inter;color:#8b93a7">svg-recolor.jorgenkh.no</div>
</div>`;
await shot(og, 1200, 630, 'static/og-image.png');

await browser.close();
console.log('wrote static/favicon/* and static/og-image.png');
