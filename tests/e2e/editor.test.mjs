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
    assert.equal(geometry.length, 1);
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
    assert.match(await page.textContent('#api-hint'), /Cut out only works here in the editor/);
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
    await page.click('.preset[data-hex="#3ECF8E"]');
    await page.locator('#status-text', { hasText: '#3ECF8E' }).waitFor();
    await page.waitForTimeout(700);
    assert.equal(calls.length, 1, 'one call per color change (preview and all six thumbnails share it)');
    await page.click('.style[data-mode="solid"]');
    await page.locator('#status-text', { hasText: /^Solid/ }).waitFor();
    assert.equal(calls.length, 1, 'switching style reuses what was already fetched');
});
