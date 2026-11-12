// End-to-end tests of the editor in a real browser (Chromium via Playwright).
// Needs a running server: BASE_URL=http://127.0.0.1:8000 npm test
// Waits use locators, not waitForFunction: the page's CSP (correctly) blocks eval.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8000';
const axe = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
let browser;
before(async () => { browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}); });
after(async () => { await browser?.close(); });

// Vercel serves /_vercel/insights/script.js (Web Analytics) at its edge, so the app
// doesn't have it; stand in for Vercel with an empty script so local runs match.
async function newPage(options = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ...options });
    await page.route('**/_vercel/insights/script.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    return page;
}

async function open(options = {}) {
    const page = await newPage(options);
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    await page.goto(BASE + '/');
    return { page, problems };
}
const status = (page) => page.textContent('#status-text');

test('loads with no errors, CSP violations or third-party requests', async () => {
    const { page, problems } = await open();
    const external = [];
    page.on('request', (r) => { if (!r.url().startsWith(BASE) && !/^(data|blob):/.test(r.url())) external.push(r.url()); });
    await page.click('#try-example');
    await page.locator('#status-text', { hasText: 'colors' }).waitFor();
    assert.deepEqual(problems, []);
    assert.deepEqual(external, []);
    assert.match(await status(page), /^Colorize #FF0066 · 15 colors/);
});

test('style tiles show thumbnails and switch the style', async () => {
    const { page } = await open();
    await page.click('#try-example');
    await page.locator('.style .thumb img').nth(5).waitFor();
    await page.click('.style[data-mode="solid"]');
    await page.locator('#status-text', { hasText: /^Solid/ }).waitFor();
    await page.click('.style[data-mode="grayscale"]');
    assert.equal(await page.isHidden('#color-body'), true, 'color step steps aside for Grayscale');
});

test('"Change" opens the source picker, not the file browser', async () => {
    const { page } = await open();
    let chooser = false;
    page.on('filechooser', () => { chooser = true; });
    await page.click('#try-example');
    await page.waitForSelector('#file-chip:not([hidden])');
    await page.click('#change-file');
    assert.equal(chooser, false);
    assert.equal(await page.isVisible('#source-tabs'), true);
    await page.click('#source-cancel');
    assert.equal(await page.textContent('#file-name'), 'rainbow-snail.svg');
});

test('editing the current SVG as code keeps its name and applies', async () => {
    const { page } = await open();
    await page.click('#try-example');
    await page.waitForSelector('#file-chip:not([hidden])');
    await page.click('#change-file');
    await page.click('[data-source="code"]');
    const code = await page.inputValue('#code-input');
    assert.ok(code.startsWith('<svg'));
    await page.fill('#code-input', code.replaceAll('#fadc1e', '#00ff00'));
    await page.press('#code-input', 'Control+Enter');
    await page.locator('#code-status', { hasText: 'Applied · 15 colors' }).waitFor();
    assert.equal(await page.textContent('#source-cancel'), 'Done');
    await page.click('#source-cancel');
    await page.locator('#file-size', { hasText: 'from code' }).waitFor();
    assert.equal(await page.textContent('#file-name'), 'rainbow-snail.svg');
});

test('pasting SVG code into a fresh page works', async () => {
    const { page } = await open();
    await page.click('[data-source="code"]');
    await page.fill('#code-input', '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red" width="9" height="9"/></svg>');
    // No button to press: valid SVG is used as you type.
    await page.locator('#status-text', { hasText: '2 colors' }).waitFor();
    await page.locator('#code-status', { hasText: 'Applied' }).waitFor();
    assert.equal(await page.isVisible('#code-input'), true, 'the editor stays open while typing');
    await page.fill('#code-input', '<svg><rect fill="blue"');
    await page.locator('#code-status.warn', { hasText: 'Not valid SVG yet' }).waitFor();
    await page.click('#source-cancel'); // "Done"
    await page.waitForSelector('#file-chip:not([hidden])');
});

test('code and API lists: search, best match and AI prompt fallback', async () => {
    const { page } = await open();
    await page.click('#try-example');
    await page.waitForSelector('#file-chip:not([hidden])');
    await page.click('#tab-btn-code');
    await page.fill('#format-search', 'svelte');
    await page.press('#format-search', 'Enter');
    assert.match(await page.textContent('#code-meta'), /RecoloredIcon\.svelte/);
    await page.click('#tab-btn-api');
    await page.fill('#snippet-search', 'java');
    await page.press('#snippet-search', 'Enter');
    assert.match(await page.textContent('#snippet'), /HttpClient/);
    await page.fill('#snippet-search', 'Elixir');
    await page.press('#snippet-search', 'Enter');
    assert.match(await page.textContent('#snippet'), /^Write Elixir code/);
    assert.equal(await page.textContent('#copy-label'), 'Copy prompt');
});

test('the SVG code field is highlighted, larger and expandable', async () => {
    const { page, problems } = await open();
    await page.click('#try-example');
    await page.waitForSelector('#file-chip:not([hidden])');
    await page.click('#change-file');
    await page.click('[data-source="code"]');
    await page.locator('#code-hl .t-t').first().waitFor();
    assert.equal(await page.textContent('#code-hl'), (await page.inputValue('#code-input')) + '\n', 'highlight mirrors the text');
    assert.ok((await page.locator('#code-input').boundingBox()).height >= 200, 'at least 200px tall');
    await page.fill('#code-input', '<svg><rect fill="red"/></svg>');
    await page.locator('#code-hl', { hasText: /^<svg><rect fill="red"\/><\/svg>\n$/ }).waitFor();
    assert.equal(await page.locator('#code-hl .t-a').count(), 1, 'one attribute, highlighted');
    // The field and its highlighted copy wrap long lines at the same points.
    await page.fill('#code-input', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="' + 'M1 2 L3 4 '.repeat(60) + '"/></svg>');
    await page.waitForTimeout(100);
    const [taH, hlH] = await page.$$eval(['#code-input', '#code-hl'].join(','), (els) => els.map((e) => e.scrollHeight));
    assert.ok(Math.abs(taH - hlH) <= 2, `same wrapped height: ${taH} vs ${hlH}`);
    await page.click('#code-expand');
    const big = await page.locator('#code-input').boundingBox();
    assert.ok(big.width > 550 && big.height > 450, 'the large editor fills most of the window');
    await page.locator('#code-preview-img[src^="blob:"]').waitFor();
    assert.equal(await page.isVisible('#code-preview'), true, 'live preview beside the code');
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#code-preview'), false);
    assert.equal(await page.isVisible('#source-code'), true, 'Esc only shrinks the editor');
    assert.deepEqual(problems, []);
});

test('code blocks are highlighted and copy their full text', async () => {
    const { page, problems } = await open();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await page.click('#try-example');
    await page.waitForSelector('#file-chip:not([hidden])');
    await page.click('#tab-btn-code');
    await page.fill('#format-search', 'react');
    await page.press('#format-search', 'Enter');
    await page.locator('#code-view .t-t').first().waitFor();
    assert.ok(await page.locator('#code-view .t-k').count() > 0, 'keywords are highlighted');
    const shown = await page.textContent('#code-view');
    await page.click('#tab-code .code-head .copy-chip');
    await page.locator('#tab-code .code-head .copy-chip', { hasText: 'Copied' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), shown, 'copies exactly the code');

    await page.click('#tab-btn-api');
    await page.fill('#snippet-search', 'rust');
    await page.press('#snippet-search', 'Enter');
    await page.locator('#snippet .t-s').first().waitFor();
    // Ctrl+C on the focused block with nothing selected copies all of it.
    await page.focus('#snippet');
    await page.keyboard.press('Control+c');
    await page.locator('#tab-api .code-head .copy-chip', { hasText: 'Copied' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.textContent('#snippet'));
    assert.equal(await page.locator('#mcp-cmd .t-f').textContent(), 'claude');
    assert.equal(await page.textContent('#code-view-lang'), 'React');
    assert.equal(await page.textContent('#snippet-lang'), 'Rust');
    // Copy never sits on top of code: it is in a header bar or a button row.
    const overlaps = await page.$$eval('.copy-chip, .copy-btn-row', (btns) => btns.filter((b) => {
        const r = b.getBoundingClientRect();
        return [...document.querySelectorAll('pre.code')].some((p) => {
            const q = p.getBoundingClientRect();
            return r.width && q.width && r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top;
        });
    }).length);
    assert.equal(overlaps, 0);
    assert.deepEqual(problems, []);
});

const EDIT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 10"><rect width="30" height="10" fill="#ffffff"/>'
    + '<path d="M1 1h8v8H1z" fill="#5e97f6"/><path d="M11 1h8v8h-8z" fill="#e879f9"/><path d="M21 1h8v8h-8z" fill="#0f766e"/></svg>';

// The Adjust, Shapes, Placement and Optimize sections are closed until opened.
async function openFold(page, name) {
    await page.click(`details.fold[data-fold="${name}"]:not([open]) > summary`).catch(() => {});
}

async function pasteSvg(page, svg) {
    await page.click('[data-source="code"]');
    await page.fill('#code-input', svg);
    await page.locator('#code-status', { hasText: 'Applied' }).waitFor();
    await page.click('#source-cancel');
}

test('each color can get its own color or become invisible', async () => {
    const { page, problems } = await open();
    await pasteSvg(page, EDIT_SVG);
    await page.click('.style[data-mode="solid"]');
    await page.locator('#status-text', { hasText: /^Solid/ }).waitFor();
    await page.click('.chip[data-color="ffffff"]');
    assert.equal(await page.isVisible('#color-edit'), true);
    await page.check('#color-edit [value="remove"]');
    await page.locator('.chip[data-color="ffffff"]', { hasText: 'Invisible' }).waitFor();
    await page.click('.chip[data-color="e879f9"]');
    await page.check('#color-edit [value="remove"]');
    await page.locator('.chip[data-color="e879f9"]', { hasText: 'Invisible' }).waitFor();
    await page.click('.chip[data-color="0f766e"]');
    await page.locator('#color-edit-own').evaluate((el) => { el.value = '#00aa55'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.locator('.chip[data-color="0f766e"]', { hasText: '#00AA55' }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#color-edit'), false, 'Esc closes the panel');
    await page.click('#tab-btn-code');
    const code = await page.textContent('#code-view');
    assert.ok(!code.includes('<rect'), 'the removed color\'s shape is gone');
    assert.match(code, /fill="#00aa55"/);
    await page.waitForURL(/replace=0f766e%3A00aa55&remove=ffffff%2Ce879f9/); // the address is updated after a short pause
    // The API snippet reproduces the same edits.
    await page.click('#tab-btn-api');
    assert.match(await page.textContent('#snippet'), /remove=ffffff/);
    await page.click('#tab-btn-preview');
    await page.click('#edits-reset');
    await page.locator('.chip.edited').first().waitFor({ state: 'detached' });
    assert.deepEqual(problems, []);
});

// Where a point of the picture (in viewBox units) is on screen, for an <img> with object-fit: contain.
async function pointOf(page, selector, [x, y], [vw, vh]) {
    const r = await page.locator(selector).boundingBox();
    const scale = Math.min(r.width / vw, r.height / vh);
    return { x: r.x + (r.width - vw * scale) / 2 + x * scale, y: r.y + (r.height - vh * scale) / 2 + y * scale };
}

test('clicking a shape in the picture opens that color, like its chip', async () => {
    const { page, problems } = await open();
    await pasteSvg(page, EDIT_SVG);
    await page.click('.style[data-mode="solid"]');
    await page.locator('#status-text', { hasText: /^Solid/ }).waitFor();
    // The pink square, in the recolored picture; then the teal one in the original.
    let pt = await pointOf(page, '#result-container img', [15, 5], [30, 10]);
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.click(pt.x, pt.y);
    await page.locator('#color-edit:not([hidden])').waitFor();
    assert.equal(await page.textContent('#color-edit-title'), '#E879F9');
    await page.mouse.move(pt.x + 1, pt.y);
    await page.locator('.chip.hover[data-color="e879f9"]').waitFor(); // hovering the shape marks its chip
    pt = await pointOf(page, '#preview-container img', [25, 5], [30, 10]);
    await page.mouse.click(pt.x, pt.y);
    assert.equal(await page.textContent('#color-edit-title'), '#0F766E');
    // The white background between the squares is a color too.
    pt = await pointOf(page, '#preview-container img', [10, 5], [30, 10]);
    await page.mouse.click(pt.x, pt.y);
    assert.equal(await page.textContent('#color-edit-title'), '#FFFFFF');
    await page.check('#color-edit [value="remove"]');
    await page.locator('.chip[data-color="ffffff"]', { hasText: 'Invisible' }).waitFor();
    assert.equal(await page.isVisible('#color-edit'), true, 'the panel stays open at the click while editing');
    assert.deepEqual(problems, []);
});

async function pasteClipboard(page, items) {
    await page.evaluate((items) => {
        const dt = new DataTransfer();
        for (const it of items) {
            if (it.file) dt.items.add(new File([it.file.body], it.file.name, { type: it.file.type }));
            else dt.setData(it.type, it.data);
        }
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, items);
}

test('pasting an .svg file (copied in the file manager) loads it', async () => {
    const { page, problems } = await open();
    await pasteClipboard(page, [{ file: { body: EDIT_SVG, name: 'squares.svg', type: 'image/svg+xml' } }]);
    await page.locator('#file-name', { hasText: 'squares.svg' }).waitFor();
    await page.locator('.chip[data-color="e879f9"]').waitFor();
    // A PNG is not something we can recolor: say so.
    await pasteClipboard(page, [{ file: { body: 'x', name: 'photo.png', type: 'image/png' } }]);
    await page.locator('#error-text', { hasText: 'PNG image' }).waitFor();
    assert.deepEqual(problems, []);
});

test('"Copy image" from a page (a PNG plus <img src>) loads the SVG itself', async () => {
    const { page, problems } = await open();
    const fetched = [];
    await page.route('**/api/fetch?*', (route) => {
        fetched.push(new URL(route.request().url()).searchParams.get('url'));
        route.fulfill({ status: 200, contentType: 'image/svg+xml', body: EDIT_SVG });
    });
    const src = 'https://github.com/devicons/devicon/raw/abc123/icons/jax/jax-original.svg';
    await pasteClipboard(page, [
        { type: 'text/html', data: '<meta charset="utf-8"><img src="' + src + '" alt="jax">' },
        { file: { body: 'png bytes', name: 'image.png', type: 'image/png' } },
    ]);
    await page.locator('#file-name', { hasText: 'jax-original.svg' }).waitFor();
    assert.deepEqual(fetched, [src]);
    // An image given inline as a data: URL needs no download.
    await pasteClipboard(page, [{ type: 'text/html', data: '<img src="data:image/svg+xml,' + encodeURIComponent(EDIT_SVG.replace('#ffffff', '#123456')) + '">' }]);
    await page.locator('.chip[data-color="123456"]').waitFor();
    assert.equal(fetched.length, 1);
    assert.deepEqual(problems, []);
});

test('each color shows its mode at a glance, and Reset colors clears them all', async () => {
    const { page, problems } = await open();
    await pasteSvg(page, EDIT_SVG);
    await page.click('.style[data-mode="solid"]');
    await page.locator('#status-text', { hasText: /^Solid/ }).waitFor();
    assert.equal(await page.isDisabled('#edits-reset'), true, 'nothing to reset yet');
    await page.click('.chip[data-color="ffffff"]');
    await page.check('#color-edit [value="remove"]');
    await page.click('.chip[data-color="0f766e"]');
    await page.check('#color-edit [value="cut"]');
    await page.keyboard.press('Escape');
    await page.locator('.chip[data-color="ffffff"] .badge[data-op="remove"]').waitFor();
    await page.locator('.chip[data-color="0f766e"] .badge[data-op="cut"]').waitFor();
    assert.equal(await page.locator('.chip[data-color="5e97f6"] .badge').count(), 0, 'colors that follow the style have no badge');
    await page.click('#edits-reset');
    await page.locator('.chip .badge').first().waitFor({ state: 'detached' });
    assert.equal(await page.isDisabled('#edits-reset'), true);
    assert.deepEqual(problems, []);
});

// Two facets with an outline ring drawn over their shared edge, like the JAX logo.
const CUT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20">'
    + '<rect x="0" y="0" width="20" height="20" fill="#5e97f6"/><rect x="20" y="0" width="20" height="20" fill="#9c27b0"/>'
    + '<rect x="19" y="0" width="2" height="20" fill="#dce0df"/></svg>';

test('cut out: a color becomes a real gap, and the result is one path per color', async () => {
    const { page, problems } = await open();
    const geometry = [];
    page.on('request', (r) => { if (r.url().includes('/assets/geometry.js')) geometry.push(r.url()); });
    await pasteSvg(page, CUT_SVG);
    await page.click('.style[data-mode="solid"]');
    await page.locator('#status-text', { hasText: /^Solid/ }).waitFor();
    assert.equal(geometry.length, 0, 'the geometry library loads only when needed');
    await page.click('.chip[data-color="dce0df"]');
    await page.check('#color-edit [value="cut"]');
    await page.locator('.chip[data-color="dce0df"]', { hasText: 'Cut out' }).waitFor();
    assert.ok(geometry.length >= 1 && new Set(geometry).size === 1, 'one hashed bundle (the worker runs the same file)');
    await page.keyboard.press('Escape');
    await page.click('#tab-btn-code');
    const code = await page.textContent('#code-view');
    assert.equal((code.match(/<path/g) || []).length, 1, 'Solid + cut out = one path');
    assert.match(code, /viewBox="0 0 40 20"/);
    // Point tests on the real path: the facets are filled, the outline is a gap.
    const d = /\sd="([^"]+)"/.exec(code)[1];
    const hits = await page.evaluate((d) => {
        const ctx = document.createElement('canvas').getContext('2d');
        const p = new Path2D(d);
        return [[10, 10], [30, 10], [20, 10], [19.2, 5], [20.8, 15]].map(([x, y]) => ctx.isPointInPath(p, x, y, 'nonzero'));
    }, d);
    assert.deepEqual(hits, [true, true, false, false, false]);
    // A viewBox that doesn't start at 0,0: the shapes keep their coordinates.
    const shifted = await page.evaluate(() => SvgGeometry.cutOut('<svg xmlns="http://www.w3.org/2000/svg" viewBox="100 50 40 20">'
        + '<rect x="100" y="50" width="20" height="20" fill="#5e97f6"/><rect x="118" y="50" width="4" height="20" fill="#dce0df"/></svg>', { cut: ['dce0df'] }));
    assert.match(shifted, /viewBox="100 50 40 20"/);
    assert.match(shifted, /d="M100,70v-20h18[lv]/, "the cut leaves 100..118 at its own coordinates");
    await page.click('#tab-btn-api');
    assert.match(await page.textContent('#snippet'), /cut=dce0df/, 'the API cuts out too');
    await page.click('#tab-btn-preview');
    assert.deepEqual(problems, []);
});

// Four touching color pieces with no outline between them, like the rqlite logo.
const GAP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
    + '<rect width="64" height="64" fill="#013397"/><rect x="64" width="64" height="64" fill="#0169c9"/>'
    + '<rect y="64" width="64" height="64" fill="#0197fd"/><rect x="64" y="64" width="64" height="64" fill="#b3defd"/></svg>';

test('gaps: color boundaries become gaps, so a one-color version keeps its parts', async () => {
    const { page, problems } = await open();
    await pasteSvg(page, GAP_SVG);
    await page.click('.style[data-mode="solid"]');
    await page.locator('#status-text', { hasText: /^Solid/ }).waitFor();
    await page.locator('#adj-gap').evaluate((el) => { el.value = '4'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.textContent('#adj-gap-out'), '4 px');
    await page.waitForURL(/gap=4/);
    await page.click('#tab-btn-code');
    await page.locator('#code-view', { hasText: '<path' }).waitFor();
    const code = await page.textContent('#code-view');
    assert.equal((code.match(/<path/g) || []).length, 1, 'Solid + gaps = one path');
    const d = /\sd="([^"]+)"/.exec(code)[1];
    const hits = await page.evaluate((d) => {
        const ctx = document.createElement('canvas').getContext('2d');
        const p = new Path2D(d);
        // Inside each piece; on the seams (4 units wide, centered); the outer edge stays put.
        return [[32, 32], [96, 32], [32, 96], [96, 96], [64, 32], [62.5, 96], [32, 65.5], [0.5, 10], [127.5, 120]]
            .map(([x, y]) => ctx.isPointInPath(p, x, y, 'nonzero'));
    }, d);
    assert.deepEqual(hits, [true, true, true, true, false, false, false, true, true]);
    await page.click('#tab-btn-preview');
    await page.click('#reset-all');
    assert.equal(await page.textContent('#adj-gap-out'), 'Off');
    assert.deepEqual(problems, []);
});

// A blue square with a white square inside it.
const LINE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
    + '<rect width="128" height="128" fill="#0169c9"/><rect x="32" y="32" width="64" height="64" fill="#ffffff"/></svg>';

test('gap and line sizes: px in the SVG\'s units, or % of the icon', async () => {
    const { page, problems } = await open();
    await pasteSvg(page, GAP_SVG); // 128 x 128
    assert.equal(await page.getAttribute('#adj-gap', 'step'), '0.5');
    assert.equal(await page.getAttribute('#adj-gap', 'max'), '6');
    await page.locator('#adj-gap').evaluate((el) => { el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.textContent('#adj-gap-out'), '2 px');
    // Switching units keeps the look: 2 px of 128 is 1.56 %, which the 0.1 % steps round to 1.6.
    await openFold(page, 'shape');
    await page.click('#unit-tabs [data-unit="%"]');
    assert.equal(await page.textContent('#adj-gap-out'), '1.6 %');
    await page.waitForURL(/gap=1\.6&unit=pct/);
    // A big drawing gets a bigger px range: 6/128 of 1024 is 48 px, in 2 px steps.
    await page.click('#unit-tabs [data-unit="px"]');
    await page.click('#change-file');
    await pasteSvg(page, GAP_SVG.replace('viewBox="0 0 128 128"', 'viewBox="0 0 1024 1024"'));
    assert.equal(await page.getAttribute('#adj-gap', 'max'), '48');
    assert.equal(await page.getAttribute('#adj-gap', 'step'), '2');
    assert.equal(await page.textContent('#adj-gap-out'), '2 px', 'the chosen size stays');
    assert.deepEqual(problems, []);
});

test('line version: only the edges stay, colors can stay filled', async () => {
    const { page, problems } = await open();
    await pasteSvg(page, LINE_SVG);
    await page.click('.style[data-mode="solid"]');
    await page.locator('#status-text', { hasText: /^Solid/ }).waitFor();
    await openFold(page, 'shape');
    assert.equal(await page.isVisible('#line-inner-row'), false, 'the line options show once lines are on');
    const hitsAt = async (points) => {
        await page.locator('#status-text', { hasText: /^Solid/ }).waitFor();
        await page.click('#tab-btn-code');
        const code = await page.textContent('#code-view');
        await page.click('#tab-btn-preview');
        assert.equal((code.match(/<path/g) || []).length, 1, 'one color, one path');
        const d = /\sd="([^"]+)"/.exec(code)[1];
        return page.evaluate(([d, points]) => {
            const ctx = document.createElement('canvas').getContext('2d');
            const p = new Path2D(d);
            return points.map(([x, y]) => ctx.isPointInPath(p, x, y, 'nonzero'));
        }, [d, points]);
    };
    // Outer edge (band inside it), empty middle of the blue part, both sides of the inner
    // edge (a line centered on it), the white middle.
    const points = [[4, 64], [20, 64], [29.5, 64], [34.5, 64], [64, 64]];
    await page.locator('#adj-line').evaluate((el) => { el.value = '8'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForURL(/line=8/);
    assert.equal(await page.isVisible('#line-inner-row'), true);
    assert.deepEqual(await hitsAt(points), [true, false, true, true, false]);

    // Keep the white square filled.
    const pt = await pointOf(page, '#preview-container img', [64, 64], [128, 128]);
    await page.mouse.click(pt.x, pt.y);
    await page.check('#color-edit-keep');
    await page.locator('.chip.kept[data-color="ffffff"]').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForURL(/keep=ffffff/);
    assert.deepEqual(await hitsAt(points), [true, false, true, true, true]);

    // Only the outline of the whole shape.
    await page.mouse.click(pt.x, pt.y);
    await page.uncheck('#color-edit-keep');
    await page.keyboard.press('Escape');
    await page.click('#line-inner-row .switch');
    await page.waitForURL(/lines=outer/);
    assert.deepEqual(await hitsAt(points), [true, false, false, false, false]);
    await page.click('#tab-btn-api');
    assert.match(await page.textContent('#snippet'), /line=8.*lines=outer|lines=outer.*line=8/, 'the API draws lines too');
    assert.deepEqual(problems, []);
});

test('the SVG\'s own colors (and gradient middles) can be picked as the color', async () => {
    const { page, problems } = await open();
    await pasteSvg(page, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><defs><linearGradient id="g">'
        + '<stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>'
        + '<rect width="10" height="10" fill="url(#g)"/><rect x="10" width="5" height="10" fill="#00ff00"/><rect x="15" width="5" height="10" fill="#00ff00"/></svg>');
    await page.locator('#logo-colors:not([hidden])').waitFor();
    const colors = await page.$$eval('#logo-colors button', (bs) => bs.map((b) => b.dataset.hex + (b.classList.contains('mid') ? ' mid' : '')));
    assert.equal(colors[0], '#00FF00', 'most used first');
    assert.ok(colors.includes('#FF0000') && colors.includes('#0000FF'), 'both ends of the gradient');
    assert.ok(colors.includes('#800080 mid'), 'the middle of the gradient');
    await page.click('#logo-colors button[data-hex="#800080"]');
    assert.equal(await page.inputValue('#hex-input'), '800080');
    assert.equal(await page.getAttribute('#logo-colors button[data-hex="#800080"]', 'aria-pressed'), 'true');
    assert.deepEqual(problems, []);
});

test('canvas: a new viewBox, and Fit with padding (strokes count)', async () => {
    const { page, problems } = await open();
    // A 100 x 50 drawing with a 20 x 20 square at 10,10 and a 2-wide stroke: visible box 9,9 22 x 22.
    await pasteSvg(page, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">'
        + '<rect x="10" y="10" width="20" height="20" fill="#5e97f6" stroke="#0f766e" stroke-width="2"/></svg>');
    assert.equal(await page.inputValue('#canvas-w'), '100');
    assert.equal(await page.inputValue('#canvas-h'), '50');
    await page.fill('#canvas-w', '128');
    await page.press('#canvas-w', 'Enter');
    await page.fill('#canvas-h', '128');
    await page.press('#canvas-h', 'Enter');
    await openFold(page, 'canvas');
    await page.fill('#fit-pad', '1');
    await page.click('#fit-btn');
    await page.waitForURL(/canvas=128x128&place=-50\.545%2C-50\.545%2C5\.727/);
    assert.equal(await page.inputValue('#place-s'), '572.73');
    await page.click('#tab-btn-code');
    await page.locator('#code-view', { hasText: 'matrix(' }).waitFor();
    const code = await page.textContent('#code-view');
    assert.match(code, /viewBox="0 0 128 128"/);
    assert.match(code, /<g transform="matrix\(5\.727 0 0 5\.727 -50\.545 -50\.545\)">/);
    // The API does the same: the snippet carries the canvas and the placement Fit chose.
    await page.click('#tab-btn-api');
    assert.match(await page.textContent('#snippet'), /canvas=128x128/);
    await page.click('#tab-btn-preview');
    await page.click('#canvas-reset');
    assert.equal(await page.inputValue('#canvas-w'), '100');
    assert.deepEqual(problems, []);
});

test('optimize with SVGO (devicon\'s settings), and the code next to the picture', async () => {
    const { page, problems } = await open();
    await pasteSvg(page, '<?xml version="1.0"?>\n<!-- made by hand -->\n<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">'
        + '<title>t</title><g><rect x="0" y="0" width="64.123456" height="64" fill="#5e97f6"/></g></svg>');
    await page.click('#view-tabs [data-view="code"]');
    assert.equal(await page.isVisible('#preview-container'), false, 'the code takes the original\'s place');
    await page.locator('#side-code', { hasText: '<title>' }).waitFor();
    await openFold(page, 'optimize');
    await page.check('#svgo-toggle');
    await page.waitForURL(/optimize=1/);
    await page.locator('#side-code', { hasText: 'path' }).waitFor();
    const code = await page.textContent('#side-code');
    assert.ok(!/<title>|<!--|<\?xml|width="128"/.test(code), 'comments, title, prolog and size are gone');
    assert.match(code, /viewBox="0 0 128 128"/, 'the viewBox stays (devicon)');
    assert.match(code, /64\.123/, 'precision 3');
    assert.ok(code.endsWith('</svg>\n') || code.endsWith('</svg>'), 'one line, newline at the end');
    // Settings: turn off removeTitle and the title comes back.
    await page.click('#svgo-open');
    await page.uncheck('#svgo-plugins [data-plugin="removeTitle"]');
    assert.equal(await page.textContent('#svgo-preset'), 'Custom');
    assert.match(await page.textContent('#optimize-sub'), /custom/, 'the section header says so');
    await page.locator('#side-code', { hasText: '<title>' }).waitFor();
    await page.click('#svgo-reset');
    assert.equal(await page.textContent('#svgo-preset'), 'Default');
    await page.click('#svgo-done');
    await page.click('#view-tabs [data-view="side"]');
    assert.deepEqual(problems, []);
});

test('cut out explains what it can\'t do instead of guessing', async () => {
    const { page } = await open();
    await pasteSvg(page, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop stop-color="#f00"/></linearGradient></defs>'
        + '<rect width="10" height="10" fill="url(#g)"/><rect width="4" height="4" fill="#00ff00"/></svg>');
    await page.click('.chip[data-color="00ff00"]');
    await page.check('#color-edit [value="cut"]');
    await page.locator('#error-text', { hasText: 'gradients' }).waitFor();
});

test('share links carry a pasted SVG and its edits', async () => {
    const { page, problems } = await open();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await pasteSvg(page, EDIT_SVG);
    await page.click('.chip[data-color="ffffff"]');
    await page.check('#color-edit [value="remove"]');
    await page.locator('.chip[data-color="ffffff"]', { hasText: 'Invisible' }).waitFor();
    await page.click('#share-btn');
    await page.locator('.toast', { hasText: 'Link with this SVG' }).waitFor();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(link, /#svg=/);
    const other = await newPage();
    await other.goto(BASE + link.slice(link.indexOf('/?')));
    await other.locator('#file-name', { hasText: 'pasted.svg' }).waitFor({ state: 'attached' });
    await other.locator('.chip[data-color="ffffff"]', { hasText: 'Invisible' }).waitFor();
    assert.ok(!other.url().includes('#svg='), 'the SVG is dropped from the address bar after loading');
    assert.deepEqual(problems, []);
});

test('no accessibility violations (axe) in every tab, both themes', async () => {
    for (const colorScheme of ['dark', 'light']) {
        const { page } = await open({ colorScheme, bypassCSP: true });
        await page.click('#try-example');
        await page.waitForSelector('#file-chip:not([hidden])');
        for (const tab of ['preview', 'code', 'api']) {
            await page.click(`#tab-btn-${tab}`);
            await page.addScriptTag({ content: axe });
            const violations = await page.evaluate(async () => (await window.axe.run()).violations.map((v) => `${v.id}: ${v.nodes[0].target}`));
            assert.deepEqual(violations, [], `${colorScheme} ${tab}`);
        }
    }
});

test('phone layout has no horizontal scroll', async () => {
    const { page } = await open({ viewport: { width: 390, height: 844 } });
    await page.click('#try-example');
    await page.waitForSelector('#file-chip:not([hidden])');
    for (const tab of ['preview', 'code', 'api']) {
        await page.click(`#tab-btn-${tab}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, tab);
    }
});

test('request budget: no API calls on load, one per settings change (keeps hosting cheap)', async () => {
    const page = await newPage();
    const calls = [];
    const files = [];
    page.on('request', (r) => {
        const path = new URL(r.url()).pathname;
        if (path.startsWith('/api/')) calls.push(path);
        else if (r.url().startsWith(BASE)) files.push(path);
    });
    await page.goto(BASE + '/');
    await page.locator('.style .thumb img').nth(5).waitFor(); // thumbnails come from data in the page
    assert.deepEqual(calls, [], 'no API calls on page load');
    assert.ok(files.length <= 8, `page load uses at most 8 files (page, CSS, script, 2 fonts, favicon, thumbnail snail, analytics), got ${files.length}: ${files}`);
    await page.click('#try-example');
    await page.locator('#status-text', { hasText: 'colors' }).waitFor();
    await page.locator('.style .thumb img').nth(5).waitFor();
    await page.waitForTimeout(700);
    assert.equal(calls.length, 0, 'the example is the thumbnail snail, so its colors are already known');
    await page.click('#swatch-btn'); // presets are in the popover on the swatch
    await page.click('.preset[data-hex="#3ECF8E"]');
    assert.equal(await page.isVisible('#color-pop'), false, 'picking a preset closes the popover');
    await page.locator('#status-text', { hasText: '#3ECF8E' }).waitFor();
    await page.waitForTimeout(700);
    assert.equal(calls.length, 1, 'one call per color change (preview and all six thumbnails share it)');
    await page.click('.style[data-mode="solid"]');
    await page.locator('#status-text', { hasText: /^Solid/ }).waitFor();
    assert.equal(calls.length, 1, 'switching style reuses what was already fetched');
});
