/* SVG Recolor — editor.
 *
 * How recoloring works here (and why it's cheap to host):
 *   1. The SVG never leaves the browser. It is normalized here with the same
 *      rules as recolor.py (named colors, rgb()/hsl(), short hex -> 6/8-digit hex).
 *   2. Only its palette (a few hex colors) is sent to GET /api/map-colors, where
 *      svgray/svgshift compute the new colors. That URL is deterministic and
 *      cached by the CDN for a year, so popular palettes cost nothing.
 *   3. The mapping is applied here, giving the same output as POST /api/recolor.
 */
(function () {
    'use strict';

    const CFG = window.SVG_RECOLOR || {};
    const ENGINE_VERSION = /^__/.test(CFG.engineVersion || '') ? '' : CFG.engineVersion;
    const SITE = location.origin.startsWith('http') ? location.origin : 'https://svg-recolor.jorgenkh.no';
    const MAX_BYTES = 2 * 1024 * 1024;
    const MAX_GET_COLORS = 300;
    const CODE_VIEW_LIMIT = 400000;
    const PRESETS = ['#FF0066', '#FF5C00', '#F5A524', '#3ECF8E', '#00B8D9', '#569CD6', '#7C5CFF', '#111827', '#9AA1B2'];
    const MODES = {
        tint: { label: 'Tint', color: true, desc: 'Grayscale, then add your color. Dark parts take the color, light parts stay light.' },
        colorize: { label: 'Colorize', color: true, desc: 'Your hue and saturation on every color, keeping its lightness, so shading survives.' },
        hue: { label: 'Hue', color: true, desc: 'Changes only the hue. Saturation and lightness stay, so muted tones stay muted.' },
        solid: { label: 'Solid', color: true, desc: 'Every color becomes exactly your color. Best for single-color icons and logos.' },
        grayscale: { label: 'Grayscale', color: false, desc: 'Converts every color to its gray equivalent.' },
        adjust: { label: 'Original', color: false, desc: 'Keeps the original colors, so only step 3 (Adjust) changes them.' },
    };
    const MODE_KEYS = Object.keys(MODES);
    const F = window.SvgFormats; // code formats, see formats.js

    // Engine (normalize, palette, apply) lives in engine.js and mirrors recolor.py.
    const Engine = window.SvgEngine;
    const NAMED = Engine.NAMED;

    // ------------------------------------------------------------------
    // DOM helpers and state
    // ------------------------------------------------------------------
    const $ = (id) => document.getElementById(id);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));
    const root = document.documentElement;
    const store = {
        get(k, d) { try { const v = localStorage.getItem('svgr:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
        set(k, v) { try { localStorage.setItem('svgr:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    };

    const state = {
        doc: null, // { name, size, text, norm, palette: [[hex, count]], fromUrl, source: file|link|code|example }
        result: null, // { svg, filename, palette: [{from, to, count}] }
        mode: 'colorize',
        color: '#FF0066',
        adj: { hue: 0, saturation: 0, lightness: 0 },
        tab: 'preview',
        format: 'svg', // set from storage at start
        snippet: 'curl', // set from storage at start
        // Per-color edits on top of the style, keyed by original color (6-digit hex):
        // { op: 'replace', to: '#rrggbb' } | { op: 'remove' } (Invisible) | { op: 'cut' } (Cut out)
        // | { op: 'hide' } (older links; shown as Invisible)
        edits: {},
        gap: 0, // gaps between original colors (units of a 128-unit icon); 0 = off
        gapsAuto: false, // gaps only where the holes don't already show the parts
        lineCenter: false, // lines centered on the edges (half outside) instead of inside them
        merge: 0, // simplify: colors this close (RGB distance) are one part; 0 = off
        detail: 0, // simplify: pieces and holes smaller than this size go; 0 = off
        line: 0, // line version: band width along the edges (same units); 0 = off
        unit: 'px', // gap and line sizes: 'px' (the SVG's own units) or '%' of the icon
        svgo: false, // optimize the result with SVGO
        recipe: null, // { name, params }: the recipe in use, shown at the top
        holes: false, // light (near-white) colors become holes, unless edited
        outlines: false, // outline colors become gaps (the geometry finds them)
        colorAuto: false, // the color is each SVG's most prominent one (state.color holds it)
        recipeSet: null, // [{ name, suffix, params }]: the recipes of a link with several
        canvas: null, // [w, h] of a new viewBox (null = the SVG's own)
        batch: null, // [{ name, text, size, failed }]: several SVGs with the same settings
        fit: null, // auto Fit: padding (each SVG is fitted to the canvas), or null
        place: null, // [x, y, scale]: where the original viewBox's top-left lands, and its scale (null = centered, 100 %)
        lineInner: true, // lines also between colors, not just around the whole shape
        linePlain: false, // lines of the one-colour version (made first) instead
        keep: new Set(), // colors that stay filled in the line version
    };
    const mapCache = new Map();
    let reqId = 0;
    let debounceTimer = null;
    let urlTimer = null;
    let originalUrl = null;
    let resultUrl = null;

    const stage = $('stage');
    const fileInput = $('files');
    const hexInput = $('hex-input');
    const downloadBtn = $('download-btn');

    function formatBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(2) + ' MB';
    }
    function normalizeHex(value) {
        let v = String(value || '').trim().replace(/^#/, '').toLowerCase();
        if (NAMED[v]) v = NAMED[v];
        if (/^[0-9a-f]{3}$/.test(v)) v = v.split('').map((c) => c + c).join('');
        return /^[0-9a-f]{6}$/.test(v) ? '#' + v.toUpperCase() : null;
    }
    function showError(msg) {
        $('error-text').textContent = msg;
        const box = $('error-message');
        box.hidden = true;
        void box.offsetWidth;
        box.hidden = false;
    }
    function clearError() { $('error-message').hidden = true; }
    $('error-close').addEventListener('click', clearError);
    let toastTimer;
    function toast(msg) {
        const t = $('toast');
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
    }
    function setStatus(kind, text) {
        $('status').className = 'status ' + (kind || '');
        $('status-text').textContent = text;
        if (kind === 'work') {
            // The overlay on the picture says the same, with a bar when there's a percentage.
            $('work-text').textContent = text;
            const pct = /(\d+)%\s*$/.exec(text);
            $('work-overlay').classList.toggle('indeterminate', !pct);
            $('work-bar').style.width = pct ? pct[1] + '%' : '';
        }
    }
    async function copyText(text, label) {
        try {
            await navigator.clipboard.writeText(text);
            toast(label + ' copied to clipboard');
            return true;
        } catch (e) {
            showError('Your browser blocked clipboard access. Select the text and copy it manually.');
            return false;
        }
    }

    // ------------------------------------------------------------------
    // Code blocks: syntax highlighting (highlight.js) and a Copy button on each
    // ------------------------------------------------------------------
    const Hl = window.SvgHighlight;
    const HIGHLIGHT_LIMIT = 150000; // bigger inputs show plain, to keep typing smooth
    function showCode(el, text, lang) {
        if (!Hl || text.length > HIGHLIGHT_LIMIT) el.textContent = text;
        else Hl.render(el, text, lang);
    }
    const copySources = new Map(); // <pre> id -> () => [full text, label]
    // The Code and API views get a header bar (language on the left, Copy on the
    // right); small blocks get Copy in the button row under them. Never on the code.
    function setupCodeBlock(pre) {
        const fill = pre.classList.contains('fill');
        const pane = pre.classList.contains('side-code'); // the code next to the picture
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = pane ? 'copy-chip side-copy' : fill ? 'copy-chip' : 'btn btn-ghost btn-sm copy-btn-row';
        btn.title = 'Copy all (or focus the code and press Ctrl+C)';
        btn.setAttribute('aria-label', 'Copy ' + (pre.getAttribute('aria-label') || 'code').toLowerCase());
        const label = document.createElement('span');
        label.textContent = 'Copy';
        btn.append($('copy-btn').querySelector('svg').cloneNode(true), label);
        let reset = null;
        const copy = async () => {
            const src = copySources.get(pre.id);
            const [text, name] = src ? src() : [pre.textContent, pre.dataset.copyLabel || 'Code'];
            if (!text || !text.trim()) return;
            if (await copyText(text, name)) {
                btn.classList.add('done');
                label.textContent = 'Copied';
                clearTimeout(reset);
                reset = setTimeout(() => { btn.classList.remove('done'); label.textContent = 'Copy'; }, 1600);
            }
        };
        btn.addEventListener('click', copy);
        // Ctrl/Cmd+A selects just this code (not the page); Ctrl/Cmd+C with nothing or all of it
        // selected copies the whole of it (also what a long view leaves out).
        pre.addEventListener('keydown', (e) => {
            if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
            const key = e.key.toLowerCase();
            if (key === 'a') {
                e.preventDefault();
                const range = document.createRange();
                range.selectNodeContents(pre);
                const sel = window.getSelection();
                sel.empty();
                sel.addRange(range);
            } else if (key === 'c') {
                const sel = String(window.getSelection());
                if (!sel || sel.replace(/\s+/g, '') === pre.textContent.replace(/\s+/g, '')) {
                    e.preventDefault();
                    copy();
                }
            }
        });
        if (pane) {
            pre.parentElement.appendChild(btn);
        } else if (fill) {
            const box = document.createElement('div');
            box.className = 'code-box';
            const head = document.createElement('div');
            head.className = 'code-head';
            const lang = document.createElement('span');
            lang.className = 'code-lang';
            lang.id = pre.id + '-lang';
            head.append(lang, btn);
            pre.replaceWith(box);
            box.append(head, pre);
        } else {
            let row = pre.nextElementSibling;
            if (!row || !row.classList.contains('row')) {
                row = document.createElement('div');
                row.className = 'row';
                pre.after(row);
            }
            row.prepend(btn);
        }
        if (pre.dataset.lang) showCode(pre, pre.textContent, pre.dataset.lang);
    }
    function setCodeLang(id, text) { const el = $(id + '-lang'); if (el) el.textContent = text; }
    $$('pre.code, pre.side-code').forEach(setupCodeBlock);
    copySources.set('side-code', () => (state.result ? [state.result.svg, 'SVG'] : ['', '']));

    async function errorDetail(res) {
        const body = await res.text();
        try {
            const d = JSON.parse(body).detail;
            if (typeof d === 'string') return d;
            if (Array.isArray(d) && d[0] && d[0].msg) return d[0].msg;
        } catch (e) { /* not JSON */ }
        return 'The server answered ' + res.status + '. Please try again.';
    }
    function renderImage(container, url, alt) {
        // <img> keeps any script inside the SVG from running on this page.
        const img = document.createElement('img');
        img.src = url;
        img.alt = alt;
        img.decoding = 'async';
        const token = (container.renderToken || 0) + 1;
        container.renderToken = token;
        const show = () => {
            if (container.renderToken !== token) return; // a newer picture is on its way
            if (!img.naturalWidth) img.classList.add('fill');
            container.replaceChildren(img);
        };
        // No blink: the old picture stays until the new one is decoded and ready to draw.
        if (container.querySelector('img') && img.decode) img.decode().then(show, show);
        else show();
    }

    // ------------------------------------------------------------------
    // Theme
    // ------------------------------------------------------------------
    function syncThemeIcons() {
        const dark = root.dataset.theme !== 'light';
        document.querySelector('.i-sun').style.display = dark ? '' : 'none';
        document.querySelector('.i-moon').style.display = dark ? 'none' : '';
    }
    syncThemeIcons();
    $('theme-toggle').addEventListener('click', () => {
        root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
        try { localStorage.setItem('theme', root.dataset.theme); } catch (e) { /* ignore */ }
        syncThemeIcons();
    });

    // ------------------------------------------------------------------
    // Settings: mode, color, fine-tune
    // ------------------------------------------------------------------
    function settingsParams(mode, color = state.color) {
        mode = mode || state.mode;
        const q = new URLSearchParams();
        if (MODES[mode].color) q.set('color', color.slice(1).toLowerCase());
        q.set('mode', mode);
        for (const k of ['hue', 'saturation', 'lightness']) if (state.adj[k]) q.set(k, state.adj[k]);
        return q;
    }
    // Edits as API parameters (replace=old:new,...&hide=...&remove=...). Kept out of
    // settingsParams, which also keys the cached /api/map-colors requests.
    function editParams(q) {
        q = q || new URLSearchParams();
        const by = { replace: [], hide: [], remove: [], cut: [] };
        for (const [c, e] of Object.entries(state.edits)) by[e.op].push(e.op === 'replace' ? c + ':' + e.to.slice(1).toLowerCase() : c);
        for (const k of ['replace', 'hide', 'remove', 'cut']) if (by[k].length) q.set(k, by[k].join(','));
        if (state.merge) q.set('merge', String(state.merge));
        if (state.detail) q.set('detail', String(state.detail));
        if (state.gap) q.set('gap', String(state.gap));
        if (state.gap && state.gapsAuto) q.set('gaps', 'auto');
        if ((state.gap || state.line || state.detail) && state.unit === '%') q.set('unit', 'pct');
        if (state.holes) q.set('holes', 'light');
        if (state.outlines) q.set('outlines', 'gap');
        if (state.svgo) q.set('optimize', '1');
        if (state.canvas) q.set('canvas', state.canvas.map(fmt).join('x'));
        if (state.fit !== null) q.set('fit', fmt(state.fit));
        else if (state.place) q.set('place', state.place.map(fmt).join(','));
        if (state.line) {
            q.set('line', String(state.line));
            if (state.linePlain) q.set('lines', 'plain');
            else if (!state.lineInner) q.set('lines', 'outer');
            if (state.lineCenter) q.set('linealign', 'center');
            if (state.keep.size) q.set('keep', [...state.keep].join(','));
        }
        return q;
    }
    function editsFromParams(q) {
        const edits = {};
        const hex = (v) => { const h = normalizeHex(v); return h ? h.slice(1).toLowerCase() : null; };
        for (const pair of (q.get('replace') || '').split(',')) {
            const [a, b] = pair.split(':'); const from = hex(a), to = normalizeHex(b || '');
            if (from && to) edits[from] = { op: 'replace', to };
        }
        for (const op of ['hide', 'remove', 'cut']) for (const v of (q.get(op) || '').split(',')) { const c = hex(v); if (c) edits[c] = { op }; }
        return edits;
    }
    // ------------------------------------------------------------------
    // Canvas: a new viewBox size, and where the drawing sits on it. The drawing is wrapped
    // in one <g transform>, so recoloring and the geometry steps work as before.
    // ------------------------------------------------------------------
    const fmt = (n) => String(+(+n).toFixed(3));
    function rootTag(norm) { return (/<svg\b[^>]*>/i.exec(norm) || [''])[0]; }
    // The SVG's own box: its viewBox, else its width and height, else 128 x 128.
    function origBox(doc) {
        const tag = doc ? rootTag(doc.norm) : '';
        const vb = /\sviewBox\s*=\s*["']\s*([-\d.eE+]+)[\s,]+([-\d.eE+]+)[\s,]+([\d.eE+]+)[\s,]+([\d.eE+]+)/i.exec(tag);
        if (vb && +vb[3] > 0 && +vb[4] > 0) return [+vb[1], +vb[2], +vb[3], +vb[4]];
        const num = (name) => { const m = new RegExp('\\s' + name + '\\s*=\\s*["\']?\\s*([\\d.]+)(px)?["\'\\s>/]', 'i').exec(tag); return m ? +m[1] : 0; };
        const w = num('width'), h = num('height');
        return w > 0 && h > 0 ? [0, 0, w, h] : [0, 0, 128, 128];
    }
    function canvasSize(doc) { return state.canvas || origBox(doc).slice(2); }
    function placement(doc, place = state.place) {
        if (place) return place;
        const [, , w0, h0] = origBox(doc);
        const [W, H] = canvasSize(doc);
        return [(W - w0) / 2, (H - h0) / 2, 1];
    }
    function placed(doc, norm, place = state.place) {
        norm = norm || doc.norm;
        if (!state.canvas && !place) return norm;
        const tag = rootTag(norm);
        const at = norm.indexOf(tag);
        const end = norm.lastIndexOf('</svg');
        if (!tag || end < at) return norm;
        const [x0, y0, w0, h0] = origBox(doc);
        const [W, H] = canvasSize(doc);
        const [tx, ty, s] = placement(doc, place);
        let open = tag.replace(/\sviewBox\s*=\s*("[^"]*"|'[^']*')/i, '');
        // A width/height on the root keeps its scale: it grows with the canvas.
        open = open.replace(/(\s(width|height)\s*=\s*["']?\s*)([\d.]+)/gi, (all, pre, name, v) => pre + fmt(+v * (/^w/i.test(name) ? W / w0 : H / h0)));
        open = open.replace(/^<svg\b/i, '<svg viewBox="0 0 ' + fmt(W) + ' ' + fmt(H) + '"');
        const g = '<g transform="matrix(' + [s, 0, 0, s, tx - s * x0, ty - s * y0].map(fmt).join(' ') + ')">';
        return norm.slice(0, at) + open + g + norm.slice(at + tag.length, end) + '</g>' + norm.slice(end);
    }
    function syncCanvasUI() {
        const doc = state.doc;
        const [W, H] = canvasSize(doc);
        const [tx, ty, s] = placement(doc);
        const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = fmt(v); };
        set('canvas-w', W);
        set('canvas-h', H);
        set('place-s', +(s * 100).toFixed(2));
        set('place-x', tx);
        set('place-y', ty);
        $('canvas-reset').hidden = !state.canvas && !state.place;
        $('canvas-size').hidden = !doc;
        $('canvas-size').classList.toggle('changed', !!state.canvas);
        updateFolds();
    }
    function canvasChanged() {
        syncCanvasUI();
        editsChanged();
    }
    function setCanvas(W, H) {
        if (!(W > 0 && H > 0)) return;
        const [W0, H0] = canvasSize(state.doc);
        // Keep the drawing where it is relative to the middle of the canvas.
        if (state.place) state.place = [state.place[0] + (W - W0) / 2, state.place[1] + (H - H0) / 2, state.place[2]];
        const [, , w0, h0] = origBox(state.doc);
        state.canvas = W === w0 && H === h0 && !state.place ? null : [W, H];
        if (state.fit !== null) { state.canvas = [W, H]; fitToCanvas(false); return; } // auto Fit: fit the new canvas
        canvasChanged();
    }
    function setScale(s) {
        if (!(s > 0)) return;
        const [, , w0, h0] = origBox(state.doc);
        const [tx, ty, s0] = placement(state.doc);
        // Scale around the middle of the drawing.
        const cx = tx + (s0 * w0) / 2, cy = ty + (s0 * h0) / 2;
        state.fit = null; // placed by hand now
        state.place = [cx - (s * w0) / 2, cy - (s * h0) / 2, s];
        if (!state.canvas) state.canvas = canvasSize(state.doc);
        canvasChanged();
    }
    function setPosition(x, y) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        state.fit = null;
        state.place = [x, y, placement(state.doc)[2]];
        if (!state.canvas) state.canvas = canvasSize(state.doc);
        canvasChanged();
    }
    async function fitToCanvas(center) {
        if (!state.doc) return showError('Add an SVG first: drop a file, paste one, or load a link.');
        const btn = $(center ? 'center-btn' : 'fit-btn');
        btn.classList.add('loading');
        btn.disabled = true;
        setBusy(true, 'fit');
        setStatus('work', 'Measuring the drawing…');
        try {
            await fitToCanvasNow(center);
        } finally {
            btn.classList.remove('loading');
            btn.disabled = false;
            setBusy(false, 'fit');
        }
    }
    // Where `doc` goes to fill the canvas minus `pad` (or, with a scale, just centered):
    // measured on what's visible after the color edits (invisible and cut-out colors don't count).
    async function fitPlacement(doc, pad, scale) {
        const [x0, y0] = origBox(doc);
        const [W, H] = canvasSize(doc);
        const hidden = Object.entries(editsOf(doc)).filter(([, e]) => e.op !== 'replace').map(([c]) => c);
        const Geo = await loadGeometry();
        const box = Geo.bounds(Engine.edit(doc.norm, [], hidden));
        if (!box) throw new Error('Nothing visible to fit.');
        const [bx, by, bw, bh] = box;
        const s = scale || Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh);
        if (!(s > 0)) throw new Error('The padding leaves no room on this canvas.');
        // Map the box's corner so the box is centered: s * (bx - x0) + tx = (W - s * bw) / 2.
        return [(W - s * bw) / 2 - s * (bx - x0), (H - s * bh) / 2 - s * (by - y0), s];
    }
    async function fitToCanvasNow(center) {
        const doc = state.doc;
        const [W, H] = canvasSize(doc);
        const pad = Math.max(0, parseFloat($('fit-pad').value) || 0);
        let place;
        try {
            place = await fitPlacement(doc, pad, center ? placement(doc)[2] : 0);
        } catch (err) {
            return showError(err.message);
        }
        if (doc !== state.doc) return;
        state.place = place;
        if (!state.canvas) state.canvas = [W, H];
        state.fit = center ? null : pad; // Fit stays on: the next SVG (or canvas size) is fitted too
        canvasChanged();
        toast(center ? 'Centered' : 'Fitted to ' + fmt(W) + ' × ' + fmt(H) + (pad ? ' with ' + fmt(pad) + ' padding' : ''));
    }
    const numVal = (id) => parseFloat($(id).value);
    $('canvas-w').addEventListener('change', () => setCanvas(numVal('canvas-w'), canvasSize(state.doc)[1]));
    $('canvas-h').addEventListener('change', () => setCanvas(canvasSize(state.doc)[0], numVal('canvas-h')));
    $('place-s').addEventListener('change', () => setScale(numVal('place-s') / 100));
    $('place-x').addEventListener('change', () => setPosition(numVal('place-x'), placement(state.doc)[1]));
    $('place-y').addEventListener('change', () => setPosition(placement(state.doc)[0], numVal('place-y')));
    $$('#canvas-step input').forEach((el) => el.addEventListener('blur', syncCanvasUI));
    $('fit-btn').addEventListener('click', () => fitToCanvas(false));
    $('center-btn').addEventListener('click', () => fitToCanvas(true));
    $('canvas-reset').addEventListener('click', () => { state.canvas = null; state.place = null; state.fit = null; canvasChanged(); });
    $('fit-pad').addEventListener('change', () => { if (state.fit !== null && state.doc) fitToCanvas(false); });

    // Collapsible sections: closed by default (less scrolling), the header says what's set,
    // and each remembers being opened.
    const foldsOpen = store.get('folds', {});
    $$('details.fold').forEach((d) => {
        if (foldsOpen[d.dataset.fold]) d.open = true;
        d.addEventListener('toggle', () => { foldsOpen[d.dataset.fold] = d.open; store.set('folds', foldsOpen); });
    });
    function updateFolds() {
        const shape = [];
        if (state.merge || state.detail) shape.push('simplified');
        if (state.gap) shape.push('gaps ' + unitText(state.gap));
        if (state.line) shape.push((state.linePlain ? 'one-color line ' : state.lineInner ? 'line ' : 'outline ') + unitText(state.line));
        $('shape-sub').textContent = shape.length ? shape.join(' · ') : 'gaps and line versions';
        $('shape-step').classList.toggle('active', shape.length > 0);
        const placedNow = !!(state.canvas || state.place);
        let sub = 'as it is';
        if (placedNow && state.doc) {
            const [W, H] = canvasSize(state.doc);
            sub = fmt(W) + ' × ' + fmt(H) + ' · ' + (state.fit !== null ? 'fit, padding ' + fmt(state.fit) : fmt(placement(state.doc)[2] * 100) + ' %');
        }
        $('canvas-sub').textContent = sub;
        $('canvas-step').classList.toggle('active', placedNow);
        $('adjust-step').classList.toggle('active', Object.values(state.adj).some((v) => v));
    }

    // ------------------------------------------------------------------
    // Optimize: SVGO in a worker, with devicon's settings by default (its svg-icons
    // svgo.config.js: SVGO 3.3.2, multipass, precision 3, every preset plugin but
    // removeViewBox, a few extra ones, and a newline at the end).
    // ------------------------------------------------------------------
    const SVGO_PRESET = ['removeDoctype', 'removeXMLProcInst', 'removeComments', 'removeMetadata', 'removeEditorsNSData',
        'cleanupAttrs', 'mergeStyles', 'inlineStyles', 'minifyStyles', 'cleanupIds', 'removeUselessDefs', 'cleanupNumericValues',
        'convertColors', 'removeUnknownsAndDefaults', 'removeNonInheritableGroupAttrs', 'removeUselessStrokeAndFill', 'removeViewBox',
        'cleanupEnableBackground', 'removeHiddenElems', 'removeEmptyText', 'convertShapeToPath', 'convertEllipseToCircle',
        'moveElemsAttrsToGroup', 'moveGroupAttrsToElems', 'collapseGroups', 'convertPathData', 'convertTransform', 'removeEmptyAttrs',
        'removeEmptyContainers', 'mergePaths', 'removeUnusedNS', 'sortAttrs', 'sortDefsChildren', 'removeTitle', 'removeDesc'];
    const SVGO_EXTRA = ['removeDimensions', 'removeStyleElement', 'convertStyleToAttrs', 'removeScriptElement', 'removeOffCanvasPaths',
        'convertOneStopGradients', 'removeSvgXY', 'removeXMLNS', 'removeRasterImages', 'removeXlink', 'reusePaths'];
    const SVGO_LABEL = {
        removeSvgXY: 'Remove x and y on <svg>', removeXMLProcInst: 'Remove XML instructions', removeEditorsNSData: 'Remove editor data',
        removeViewBox: 'Remove viewBox', removeXMLNS: 'Remove xmlns', removeNonInheritableGroupAttrs: 'Remove non-inheritable group attributes',
        cleanupAttrs: 'Clean up attributes', cleanupIds: 'Clean up IDs', removeUselessDefs: 'Remove unused defs', removeElemsAttrs: 'Remove element attributes',
        moveElemsAttrsToGroup: 'Move attributes to group', moveGroupAttrsToElems: 'Move group attributes to elements', removeEmptyAttrs: 'Remove empty attributes',
        sortAttrs: 'Sort attributes', removeOffCanvasPaths: 'Remove off-canvas paths', removeXlink: 'Remove xlink', convertOneStopGradients: 'Convert one-stop gradients',
    };
    const SVGO_OFF = new Set(['removeViewBox', 'removeXMLNS', 'removeRasterImages', 'removeXlink', 'reusePaths']);
    const svgoDefaults = () => ({
        precision: 3, multipass: true, newline: true,
        plugins: Object.fromEntries([...SVGO_PRESET, ...SVGO_EXTRA].map((n) => [n, !SVGO_OFF.has(n)])),
    });
    let svgoSettings = Object.assign(svgoDefaults(), store.get('svgo-settings', {}));
    svgoSettings.plugins = Object.assign(svgoDefaults().plugins, svgoSettings.plugins || {});
    function svgoConfig(set) {
        const on = (n) => !!set.plugins[n];
        const overrides = {};
        SVGO_PRESET.forEach((n) => { if (!on(n)) overrides[n] = false; });
        // devicon's choices: colors stay #hex, <style> classes are inlined even when reused, short ids
        if (on('inlineStyles')) overrides.inlineStyles = { onlyMatchedOnce: false };
        if (on('convertColors')) overrides.convertColors = { shortname: false };
        if (on('cleanupIds')) overrides.cleanupIds = { minify: true };
        const plugins = [{ name: 'preset-default', params: { overrides } }];
        SVGO_EXTRA.forEach((n) => {
            if (!on(n)) return;
            plugins.push(n === 'removeSvgXY' ? { name: 'removeAttrs', params: { attrs: 'svg:(x|y)' } } : n);
        });
        return { multipass: !!set.multipass, floatPrecision: Math.max(0, Math.min(8, Math.round(set.precision))), plugins };
    }
    const svgoDefaultExceptPrecision = () => JSON.stringify(Object.assign({}, svgoSettings, { precision: 3 })) === JSON.stringify(svgoDefaults());
    const isDeviconSvgo = () => JSON.stringify(svgoSettings) === JSON.stringify(svgoDefaults());
    function renderSvgoSettings() {
        $('svgo-precision').value = String(svgoSettings.precision);
        $('svgo-multipass').checked = !!svgoSettings.multipass;
        $('svgo-newline').checked = !!svgoSettings.newline;
        const box = $('svgo-plugins');
        box.replaceChildren();
        // removeUselessStrokeAndFill -> "Remove useless stroke and fill", with the plugin name under it
        const human = (n) => (SVGO_LABEL[n] || n.replace(/([A-Z]+)/g, ' $1').toLowerCase().replace(/^./, (c) => c.toUpperCase()))
            .replace(/\bxml\b/gi, 'XML').replace(/\bns\b/gi, 'NS').replace(/\bids\b/gi, 'IDs').replace(/\bsvg\b/gi, 'SVG').replace(/\bxmlns\b/gi, 'xmlns');
        for (const [title, names] of [['Preset (preset-default)', SVGO_PRESET], ['Extra plugins', SVGO_EXTRA]]) {
            const h = document.createElement('h3');
            h.textContent = title;
            box.appendChild(h);
            names.forEach((n) => {
                const label = document.createElement('label');
                label.className = 'check';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = !!svgoSettings.plugins[n];
                cb.dataset.plugin = n;
                const text = document.createElement('span');
                text.textContent = human(n);
                const small = document.createElement('small');
                small.textContent = n === 'removeSvgXY' ? 'removeAttrs svg:(x|y)' : n;
                text.appendChild(small);
                label.append(cb, text);
                box.appendChild(label);
            });
        }
        syncSvgoLabels();
    }
    function syncSvgoLabels() {
        const name = isDeviconSvgo() ? 'Default' : 'Custom';
        $('svgo-preset').textContent = name;
        $('svgo-preset-dialog').textContent = name;
        updateOptimizeFold();
    }
    function updateOptimizeFold() {
        const sub = state.svgo ? 'on · ' + (isDeviconSvgo() ? 'default settings' : 'custom settings') : 'off';
        $('optimize-sub').textContent = sub;
        $('optimize-step').classList.toggle('active', state.svgo);
    }
    function svgoSettingsChanged() {
        store.set('svgo-settings', svgoSettings);
        syncSvgoLabels();
        if (state.svgo && state.doc) recolor();
    }
    $('svgo-open').addEventListener('click', () => $('svgo-dialog').showModal());
    $('svgo-close').addEventListener('click', () => $('svgo-dialog').close());
    $('svgo-done').addEventListener('click', () => $('svgo-dialog').close());
    $('svgo-precision').addEventListener('change', () => { svgoSettings.precision = parseInt($('svgo-precision').value, 10) || 0; svgoSettingsChanged(); });
    $('svgo-multipass').addEventListener('change', (e) => { svgoSettings.multipass = e.target.checked; svgoSettingsChanged(); });
    $('svgo-newline').addEventListener('change', (e) => { svgoSettings.newline = e.target.checked; svgoSettingsChanged(); });
    $('svgo-plugins').addEventListener('change', (e) => {
        if (!e.target.dataset.plugin) return;
        svgoSettings.plugins[e.target.dataset.plugin] = e.target.checked;
        svgoSettingsChanged();
    });
    $('svgo-reset').addEventListener('click', () => { svgoSettings = svgoDefaults(); renderSvgoSettings(); svgoSettingsChanged(); });
    $('svgo-toggle').addEventListener('change', (e) => { state.svgo = e.target.checked; updateOptimizeFold(); editsChanged(); });
    $('holes-toggle').addEventListener('change', (e) => { state.holes = e.target.checked; editsChanged(); });
    $('outlines-toggle').addEventListener('change', (e) => { state.outlines = e.target.checked; editsChanged(); });
    $('gaps-auto-toggle').addEventListener('change', (e) => { state.gapsAuto = e.target.checked; if (state.gap) editsChanged(); else syncPageUrl(); });
    $('line-center-toggle').addEventListener('change', (e) => { state.lineCenter = e.target.checked; if (state.line) editsChanged(); else syncPageUrl(); });
    renderSvgoSettings();

    let svgoWorker = null, svgoJobs = 0;
    const svgoPending = new Map();
    function optimizeSvg(svg) {
        if (!svgoWorker) {
            setStatus('work', 'Loading SVGO…');
            svgoWorker = new Worker(CFG.optimizeUrl || '/static/optimize-worker.js', { type: 'module' });
            svgoWorker.onmessage = (e) => {
                const job = svgoPending.get(e.data.id);
                if (!job) return;
                svgoPending.delete(e.data.id);
                if (e.data.error) job.reject(new Error('SVGO could not optimize this SVG: ' + e.data.error));
                else job.resolve(e.data.svg);
            };
            svgoWorker.onerror = (e) => {
                e.preventDefault();
                svgoWorker = null;
                svgoPending.forEach((job) => job.reject(new Error('SVGO could not load. Check your connection and try again.')));
                svgoPending.clear();
            };
        }
        const id = ++svgoJobs;
        const set = svgoSettings;
        return new Promise((resolve, reject) => {
            svgoPending.set(id, { resolve: (out) => resolve(set.newline ? out.replace(/\s*$/, '') + '\n' : out), reject });
            svgoWorker.postMessage({ id, svg, config: svgoConfig(set) });
        });
    }

    // The mapping with own colors applied, and the SVG with invisible colors applied.
    // Cut-out colors are left in `edited` for the geometry step (cutOutSvg); `svg` treats
    // them as invisible, which is what the quick style thumbnails show.
    // The color edits in effect: yours, plus with "Light colors become holes" the near-white
    // colors you haven't edited, cut out: every channel 224 or more, or a pale tint close to
    // gray (every channel 200 or more, within 48 of each other). As server/shapes.py.
    const isLight = (c) => c.length === 6 && ((x) => Math.min(...x) >= 0xe0 || (Math.min(...x) >= 0xc8 && Math.max(...x) - Math.min(...x) <= 48))([0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)));
    function editsOf(doc) {
        if (!state.holes || !doc) return state.edits;
        const out = Object.assign({}, state.edits);
        for (const [c] of doc.palette) if (!out[c] && isLight(c)) out[c] = { op: 'cut', auto: true };
        return out;
    }
    function editedSvg(doc, mapping, place = state.place) {
        const merged = Object.assign({}, mapping);
        const hide = [], remove = [], cut = [], holes = [];
        for (const [c, e] of Object.entries(editsOf(doc))) {
            if (e.op === 'replace') merged[c] = e.to.slice(1).toLowerCase();
            else if (e.auto) holes.push(c); // light: a hole or a part, the geometry decides
            else ({ hide, remove, cut })[e.op].push(c);
        }
        const edited = Engine.edit(placed(doc, null, place), hide, remove);
        const svg = cut.length ? Engine.apply(Engine.edit(edited, [], cut), merged) : Engine.apply(edited, merged);
        return { svg, merged, edited, cut, holes };
    }
    // Cut out: real geometry (paper.js), loaded the first time it's needed.
    let geometryReady = null;
    function loadGeometry() {
        if (window.SvgGeometry) return Promise.resolve(window.SvgGeometry);
        if (!geometryReady) {
            setStatus('work', 'Loading the geometry library…');
            geometryReady = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = CFG.geometryUrl || '/assets/geometry.js';
                s.onload = () => (window.SvgGeometry ? resolve(window.SvgGeometry) : reject(new Error('Cut out could not load.')));
                s.onerror = () => { geometryReady = null; reject(new Error('Cut out could not load. Check your connection and try again.')); };
                document.head.appendChild(s);
            });
        }
        return geometryReady;
    }
    // ------------------------------------------------------------------
    // Text into shapes (for cut out, gaps and lines, which work on shapes): drawn with
    // opentype.js in the font of your choice, or Inter when none is chosen. Loaded on use.
    // ------------------------------------------------------------------
    let textFont = null; // { name, font }
    let opentypeReady = null;
    function loadOpentype() {
        if (window.opentype) return Promise.resolve(window.opentype);
        if (!opentypeReady) {
            setStatus('work', 'Loading fonts…');
            opentypeReady = new Promise((resolve, reject) => {
                const sc = document.createElement('script');
                sc.src = '/static/vendor/opentype.min.js';
                sc.onload = () => (window.opentype ? resolve(window.opentype) : reject(new Error('Fonts could not load.')));
                sc.onerror = () => { opentypeReady = null; reject(new Error('Fonts could not load. Check your connection and try again.')); };
                document.head.appendChild(sc);
            });
        }
        return opentypeReady;
    }
    async function currentFont() {
        if (textFont) return textFont;
        const ot = await loadOpentype();
        const res = await fetch('/static/vendor/inter-latin-400.woff');
        if (!res.ok) throw new Error('The fallback font could not load.');
        textFont = { name: 'Inter', font: ot.parse(await res.arrayBuffer()), fallback: true };
        return textFont;
    }
    $('text-font-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
            const ot = await loadOpentype();
            textFont = { name: file.name.replace(/\.(ttf|otf|woff)$/i, ''), font: ot.parse(await file.arrayBuffer()) };
            $('text-font-name').textContent = textFont.name;
            toast('Text now drawn with ' + textFont.name);
            if (state.doc) recolor();
        } catch (err) {
            showError('That font could not be read: ' + err.message + ' (TTF, OTF and WOFF work; WOFF2 doesn\'t yet).');
        }
    });
    // Replace each <text> with paths of its glyphs, keeping its paint, class and transform.
    async function textToShapes(svgText) {
        if (!/<text\b/i.test(svgText)) return svgText;
        const { font, name, fallback } = await currentFont();
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const NS = 'http://www.w3.org/2000/svg';
        const own = (el, prop) => {
            const style = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'i').exec(el.getAttribute('style') || '');
            return style ? style[1].trim() : el.getAttribute(prop);
        };
        const inherited = (el, prop, dflt) => {
            for (let e = el; e && e.nodeType === 1; e = e.parentNode) { const v = own(e, prop); if (v !== null && v !== '') return v; }
            return dflt;
        };
        const num = (v) => parseFloat(String(v || '').split(/[\s,]+/)[0]);
        for (const text of [...doc.querySelectorAll('text')]) {
            const size = num(inherited(text, 'font-size', '16')) || 16;
            const anchor = inherited(text, 'text-anchor', 'start');
            let x = num(text.getAttribute('x')) || 0, y = num(text.getAttribute('y')) || 0;
            x += num(text.getAttribute('dx')) || 0;
            y += num(text.getAttribute('dy')) || 0;
            // Runs of text: the text's own characters and its <tspan>s (which may move the pen).
            const runs = [];
            const walk = (node, el) => {
                for (const ch of node.childNodes) {
                    if (ch.nodeType === 3) {
                        const t = ch.textContent.replace(/\s+/g, ' ');
                        if (t.trim() || runs.length) runs.push({ el, text: t });
                    } else if (ch.nodeType === 1 && ch.localName === 'tspan') {
                        runs.push({ el: ch, move: true });
                        walk(ch, ch);
                    }
                }
            };
            walk(text, text);
            const g = doc.createElementNS(NS, 'g');
            for (const a of [...text.attributes]) if (!/^(x|y|dx|dy|font-.*|text-anchor|letter-spacing|word-spacing|dominant-baseline|style)$/.test(a.name)) g.setAttribute(a.name, a.value);
            const style = (text.getAttribute('style') || '').split(';').filter((d) => d.trim() && !/^\s*(font|text-anchor|letter-spacing|word-spacing)/i.test(d)).join(';');
            if (style) g.setAttribute('style', style);
            const line = [];
            let width = 0;
            for (const run of runs) {
                if (run.move) {
                    if (run.el.hasAttribute('x')) { x = num(run.el.getAttribute('x')); }
                    if (run.el.hasAttribute('y')) { y = num(run.el.getAttribute('y')); }
                    x += num(run.el.getAttribute('dx')) || 0;
                    y += num(run.el.getAttribute('dy')) || 0;
                    continue;
                }
                const s = num(inherited(run.el, 'font-size', String(size))) || size;
                const path = font.getPath(run.text, x, y, s);
                const p = doc.createElementNS(NS, 'path');
                p.setAttribute('d', path.toPathData(3));
                if (run.el !== text) {
                    for (const prop of ['fill', 'stroke', 'stroke-width', 'opacity', 'class']) { const v = own(run.el, prop); if (v) p.setAttribute(prop, v); }
                }
                line.push(p);
                const adv = font.getAdvanceWidth(run.text, s);
                x += adv;
                width += adv;
            }
            if (anchor === 'middle' || anchor === 'end') {
                const shift = 'translate(' + fmt(-(anchor === 'middle' ? width / 2 : width)) + ' 0)';
                g.setAttribute('transform', ((g.getAttribute('transform') || '') + ' ' + shift).trim());
            }
            line.forEach((p) => g.appendChild(p));
            text.replaceWith(g);
        }
        $('text-font-row').hidden = false;
        $('text-font-name').textContent = name;
        if (fallback && !textToShapes.told) { textToShapes.told = true; toast('Text turned into shapes with Inter. Choose its own font under Shapes.'); }
        return new XMLSerializer().serializeToString(doc.documentElement);
    }

    // Everything one color (like Solid)? Then the geometry can ignore gradients and transparency.
    function flatColor(doc, merged) {
        const gone = new Set(Object.entries(editsOf(doc)).filter(([, e]) => e.op !== 'replace').map(([c]) => c));
        const outs = new Set(doc.palette.map(([c]) => c).filter((c) => !gone.has(c)).map((c) => (merged[c] || c).toLowerCase()));
        return outs.size === 1 ? [...outs][0] : null;
    }
    // `info.holed`: which light colors became holes (the rest stayed parts of the logo).
    async function cutOutSvg(edited, cut, merged, onProgress, doc = state.doc, holes = [], info = {}) {
        const Geo = await loadGeometry();
        edited = await textToShapes(edited);
        const out = await Geo.cutOut(edited, {
            flat: doc ? flatColor(doc, merged) : null,
            cut, holes, outlines: state.outlines, map: merged, gap: state.gap, unit: state.unit, onProgress,
            merge: state.merge, detail: state.detail, lineAlign: state.lineCenter ? 'center' : null, gaps: state.gapsAuto ? 'auto' : null,
            line: state.line, lineInner: state.lineInner, linePlain: state.linePlain, keep: [...state.keep],
        });
        const m = /<!--holes:([^>]*)-->/.exec(out);
        info.holed = m ? m[1].split(',').filter(Boolean) : [];
        return out.replace(/<!--holes:[^>]*-->/, '');
    }
    const gapInput = $('adj-gap');
    // Gap and line sizes: px (the SVG's own units) or % of the icon. In px the slider
    // ranges follow the SVG's size, so a 24 px icon and a 1024 px logo both get useful steps.
    const unitText = (v) => (v ? +v.toFixed(2) + (state.unit === '%' ? ' %' : ' px') : 'Off');
    function docSize(doc) {
        if (state.canvas) return Math.max(...state.canvas);
        const tag = doc && (/<svg\b[^>]*>/i.exec(doc.norm) || [''])[0];
        const vb = tag && /\sviewBox\s*=\s*["']\s*[-\d.eE+]+[\s,]+[-\d.eE+]+[\s,]+([\d.eE+]+)[\s,]+([\d.eE+]+)/i.exec(tag);
        if (vb) return Math.max(+vb[1], +vb[2]) || 128;
        const w = tag && /\swidth\s*=\s*["']?\s*([\d.]+)(px)?["'\s]/i.exec(tag), h = tag && /\sheight\s*=\s*["']?\s*([\d.]+)(px)?["'\s]/i.exec(tag);
        return Math.max(w ? +w[1] : 0, h ? +h[1] : 0) || 128;
    }
    function niceStep(x) {
        const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100];
        return [...steps].reverse().find((s) => s <= x) || steps[0];
    }
    function syncRanges() {
        const size = state.unit === '%' ? 100 : docSize(state.doc);
        // Up to 6/128 (gaps) and 8/128 (lines) of the icon: 6 and 8 px in a devicon icon.
        for (const [input, max, now] of [[gapInput, 6, state.gap], [lineInput, 8, state.line], [detailInput, 6, state.detail]]) {
            const step = state.unit === '%' ? 0.1 : niceStep(size / 256);
            input.step = String(step);
            // Never below the current value (say, from a shared link).
            input.max = String(Math.max(step, +(Math.round((max * size) / 128 / step) * step).toFixed(2), now || 0));
        }
    }
    // read: take the value from the slider (a person moved it). Otherwise the state is what
    // counts: a slider rounds to its step, and before the SVG loads its steps don't fit it yet.
    function syncGap(read = true) {
        if (read) state.gap = Math.max(0, Math.min(parseFloat(gapInput.max), parseFloat(gapInput.value) || 0));
        $('adj-gap-out').textContent = unitText(state.gap);
        $('gaps-auto-row').hidden = !state.gap;
        updateFolds();
    }
    function setUnit(unit, user) {
        if (unit === state.unit) return;
        // Keep the same look: convert the current values to the new unit.
        const size = docSize(state.doc);
        const conv = (v) => (unit === '%' ? (v * 100) / size : (v * size) / 100);
        const [gap, line, detail] = [state.gap, state.line, state.detail].map((v) => (v ? +conv(v).toFixed(2) : 0));
        state.unit = unit;
        state.gap = gap;
        state.line = line;
        state.detail = detail;
        detailInput.value = String(detail);
        syncSimplify(false);
        $$('#unit-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.unit === unit)));
        syncRanges();
        gapInput.value = String(gap);
        lineInput.value = String(line);
        syncGap(false);
        syncLine(false);
        if (user && (gap || line || detail)) editsChanged(); else if (user) syncPageUrl();
    }
    $$('#unit-tabs button').forEach((b) => b.addEventListener('click', () => setUnit(b.dataset.unit, true)));
    // Simplify: merge similar shades, drop small details. Recut when the slider rests.
    const mergeInput = $('adj-merge'), detailInput = $('adj-detail');
    function syncSimplify(read = true) {
        if (read) {
            state.merge = Math.max(0, parseFloat(mergeInput.value) || 0);
            state.detail = Math.max(0, Math.min(parseFloat(detailInput.max), parseFloat(detailInput.value) || 0));
        }
        $('adj-merge-out').textContent = state.merge ? String(state.merge) : 'Off';
        $('adj-detail-out').textContent = unitText(state.detail);
        updateFolds();
    }
    let simplifyTimer = 0;
    for (const el of [mergeInput, detailInput]) el.addEventListener('input', () => { syncSimplify(); clearTimeout(simplifyTimer); simplifyTimer = setTimeout(editsChanged, 250); });
    // Gaps are heavy on big drawings: show the value at once, recut when the slider rests.
    let gapTimer = 0;
    gapInput.addEventListener('input', () => { syncGap(); clearTimeout(gapTimer); gapTimer = setTimeout(editsChanged, 250); });
    // Line version: a band of this width along the edges (devicon "line" icons).
    const lineInput = $('adj-line');
    function syncLine(read = true) {
        if (read) state.line = Math.max(0, Math.min(parseFloat(lineInput.max), parseFloat(lineInput.value) || 0));
        $$('#line-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lines === (state.linePlain ? 'plain' : state.lineInner ? 'all' : 'outer'))));
        $('adj-line-out').textContent = unitText(state.line);
        $('line-inner-row').hidden = !state.line;
        $('line-align-row').hidden = !state.line;
        updateFolds();
        if (!editPanel.hidden) $('color-edit-keep-row').hidden = !state.line;
    }
    lineInput.addEventListener('input', () => { syncLine(); clearTimeout(gapTimer); gapTimer = setTimeout(editsChanged, 250); });
    $$('#line-mode button').forEach((b) => b.addEventListener('click', () => {
        state.lineInner = b.dataset.lines !== 'outer';
        state.linePlain = b.dataset.lines === 'plain';
        syncLine(false);
        editsChanged();
    }));
    function settingsChanged() {
        scheduleThumbs();
        updateSnippet();
        syncPageUrl();
        scheduleLive();
    }

    function setMode(mode, user) {
        if (!MODES[mode]) return;
        state.mode = mode;
        $$('.style').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
        $('mode-desc').textContent = MODES[mode].desc;
        // Step 2 only matters for styles that use a color.
        const usesColor = MODES[mode].color;
        $('color-body').hidden = !usesColor;
        $('color-note').hidden = !usesColor;
        $('color-skip').hidden = usesColor;
        $('color-skip').textContent = MODES[mode].label + ' doesn\'t use a color. Pick Tint, Colorize, Hue or Solid to recolor with one.';
        if (user) settingsChanged();
    }
    $$('.style').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode, true)));
    $('modes').addEventListener('keydown', (e) => {
        const dir = { ArrowRight: 1, ArrowDown: 3, ArrowLeft: -1, ArrowUp: -3 }[e.key];
        if (!dir) return;
        e.preventDefault();
        const i = MODE_KEYS.indexOf(state.mode);
        const next = MODE_KEYS[(i + dir + MODE_KEYS.length) % MODE_KEYS.length];
        setMode(next, true);
        document.querySelector('.style[data-mode="' + next + '"]').focus();
    });


    PRESETS.forEach((hex) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'preset';
        b.style.background = hex;
        b.title = hex;
        b.dataset.hex = hex;
        b.setAttribute('aria-label', 'Use ' + hex);
        b.addEventListener('click', () => setColor(hex, true));
        $('presets').appendChild(b);
    });
    function setColor(hex, user) {
        if (user) { state.colorAuto = false; syncAutoColor(); }
        state.color = hex;
        $('color-input').value = hex.toLowerCase();
        if (document.activeElement !== hexInput) hexInput.value = hex.slice(1);
        $('hex-field').classList.remove('invalid');
        root.style.setProperty('--pick', hex);
        $$('.preset, .logo-colors button').forEach((p) => p.setAttribute('aria-pressed', String(p.dataset.hex === hex)));
        if (user) settingsChanged();
    }
    $('color-input').addEventListener('input', (e) => setColor(e.target.value.toUpperCase(), true));
    function syncAutoColor() { $('auto-color').setAttribute('aria-pressed', String(state.colorAuto)); }
    $('auto-color').addEventListener('click', () => {
        state.colorAuto = !state.colorAuto;
        syncAutoColor();
        if (state.colorAuto && !MODES[state.mode].color) setMode('solid', false);
        settingsChanged();
    });
    // The big swatch opens a popover: presets, recent colors and the full picker.
    const colorPop = $('color-pop');
    function setColorPop(open) {
        colorPop.hidden = !open;
        $('swatch-btn').setAttribute('aria-expanded', String(open));
        if (open) { const first = colorPop.querySelector('[aria-pressed="true"]') || colorPop.querySelector('button'); if (first) first.focus(); }
    }
    $('swatch-btn').addEventListener('click', () => setColorPop(colorPop.hidden));
    colorPop.addEventListener('click', (e) => { if (e.target.closest('.preset, .recent button')) { setColorPop(false); $('swatch-btn').focus(); } });
    colorPop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); setColorPop(false); $('swatch-btn').focus(); } });
    document.addEventListener('pointerdown', (e) => {
        if (!colorPop.hidden && !colorPop.contains(e.target) && !e.target.closest('#swatch-btn')) setColorPop(false);
    });
    hexInput.addEventListener('input', () => {
        const hex = normalizeHex(hexInput.value);
        if (hex) setColor(hex, true);
        else $('hex-field').classList.add('invalid');
    });
    hexInput.addEventListener('blur', () => { hexInput.value = state.color.slice(1); $('hex-field').classList.remove('invalid'); });

    function rememberColor(hex) {
        const list = [hex].concat(store.get('recent', []).filter((c) => c !== hex)).slice(0, 8);
        store.set('recent', list);
        renderRecent();
    }
    // "In this SVG": its colors, most used first. Each gradient adds its two ends and the
    // color halfway along it (sRGB, as the browser draws it).
    function gradientStops(norm) {
        const out = [];
        const grads = norm.match(/<(linear|radial)Gradient\b[\s\S]*?<\/\1Gradient>/gi) || [];
        for (const g of grads) {
            const stops = [];
            for (const [tag] of g.matchAll(/<stop\b[^>]*>/gi)) {
                const color = /stop-color\s*[:=]\s*["']?\s*#([0-9a-f]{6})/i.exec(tag);
                if (!color) continue;
                const off = /offset\s*[:=]\s*["']?\s*([\d.]+)(%?)/i.exec(tag);
                let at = off ? parseFloat(off[1]) / (off[2] ? 100 : 1) : NaN;
                if (!Number.isFinite(at)) at = stops.length ? stops[stops.length - 1].at : 0;
                // Offsets never go back: a smaller one counts as the previous one.
                at = Math.max(Math.min(at, 1), stops.length ? stops[stops.length - 1].at : 0);
                stops.push({ at, hex: color[1].toLowerCase() });
            }
            if (stops.length >= 2) out.push(stops);
        }
        return out;
    }
    function gradientColorAt(stops, t) {
        const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
        const i = stops.findIndex((s) => s.at >= t);
        if (i === -1) return stops[stops.length - 1].hex;
        if (i === 0) return stops[0].hex;
        const a = stops[i - 1], b = stops[i];
        const f = b.at === a.at ? 0 : (t - a.at) / (b.at - a.at);
        const [ra, rb] = [rgb(a.hex), rgb(b.hex)];
        return ra.map((v, k) => Math.round(v + (rb[k] - v) * f).toString(16).padStart(2, '0')).join('');
    }
    function logoColors(doc) {
        const list = [];
        const seen = new Set();
        const add = (hex, title, mid) => {
            if (seen.has(hex)) return;
            seen.add(hex);
            list.push({ hex, title, mid });
        };
        [...doc.palette].sort((a, b) => b[1] - a[1]).slice(0, 16)
            .forEach(([hex, n]) => add(hex, '#' + hex.toUpperCase() + ' · used ' + n + '×'));
        gradientStops(doc.norm).forEach((stops) => {
            const [first, last] = [stops[0].hex, stops[stops.length - 1].hex];
            add(first, '#' + first.toUpperCase() + ' · start of a gradient');
            const mid = gradientColorAt(stops, 0.5);
            add(mid, '#' + mid.toUpperCase() + ' · middle of a gradient', true);
            add(last, '#' + last.toUpperCase() + ' · end of a gradient');
        });
        return list.slice(0, 24);
    }
    function renderLogoColors() {
        const box = $('logo-colors');
        box.querySelectorAll('button').forEach((b) => b.remove());
        const list = state.doc ? logoColors(state.doc) : [];
        list.forEach(({ hex, title, mid }) => {
            const b = document.createElement('button');
            b.type = 'button';
            const up = '#' + hex.toUpperCase();
            b.style.background = up;
            b.title = title;
            b.dataset.hex = up;
            if (mid) b.className = 'mid';
            b.setAttribute('aria-label', 'Use ' + title);
            b.setAttribute('aria-pressed', String(state.color === up));
            b.addEventListener('click', () => setColor(up, true));
            box.appendChild(b);
        });
        box.hidden = list.length === 0;
    }
    function renderRecent() {
        const list = store.get('recent', []).filter((c) => !PRESETS.includes(c));
        const box = $('recent');
        box.querySelectorAll('button').forEach((b) => b.remove());
        list.forEach((hex) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.style.background = hex;
            b.title = hex;
            b.setAttribute('aria-label', 'Use recent color ' + hex);
            b.addEventListener('click', () => setColor(hex, true));
            box.appendChild(b);
        });
        box.hidden = list.length === 0;
    }

    if ('EyeDropper' in window) {
        $('eyedropper').hidden = false;
        $('eyedropper').addEventListener('click', async () => {
            try {
                const { sRGBHex } = await new window.EyeDropper().open();
                const hex = normalizeHex(sRGBHex);
                if (hex) setColor(hex, true);
            } catch (e) { /* cancelled */ }
        });
    }

    const ADJ = [['hue', 180], ['saturation', 100], ['lightness', 100]];
    function syncAdjust(user) {
        for (const [k] of ADJ) {
            const v = parseInt($('adj-' + k).value, 10) || 0;
            state.adj[k] = v;
            $('adj-' + k + '-out').textContent = (v > 0 ? '+' : '') + v + (k === 'hue' ? '°' : '');
        }
        const parts = [];
        if (state.adj.hue) parts.push('hue ' + (state.adj.hue > 0 ? '+' : '') + state.adj.hue + '°');
        if (state.adj.saturation) parts.push('saturation ' + (state.adj.saturation > 0 ? '+' : '') + state.adj.saturation);
        if (state.adj.lightness) parts.push('lightness ' + (state.adj.lightness > 0 ? '+' : '') + state.adj.lightness);
        $('adjust-sub').textContent = parts.length ? parts.join(', ') : 'optional, applied last';
        $('adj-reset').hidden = !parts.length;
        $('adjust-step').classList.toggle('active', parts.length > 0);
        if (user) settingsChanged();
    }
    ADJ.forEach(([k]) => $('adj-' + k).addEventListener('input', () => syncAdjust(true)));
    $('adj-reset').addEventListener('click', () => { ADJ.forEach(([k]) => { $('adj-' + k).value = 0; }); syncAdjust(true); });

    $('reset-all').addEventListener('click', () => {
        ADJ.forEach(([k]) => { $('adj-' + k).value = 0; });
        $('adj-gap').value = 0;
        syncGap();
        mergeInput.value = 0;
        detailInput.value = 0;
        syncSimplify();
        state.canvas = null;
        state.place = null;
        state.fit = null;
        syncCanvasUI();
        state.svgo = false;
        $('svgo-toggle').checked = false;
        state.holes = false;
        $('holes-toggle').checked = false;
        state.outlines = false;
        $('outlines-toggle').checked = false;
        state.colorAuto = false;
        syncAutoColor();
        lineInput.value = 0;
        state.lineInner = true;
        state.linePlain = false;
        state.lineCenter = false;
        $('line-center-toggle').checked = false;
        state.gapsAuto = false;
        $('gaps-auto-toggle').checked = false;
        state.keep.clear();
        syncLine();
        syncAdjust(false);
        setColor('#FF0066', false);
        setMode('colorize', false);
        setView('side');
        setBg('checker');
        settingsChanged();
        toast('Settings reset');
    });

    const liveToggle = $('live-toggle');
    liveToggle.checked = store.get('live', true);
    function syncLive() {
        $('submit-btn').hidden = liveToggle.checked;
        store.set('live', liveToggle.checked);
    }
    liveToggle.addEventListener('change', () => { syncLive(); if (liveToggle.checked) scheduleLive(0); });
    syncLive();

    // ------------------------------------------------------------------
    // Source: file, paste, drop, link, example
    // ------------------------------------------------------------------
    // Three ways in: a file, a link, or SVG code. "Change" reopens them on the
    // source used last (and pre-fills the code), with a way back to the current SVG.
    const SOURCES = ['file', 'link', 'code'];
    let keepPlacement = false; // a shared link's placement applies to the SVG it loads
    let codeName = null; // keeps the file name when editing the current SVG as code
    function showSource(kind) {
        SOURCES.forEach((k) => { $('source-' + k).hidden = k !== kind; });
        // In the code editor the current SVG is what's in the field, so "Done" fits.
        $('source-cancel').textContent = kind === 'code' && state.doc && state.doc.source === 'code' ? 'Done' : 'Keep current SVG';
        $$('#source-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.source === kind)));
    }
    function focusSource(kind) {
        if (kind === 'link') $('url-input').select();
        else if (kind === 'code') $('code-input').focus();
        else fileInput.focus();
    }
    function showSourcePicker(kind) {
        $('file-chip').hidden = true;
        $('source-tabs').hidden = false;
        $('example-row').hidden = false;
        $('source-cancel').hidden = !state.doc;
        $('paste-hint').hidden = !!state.doc;
        showSource(kind);
    }
    function hideSourcePicker() {
        SOURCES.forEach((k) => { $('source-' + k).hidden = true; });
        $('source-tabs').hidden = true;
        $('example-row').hidden = true;
        $('source-cancel').hidden = true;
        $('paste-hint').hidden = false;
        $('file-chip').hidden = false;
    }
    $$('#source-tabs button').forEach((b) => b.addEventListener('click', () => {
        showSource(b.dataset.source);
        focusSource(b.dataset.source);
    }));
    $('change-file').addEventListener('click', () => {
        const kind = state.doc && SOURCES.includes(state.doc.source) ? state.doc.source : 'file';
        if (state.doc) {
            setCodeInput(state.doc.text);
            codeName = state.doc.name;
            $('code-input').setSelectionRange(0, 0); // start at the top, not the end
            $('code-input').scrollTop = 0;
            syncCodeScroll();
            setCodeStatus('ok', 'This is the current SVG. Edits are used as you type.');
        }
        showSourcePicker(kind);
        focusSource(kind);
    });
    $('source-cancel').addEventListener('click', () => { hideSourcePicker(); $('change-file').focus(); });

    // SVG code field: the textarea's text is transparent and a highlighted copy sits
    // underneath, scrolled in step, so typing, selection and undo stay native.
    const codeInput = $('code-input');
    const codeHl = $('code-hl');
    let hlFrame = 0;
    function syncCodeScroll() {
        codeHl.scrollTop = codeInput.scrollTop;
        codeHl.scrollLeft = codeInput.scrollLeft;
    }
    function syncCodeEditor() {
        cancelAnimationFrame(hlFrame);
        hlFrame = requestAnimationFrame(() => {
            showCode(codeHl, codeInput.value + '\n', 'markup'); // the newline keeps a trailing empty line visible
            // Match the textarea's text width when it shows a scrollbar.
            const pad = parseFloat(getComputedStyle(codeInput).paddingRight) || 0;
            codeHl.style.paddingRight = (pad + codeInput.offsetWidth - codeInput.clientWidth) + 'px';
            syncCodeScroll();
        });
    }
    function setCodeInput(text) { codeInput.value = text; syncCodeEditor(); }
    codeInput.addEventListener('input', syncCodeEditor);
    codeInput.addEventListener('scroll', syncCodeScroll);
    if (window.ResizeObserver) new ResizeObserver(syncCodeEditor).observe(codeInput);

    // Code is used as you type: once it parses as SVG (a short pause after the
    // last key), it replaces the current SVG. The status line says what happened.
    let codeTimer = 0;
    function setCodeStatus(kind, text) {
        $('code-status').className = 'code-status ' + kind;
        $('code-status-text').textContent = text;
        $('code-status').title = text;
    }
    function codeProblem(text) {
        if (!text) return 'empty';
        if (new Blob([text]).size > MAX_BYTES) return 'Too large: the limit is 2 MB.';
        if (!/<svg[\s>]/i.test(text)) return 'Waiting for an <svg> element…';
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        const err = doc.querySelector('parsererror');
        if (err) {
            // Chrome wraps the message in boilerplate; its <div> holds just the error.
            const msg = ((err.querySelector('div') || err).textContent || '').split(/Below is a rendering/)[0];
            const m = /line (\d+)[^:]*:\s*([^\n]*)/i.exec(msg);
            return 'Not valid SVG yet' + (m ? ' (line ' + m[1] + ': ' + m[2].trim().replace(/\.$/, '') + ')' : '') + '. Ctrl+Enter uses it anyway.';
        }
        if (doc.documentElement.localName !== 'svg') return 'The outermost element must be <svg>.';
        return null;
    }
    function applyCode(force) {
        clearTimeout(codeTimer);
        const text = codeInput.value.trim();
        const problem = codeProblem(text);
        if (problem === 'empty') return setCodeStatus('', 'Paste or type SVG. It\'s used as you type.');
        const forced = force && problem && /^Not valid/.test(problem);
        if (problem && !forced) return setCodeStatus('warn', problem);
        if (state.doc && state.doc.text === text) return setCodeStatus('ok', 'In use · ' + state.doc.palette.length + ' colors');
        loadText(text, codeName || 'pasted.svg', new Blob([text]).size, null, 'code', true);
        if (state.doc && state.doc.text === text) {
            setCodeStatus('ok', 'Applied · ' + state.doc.palette.length + ' colors' + (forced ? ' (not valid XML; used anyway)' : ''));
            $('source-cancel').hidden = false;
            $('source-cancel').textContent = 'Done';
        }
    }
    codeInput.addEventListener('input', () => { clearTimeout(codeTimer); codeTimer = setTimeout(applyCode, 400); });
    codeInput.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); applyCode(true); }
    });

    // The larger editor: same field, plus a live preview of the result.
    function setCodeExpanded(on) {
        $('code-panel').classList.toggle('expanded', on);
        document.body.classList.toggle('code-expanded', on);
        if (on && (resultUrl || originalUrl)) $('code-preview-img').src = resultUrl || originalUrl;
        codeInput.focus();
        syncCodeEditor();
        if (!on) $('code-expand').focus();
    }
    $('code-expand').addEventListener('click', () => setCodeExpanded(true));
    $('code-collapse').addEventListener('click', () => setCodeExpanded(false));
    $('code-panel').addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && $('code-panel').classList.contains('expanded')) { e.preventDefault(); e.stopPropagation(); setCodeExpanded(false); }
    });

    async function loadText(text, name, size, fromUrl, source, keepEditorOpen) {
        clearError();
        if (size > MAX_BYTES) return showError('This file is ' + formatBytes(size) + '. The limit is 2 MB; try optimizing it with SVGO first.');
        if (!/<svg[\s>]/i.test(text)) return showError('That doesn\'t look like an SVG: no <svg> element was found.');
        const norm = Engine.normalize(text);
        source = source || (fromUrl ? 'link' : 'file');
        if (state.doc && !keepPlacement) state.place = null; // a new SVG starts centered on the same canvas
        keepPlacement = false;
        state.doc = { name, size, text, norm, palette: Engine.palette(norm), fromUrl: fromUrl || null, source };
        $('text-font-row').hidden = !/<text\b/i.test(norm);
        syncCanvasUI();
        renderLogoColors();
        // The slider ranges follow the SVG's size; keep the chosen values.
        syncRanges();
        gapInput.value = String(state.gap);
        lineInput.value = String(state.line);
        detailInput.value = String(state.detail);
        syncGap(false);
        syncLine(false);
        syncSimplify(false);
        state.result = null;
        // Edits belong to colors: keep the ones this SVG still has (live code edits, shared links).
        const present = new Set(state.doc.palette.map((p) => p[0]));
        for (const c of Object.keys(state.edits)) if (!present.has(c)) delete state.edits[c];
        closeColorEdit(false);

        if (originalUrl) URL.revokeObjectURL(originalUrl);
        originalUrl = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
        renderImage($('preview-container'), originalUrl, 'Original ' + name);
        $('file-thumb').src = originalUrl;
        $('file-name').textContent = name;
        const from = { link: ' · from link', code: ' · from code' }[source] || '';
        $('file-size').textContent = formatBytes(size) + ' · ' + state.doc.palette.length + ' colors' + from;
        if (!keepEditorOpen) hideSourcePicker();
        if (fromUrl) $('url-input').value = fromUrl;
        updateSnippet();
        syncPageUrl();
        recolor();
        scheduleThumbs(250);
        if (state.fit !== null) fitToCanvas(false); // auto Fit: this SVG too
    }
    // ------------------------------------------------------------------
    // Batch: several SVGs with the same settings. The first opens here to tune the
    // settings; Download all recolors each one the way the preview does, into a ZIP.
    // ------------------------------------------------------------------
    const MAX_BATCH = 200;
    let batchAt = 0;
    async function startBatch(files) {
        const svgs = files.filter((f) => /\.svg$/i.test(f.name) || /svg/i.test(f.type));
        const items = [];
        for (const f of svgs.slice(0, MAX_BATCH)) if (f.size <= MAX_BYTES) items.push({ name: f.name || 'image.svg', text: await f.text(), size: f.size });
        const left = files.length - items.length;
        if (!items.length) return showError('None of these are SVG files (up to 2 MB each).');
        if (items.length === 1) return loadText(items[0].text, items[0].name, items[0].size, null);
        state.batch = items;
        openBatchItem(0);
        if (left) toast(left + ' file' + (left === 1 ? ' was' : 's were') + ' left out (not an SVG, over 2 MB, or past ' + MAX_BATCH + ')');
    }
    function openBatchItem(i) {
        batchAt = i;
        const it = state.batch[i];
        loadText(it.text, it.name, it.size, null);
        renderBatch();
    }
    function renderBatch() {
        const on = !!(state.batch && state.batch.length > 1);
        $('batch-bar').hidden = !on;
        if (!on) return;
        $('batch-count').textContent = String(state.batch.length);
        const box = $('batch-files');
        box.replaceChildren();
        state.batch.forEach((it, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = it.name;
            b.title = it.failed ? 'Not in the last ZIP: ' + it.failed : 'Show ' + it.name + ' here';
            if (it.failed) b.classList.add('failed');
            b.setAttribute('aria-current', String(i === batchAt));
            b.addEventListener('click', () => openBatchItem(i));
            box.appendChild(b);
        });
    }
    function makeDoc(text, name) {
        if (!/<svg[\s>]/i.test(text)) throw new Error('no <svg> element');
        const norm = Engine.normalize(text);
        return { name, text, norm, palette: Engine.palette(norm), fromUrl: null, source: 'file' };
    }
    // One SVG through the same steps as the preview, with the current settings.
    async function renderDoc(doc) {
        const colors = doc.palette.map((p) => p[0]);
        const color = state.colorAuto && MODES[state.mode].color ? await autoColorOf(doc) : state.color;
        const mapping = colors.length ? await mappingFor(state.mode, colors, color) : {};
        let place = null; // a placement set by hand belongs to the SVG it was made on
        if (state.fit !== null) place = await fitPlacement(doc, state.fit, 0);
        else if (doc === state.doc) place = state.place;
        const parts = editedSvg(doc, mapping, place);
        let svg = parts.svg;
        if (parts.cut.length || parts.holes.length || state.outlines || state.gap || state.line || state.merge || state.detail) svg = await cutOutSvg(parts.edited, parts.cut, parts.merged, null, doc, parts.holes);
        if (state.svgo) svg = await optimizeSvg(svg);
        return svg;
    }
    // A ZIP without compression (SVGs are small; this keeps it simple and fast).
    function makeZip(files) {
        const crcTable = makeZip.table || (makeZip.table = Array.from({ length: 256 }, (_, n) => {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            return c >>> 0;
        }));
        const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
        const enc = new TextEncoder();
        const parts = [], central = [];
        let offset = 0;
        for (const [name, text] of files) {
            const nameBytes = enc.encode(name), data = enc.encode(text), crc = crc32(data);
            const local = new DataView(new ArrayBuffer(30));
            local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
            local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
            local.setUint16(26, nameBytes.length, true);
            parts.push(local, nameBytes, data);
            const cd = new DataView(new ArrayBuffer(46));
            cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
            cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
            cd.setUint16(28, nameBytes.length, true); cd.setUint32(42, offset, true);
            central.push(cd, nameBytes);
            offset += 30 + nameBytes.length + data.length;
        }
        const size = central.reduce((n, p) => n + p.byteLength, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
        end.setUint32(12, size, true); end.setUint32(16, offset, true);
        return new Blob([...parts, ...central, end], { type: 'application/zip' });
    }
    async function downloadBatch() {
        if (!state.batch) return;
        const btn = $('batch-zip');
        btn.classList.add('loading');
        btn.disabled = true;
        setBusy(true, 'zip');
        const out = [], used = new Set(), failed = [];
        const n = state.batch.length;
        try {
            for (const [i, it] of state.batch.entries()) {
                setStatus('work', 'Batch: ' + (i + 1) + ' of ' + n + ' · ' + Math.round((100 * i) / n) + '%');
                it.failed = null;
                try {
                    const svg = await renderDoc(makeDoc(it.text, it.name));
                    let name = outputName({ name: it.name });
                    for (let k = 2; used.has(name); k++) name = name.replace(/(_\d+)?\.svg$/, '_' + k + '.svg');
                    used.add(name);
                    out.push([name, svg]);
                } catch (err) {
                    it.failed = err.message === 'superseded' ? 'interrupted by a settings change' : err.message;
                    failed.push(it.name + ' (' + it.failed + ')');
                }
            }
            if (out.length) {
                const url = URL.createObjectURL(makeZip(out));
                const a = document.createElement('a');
                a.href = url;
                a.download = 'svg-recolor-' + state.mode + '-' + out.length + '.zip';
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 60000);
            }
            toast(out.length + ' of ' + n + ' SVGs in the ZIP');
        } finally {
            btn.classList.remove('loading');
            btn.disabled = false;
            setBusy(false, 'zip');
            renderBatch();
            if (state.doc) recolor(); // (clears messages first, so the one below comes after)
        }
        if (failed.length) showError('Not in the ZIP: ' + failed.join('; '));
    }
    $('batch-zip').addEventListener('click', downloadBatch);
    $('batch-close').addEventListener('click', () => { state.batch = null; renderBatch(); });

    async function loadFile(file) {
        if (!file) return;
        if (!(file.type === 'image/svg+xml' || /\.svg$/i.test(file.name) || file.type === '' || file.type.startsWith('text/'))) {
            return showError('That doesn\'t look like an SVG. Please choose a .svg file.');
        }
        if (file.size > MAX_BYTES) return showError('This file is ' + formatBytes(file.size) + '. The limit is 2 MB; try optimizing it with SVGO first.');
        loadText(await file.text(), file.name || 'image.svg', file.size, null);
    }
    fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files || []);
        if (files.length > 1) startBatch(files); else loadFile(files[0]);
        fileInput.value = '';
    });

    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
        e.preventDefault();
        dragDepth++;
        document.body.classList.add('dragging');
    });
    document.addEventListener('dragover', (e) => { if (document.body.classList.contains('dragging')) e.preventDefault(); });
    document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
    document.addEventListener('drop', (e) => {
        dragDepth = 0;
        document.body.classList.remove('dragging');
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        if (files.length > 1) { e.preventDefault(); startBatch(files); return; }
        if (files[0]) { e.preventDefault(); loadFile(files[0]); }
    });
    // Paste: an .svg file copied in the file manager (Explorer, Finder, Files), SVG code,
    // an <svg> copied from a web page, or a link.
    const isSvgFile = (f) => /svg/i.test(f.type) || /\.svg$/i.test(f.name);
    function svgFromHtml(html) {
        const svg = new DOMParser().parseFromString(html, 'text/html').querySelector('svg');
        if (!svg) return null;
        if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        return new XMLSerializer().serializeToString(svg);
    }
    async function loadPastedFile(file, intoCode) {
        if (!isSvgFile(file)) {
            const kind = (file.type.split('/')[1] || '').toUpperCase();
            return showError((kind ? 'That\'s a ' + kind + ' image. ' : 'That isn\'t an SVG. ') + 'SVG Recolor needs an .svg file or SVG code.');
        }
        if (file.size > MAX_BYTES) return showError('This file is ' + formatBytes(file.size) + '. The limit is 2 MB; try optimizing it with SVGO first.');
        const text = await file.text();
        if (intoCode) { codeName = file.name || null; setCodeInput(text); applyCode(); return; }
        loadText(text, file.name || 'pasted.svg', file.size, null);
    }
    // "Copy image" in a browser puts a PNG of the picture on the clipboard, plus HTML
    // <img src="..."> pointing at the real file: use the address to get the SVG itself.
    function imageSource(html) {
        if (!html || !/<img[\s>]/i.test(html)) return null;
        const img = new DOMParser().parseFromString(html, 'text/html').querySelector('img[src]');
        const src = img && img.getAttribute('src').trim();
        return src && /^(https?:|data:image\/svg\+xml)/i.test(src) ? src : null;
    }
    function svgFromDataUrl(src) {
        const m = /^data:image\/svg\+xml(;[^,]*)?,(.*)$/is.exec(src);
        if (!m) return null;
        try {
            return /;base64/i.test(m[1] || '') ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))) : decodeURIComponent(m[2]);
        } catch (err) { return null; }
    }
    function loadPastedLink(url) {
        showSourcePicker('link');
        $('url-input').value = url;
        loadFromLink();
    }
    document.addEventListener('paste', (e) => {
        const t = e.target;
        const data = e.clipboardData;
        if (!data) return;
        const files = Array.from(data.files || []);
        if (files.filter(isSvgFile).length > 1 && t !== $('code-input')) { e.preventDefault(); startBatch(files); return; }
        const file = files.find(isSvgFile) || files[0];
        // In the link and color fields a paste is just text for the field.
        const src = t === hexInput || t === $('url-input') ? null : imageSource(data.getData('text/html'));
        if (src && !(file && isSvgFile(file))) {
            e.preventDefault();
            const inline = src.startsWith('data:') ? svgFromDataUrl(src) : null;
            if (inline) { setCodeInput(inline); codeName = null; loadText(inline, 'pasted.svg', new Blob([inline]).size, null, 'code'); return; }
            if (!inline && src.startsWith('data:')) return showError('This image could not be read. Copy the image address instead.');
            loadPastedLink(src);
            return;
        }
        if (file) { e.preventDefault(); loadPastedFile(file, t === $('code-input')); return; }
        if (t === hexInput || t === $('url-input') || t === $('code-input')) return;
        let text = data.getData('text/plain');
        if (!(text && /<svg[\s>]/i.test(text))) {
            const html = data.getData('text/html');
            const fromHtml = html && /<svg[\s>]/i.test(html) ? svgFromHtml(html) : null;
            if (fromHtml) text = fromHtml;
        }
        if (text && /<svg[\s>]/i.test(text)) { e.preventDefault(); setCodeInput(text); codeName = null; loadText(text, 'pasted.svg', new Blob([text]).size, null, 'code'); return; }
        const uris = data.getData('text/uri-list') || text || '';
        if (/^file:\/\//im.test(uris.trim()) && !(t && /^(INPUT|TEXTAREA)$/.test(t.tagName))) {
            e.preventDefault();
            return showError('The browser only got the file\'s path, not the file. Drag the file onto the page or use Choose file instead.');
        }
        if (text && /^https?:\/\/\S+$/i.test(text.trim()) && !(t && /^(INPUT|TEXTAREA)$/.test(t.tagName))) {
            e.preventDefault();
            loadPastedLink(text.trim());
        }
    });

    async function loadFromLink() {
        const url = $('url-input').value.trim();
        clearError();
        if (!/^https?:\/\/\S+$/i.test(url)) return showError('Enter a full link that starts with http:// or https://.');
        const btn = $('url-load');
        btn.disabled = true;
        btn.textContent = 'Loading…';
        setStatus('work', 'Downloading the SVG…');
        try {
            const res = await fetch('/api/fetch?url=' + encodeURIComponent(url));
            if (!res.ok) throw new Error(await errorDetail(res));
            const text = await res.text();
            let name = 'linked.svg';
            try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || name; } catch (e) { /* keep default */ }
            if (!/\.svg$/i.test(name)) name += '.svg';
            loadText(text, name, new Blob([text]).size, url);
        } catch (err) {
            showError(err.message === 'Failed to fetch' ? 'Could not reach the server. Check your connection and try again.' : err.message);
            setStatus('err', 'Could not load the link');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Load';
        }
    }
    $('url-load').addEventListener('click', loadFromLink);
    $('url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadFromLink(); } });

    async function loadExample() {
        try {
            const { text } = await sampleReady; // the thumbnail snail, already downloaded
            if (text === FALLBACK_SVG) throw new Error();
            loadText(text, 'rainbow-snail.svg', new Blob([text]).size, null, 'example');
        } catch (e) {
            showError('Could not load the example file.');
        }
    }
    $('try-example').addEventListener('click', loadExample);
    document.addEventListener('click', (e) => {
        const a = e.target.closest('[data-action="example"]');
        if (a) loadExample();
    });

    // ------------------------------------------------------------------
    // Recolor: palette -> /api/map-colors -> apply locally
    // ------------------------------------------------------------------
    function scheduleLive(delay) {
        if (!state.doc || !liveToggle.checked) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(recolor, delay === undefined ? 200 : delay);
    }
    // One request fetches every style's colors for the current color and
    // adjustments, so the preview and all six thumbnails cost a single call (and
    // identical calls are CDN cache hits). Identical in-flight requests are shared.
    const inflight = new Map();
    function sharedParams(color) {
        const q = settingsParams('tint', color); // color + adjustments
        q.delete('mode');
        return q;
    }
    async function fetchAllModes(colors, color) {
        const missing = MODE_KEYS.filter((m) => {
            const known = mapCache.get(settingsParams(m, color).toString());
            return !known || colors.some((c) => !(c in known));
        });
        if (!missing.length || !colors.length) return;
        const sorted = [...new Set(colors)].sort();
        const shared = sharedParams(color);
        const key = shared.toString() + '|' + sorted.join(',');
        if (!inflight.has(key)) {
            inflight.set(key, (async () => {
                let res;
                if (sorted.length <= MAX_GET_COLORS) {
                    const q = new URLSearchParams(shared);
                    q.set('modes', MODE_KEYS.join(','));
                    q.set('colors', sorted.join(','));
                    if (ENGINE_VERSION) q.set('v', ENGINE_VERSION);
                    res = await fetch('/api/map-colors?' + q.toString());
                } else {
                    const body = Object.assign(Object.fromEntries(shared), { modes: MODE_KEYS, colors: sorted });
                    res = await fetch('/api/map-colors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                }
                if (!res.ok) throw new Error(await errorDetail(res));
                storeMappings((await res.json()).mappings, shared);
            })().finally(() => inflight.delete(key)));
        }
        return inflight.get(key);
    }
    // Keys are built from the parameters the request was sent with (not the
    // current settings, which may have changed meanwhile), in settingsParams' order.
    function storeMappings(mappings, shared) {
        for (const [mode, mapping] of Object.entries(mappings)) {
            const q = new URLSearchParams();
            if (MODES[mode].color && shared.has('color')) q.set('color', shared.get('color'));
            q.set('mode', mode);
            for (const k of ['hue', 'saturation', 'lightness']) if (shared.has(k)) q.set(k, shared.get(k));
            const key = q.toString();
            const known = Object.assign({}, mapCache.get(key));
            for (const [from, to] of Object.entries(mapping)) known[from.slice(1).toLowerCase()] = to.slice(1).toLowerCase();
            mapCache.set(key, known);
        }
        while (mapCache.size > 300) mapCache.delete(mapCache.keys().next().value);
    }
    async function mappingFor(mode, colors, color = state.color) {
        await fetchAllModes(colors, color);
        return mapCache.get(settingsParams(mode, color).toString()) || {};
    }
    // Color "Auto": each SVG's most prominent color, the one seen most (measured with the
    // geometry library, as the API's color=auto). Falls back to its most used color.
    async function autoColorOf(doc) {
        if (doc.auto) return doc.auto;
        let hex = null;
        try { hex = (await loadGeometry()).prominentColor(doc.norm); } catch (err) { /* text, masks: count instead */ }
        if (!hex) {
            const ranked = [...doc.palette].sort((a, b) => b[1] - a[1]);
            hex = (ranked.find(([c]) => !isLight(c)) || ranked[0] || ['000000'])[0];
        }
        doc.auto = '#' + hex.toUpperCase();
        return doc.auto;
    }
    // Settings as the page address, a recipe or the API take them: "auto" stays auto.
    function publicParams() {
        const q = editParams(settingsParams());
        if (state.colorAuto && q.has('color')) q.set('color', 'auto');
        return q;
    }
    // The page ships the sample image's colors for the default settings, so the
    // thumbnails on first load need no request.
    for (const [key, mapping] of Object.entries(CFG.seed || {})) mapCache.set(key, Object.assign({}, mapping));

    // Style thumbnails: the current SVG (or the rainbow snail) rendered in every
    // style with the current color and adjustments, so each choice shows what it does.
    // The page carries the snail's colors (CFG.seed) and a cached URL for the file
    // itself, so the first thumbnails cost one CDN file and no API call.
    const FALLBACK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="18" cy="19" r="13" fill="#3b82f6"/><circle cx="30" cy="19" r="13" fill="#f59e0b" fill-opacity=".9"/><circle cx="24" cy="31" r="13" fill="#10b981" fill-opacity=".9"/><circle cx="24" cy="24" r="4" fill="#ffffff"/><path d="M6 44h36" stroke="#1f2937" stroke-width="3"/></svg>';
    let SAMPLE = null;
    const sampleReady = (CFG.sample ? Promise.resolve(CFG.sample)
        : CFG.sampleUrl ? fetch(CFG.sampleUrl).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
            : Promise.reject(new Error('no sample')))
        .catch(() => FALLBACK_SVG)
        .then((text) => { const norm = Engine.normalize(text); SAMPLE = { text, norm, palette: Engine.palette(norm) }; return SAMPLE; });
    let thumbTimer = null;
    let thumbId = 0;
    const thumbUrls = {};
    function scheduleThumbs(delay) {
        clearTimeout(thumbTimer);
        thumbTimer = setTimeout(renderThumbs, delay === undefined ? 450 : delay);
    }
    async function renderThumbs() {
        const doc = state.doc && state.doc.norm.length < 250000 ? state.doc : (SAMPLE || await sampleReady);
        const colors = doc.palette.map((p) => p[0]);
        const id = ++thumbId;
        try {
            await fetchAllModes(colors);
        } catch (e) { return; /* thumbnails are a nicety; ignore failures */ }
        if (id !== thumbId) return;
        MODE_KEYS.forEach((mode) => {
            {
                const mapping = mapCache.get(settingsParams(mode).toString()) || {};
                if (thumbUrls[mode]) URL.revokeObjectURL(thumbUrls[mode]);
                const svg = doc === state.doc ? editedSvg(doc, mapping).svg : Engine.apply(doc.norm, mapping);
                thumbUrls[mode] = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
                const box = document.querySelector('[data-thumb="' + mode + '"]');
                const img = document.createElement('img');
                img.alt = '';
                img.src = thumbUrls[mode];
                box.replaceChildren(img);
            }
        });
    }

    function outputName(doc = state.doc) {
        const stem = (doc.name || 'image.svg').replace(/\.svg$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'image';
        return stem + '_recolored_' + state.mode + (MODES[state.mode].color ? '_' + state.color.slice(1).toLowerCase() : '') + '.svg';
    }
    // Dim the picture only when the work takes a while; quick updates just swap.
    let busyTimer = 0;
    let spinTimer = 0;
    // Busy while any work is on (a recolor, a fit, a download): one ending doesn't hide the
    // spinner while another still runs (a fit used to, mid "Drawing lines…").
    const busyWith = new Set();
    function setBusy(on, what = 'recolor') {
        const was = busyWith.size > 0;
        if (on) busyWith.add(what); else busyWith.delete(what);
        on = busyWith.size > 0;
        if (on === was) return;
        $('submit-btn').classList.toggle('loading', on);
        clearTimeout(busyTimer);
        clearTimeout(spinTimer);
        const dim = (v) => {
            const img = $('result-container').querySelector('img');
            if (img) img.classList.toggle('busy', v);
            $('work-overlay').hidden = !v; // message and progress on the picture
        };
        // A spinner on the result soon (the old result stays to compare); the message for longer work.
        const spin = (v) => { $('result-spinner').hidden = !(v && $('result-container').querySelector('img')); };
        if (on) { spinTimer = setTimeout(() => spin(true), 120); busyTimer = setTimeout(() => dim(true), 300); }
        else { spin(false); dim(false); }
    }
    async function recolor() {
        clearTimeout(debounceTimer);
        if (!state.doc) {
            showError('Add an SVG first: drop a file, paste one, or load a link.');
            return;
        }
        clearError();
        const id = ++reqId;
        const doc = state.doc;
        setBusy(true);
        setStatus('work', 'Recoloring…');
        try {
            const colors = doc.palette.map((p) => p[0]);
            if (state.colorAuto && MODES[state.mode].color) {
                const auto = await autoColorOf(doc);
                if (id !== reqId || doc !== state.doc) return;
                if (auto !== state.color) { setColor(auto, false); scheduleThumbs(0); }
            }
            const mapping = colors.length ? await mappingFor(state.mode, colors) : {};
            if (id !== reqId || doc !== state.doc) return;
            const parts = editedSvg(doc, mapping);
            const { merged } = parts;
            let svg = parts.svg;
            let geometryFailed = false;
            const info = { holed: parts.holes };
            if (parts.cut.length || parts.holes.length || state.outlines || state.gap || state.line || state.merge || state.detail) {
                const label = state.line ? 'Drawing lines… ' : state.gap ? 'Cutting gaps… ' : 'Cutting out… ';
                setStatus('work', label.trim());
                try {
                    svg = await cutOutSvg(parts.edited, parts.cut, merged, (f) => { if (id === reqId) setStatus('work', label + Math.round(f * 100) + '%'); }, doc, parts.holes, info);
                } catch (err) {
                    if (id !== reqId || doc !== state.doc) return;
                    // Show the rest of the edits, with the cut colors left invisible, and say why;
                    // the status says it too, so this isn't mistaken for the finished result.
                    showError(err.message);
                    geometryFailed = true;
                }
                if (id !== reqId || doc !== state.doc) return;
            }
            if (state.svgo) {
                setStatus('work', 'Optimizing…');
                try {
                    svg = await optimizeSvg(svg);
                } catch (err) {
                    if (id !== reqId || doc !== state.doc) return;
                    showError(err.message);
                }
                if (id !== reqId || doc !== state.doc) return;
            }
            // A copy: the colors the geometry decided on are shown, never added to your own edits.
            const effective = Object.assign({}, editsOf(doc));
            // Light colors that stayed parts of the logo follow the style, like any color.
            for (const c of parts.holes) if (!info.holed.includes(c)) delete effective[c];
            // Outline colors the geometry turned into gaps show as cut out.
            for (const c of info.holed) if (!effective[c]) effective[c] = { op: 'cut', auto: true };
            const to = (c) => {
                const e = effective[c];
                return e && e.op === 'cut' ? 'cut' : e && (e.op === 'remove' || e.op === 'hide') ? 'removed' : '#' + (merged[c] || c);
            };
            state.result = {
                svg,
                filename: outputName(),
                palette: doc.palette.map(([c, n]) => ({ from: '#' + c, to: to(c), count: n, edit: effective[c] || null })),
            };
            renderResult();
            if (MODES[state.mode].color) rememberColor(state.color);
            const size = formatBytes(new Blob([state.result.svg]).size);
            if (geometryFailed) setStatus('err', 'Without cut out, gaps and lines (see the message) · ' + size);
            else setStatus('ok', MODES[state.mode].label + (MODES[state.mode].color ? ' ' + state.color : '') + ' · ' + colors.length + ' colors · ' + size);
        } catch (err) {
            if (id !== reqId || err.name === 'AbortError') return;
            showError(err.message === 'Failed to fetch' ? 'Could not reach the server. Check your connection and try again.' : err.message);
            setStatus('err', 'Recolor failed');
        } finally {
            if (id === reqId) setBusy(false);
        }
    }
    $('controls').addEventListener('submit', (e) => { e.preventDefault(); recolor(); });

    function renderResult() {
        const r = state.result;
        if (resultUrl) URL.revokeObjectURL(resultUrl);
        resultUrl = URL.createObjectURL(new Blob([r.svg], { type: 'image/svg+xml' }));
        hoverCanvas.remove(); // a new picture: the outline follows the pointer again
        renderImage($('result-container'), resultUrl, 'Recolored ' + state.doc.name);
        $('code-preview-img').src = resultUrl;
        document.querySelectorAll('#sizes-panel img').forEach((img) => { img.src = resultUrl; });
        renderPalette(r.palette);
        showCode($('side-code'), r.svg.length > CODE_VIEW_LIMIT ? r.svg.slice(0, CODE_VIEW_LIMIT) + '\n…' : r.svg, 'markup');
        if (!editPanel.hidden && editColor && !(editAnchor && editAnchor.point)) { editAnchor = document.querySelector('.chip[data-color="' + editColor + '"]'); placeEditPanel(); }
        if (state.tab === 'code') renderCode();
        syncCopyButton();
        syncDownload();
    }
    // Colors strip: each original color and what it became. Click a color to give it its
    // own color, hide it, or remove its shapes (see the color-edit panel below).
    const EDIT_LABEL = { replace: 'own color', hide: 'invisible', remove: 'invisible', cut: 'cut out' };
    const BADGE = { // [icon paths, meaning]
        replace: ['<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', 'Own color'],
        remove: ['<path d="M9.9 4.2A10 10 0 0 1 12 4c7 0 10 8 10 8a13 13 0 0 1-1.7 2.7"/><path d="M6.6 6.6A13 13 0 0 0 2 12s3 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="m2 2 20 20"/>', 'Invisible'],
        cut: ['<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>', 'Cut out'],
        keep: ['<rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor"/>', 'Kept filled in the line version'],
    };
    function renderPalette(entries) {
        const list = $('palette-list');
        list.replaceChildren();
        entries.forEach((e) => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            const kept = state.line && state.keep.has(e.from.slice(1));
            btn.className = 'chip' + (e.edit ? ' edited ' + e.edit.op : '') + (kept ? ' edited kept' : '');
            btn.dataset.color = e.from.slice(1);
            const shown = e.to === 'cut' ? 'Cut out' : e.to === 'removed' ? 'Invisible' : e.to.toUpperCase();
            btn.title = e.from.toUpperCase() + ' → ' + shown + ' (used ' + e.count + '×). Click to edit this color.';
            btn.setAttribute('aria-label', 'Edit ' + e.from.toUpperCase() + ', now ' + shown + (e.edit ? ' (' + EDIT_LABEL[e.edit.op] + ')' : ''));
            const a = document.createElement('i'); a.style.background = e.from;
            const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '→';
            const b = document.createElement('i');
            if (e.to.startsWith('#')) b.style.background = e.to; else b.className = 'gone';
            const t = document.createElement('span'); t.textContent = shown;
            btn.append(a, arrow, b, t);
            // A tiny badge says what this color does, at a glance.
            const op = e.edit ? (e.edit.op === 'hide' ? 'remove' : e.edit.op) : kept ? 'keep' : null;
            if (op) {
                const badge = document.createElement('span');
                badge.className = 'badge';
                badge.dataset.op = op;
                badge.title = BADGE[op][1];
                badge.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + BADGE[op][0] + '</svg>';
                btn.appendChild(badge);
            }
            btn.addEventListener('click', () => openColorEdit(e.from.slice(1), btn));
            li.appendChild(btn);
            list.appendChild(li);
        });
        $('palette').hidden = entries.length === 0;
        $('edits-reset').disabled = !Object.keys(state.edits).length && !state.keep.size;
    }

    // Color-edit panel: Follow style / Own color / Hide / Remove shapes, for one color.
    const editPanel = $('color-edit');
    let editColor = null;
    let editAnchor = null;
    function placeEditPanel() {
        if (!editAnchor) return;
        const r = editAnchor.getBoundingClientRect();
        const w = editPanel.offsetWidth, h = editPanel.offsetHeight;
        const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
        const top = r.top - h - 8 >= 8 ? r.top - h - 8 : Math.min(window.innerHeight - h - 8, r.bottom + 8);
        editPanel.style.left = left + 'px';
        editPanel.style.top = top + 'px';
    }
    function openColorEdit(color, anchor) {
        editColor = color;
        editAnchor = anchor;
        const e = editsOf(state.doc)[color];
        const entry = state.result && state.result.palette.find((p) => p.from === '#' + color);
        $('color-edit-from').style.background = '#' + color;
        $('color-edit-title').textContent = '#' + color.toUpperCase();
        $('color-edit-count').textContent = entry ? 'used ' + entry.count + '×' : '';
        const op = e ? (e.op === 'hide' ? 'remove' : e.op) : 'style';
        $$('#color-edit [name="color-edit-op"]').forEach((r) => { r.checked = r.value === op; });
        const styleTo = entry && entry.edit ? null : entry && entry.to;
        $('color-edit-own').value = e && e.op === 'replace' ? e.to : (styleTo && styleTo.startsWith('#') ? styleTo : '#' + color);
        $('color-edit-keep').checked = state.keep.has(color);
        $('color-edit-keep-row').hidden = !state.line;
        editPanel.hidden = false;
        placeEditPanel();
        const checked = editPanel.querySelector('[name="color-edit-op"]:checked');
        if (checked) checked.focus();
    }
    function closeColorEdit(focusBack) {
        if (editPanel.hidden) return;
        editPanel.hidden = true;
        if (focusBack && editAnchor && editAnchor.isConnected) editAnchor.focus();
        else if (focusBack && editColor) { const b = document.querySelector('.chip[data-color="' + editColor + '"]'); if (b) b.focus(); }
        editAnchor = null;
    }
    function setColorEdit(op) {
        if (!editColor) return;
        if (op === 'style') delete state.edits[editColor];
        else if (op === 'replace') state.edits[editColor] = { op, to: $('color-edit-own').value.toUpperCase() };
        else state.edits[editColor] = { op };
        editsChanged();
    }
    function editsChanged() {
        updateSnippet();
        syncPageUrl();
        scheduleThumbs(150);
        // With "Update the preview as you change settings" off, wait for the Recolor button.
        if (state.doc && liveToggle.checked) recolor();
    }
    $$('#color-edit [name="color-edit-op"]').forEach((r) => r.addEventListener('change', () => setColorEdit(r.value)));
    $('color-edit-own').addEventListener('input', () => {
        $$('#color-edit [name="color-edit-op"]').forEach((r) => { r.checked = r.value === 'replace'; });
        setColorEdit('replace');
    });
    $('color-edit-keep').addEventListener('change', (e) => {
        if (!editColor) return;
        if (e.target.checked) state.keep.add(editColor); else state.keep.delete(editColor);
        editsChanged();
    });
    $('color-edit-close').addEventListener('click', () => closeColorEdit(true));
    editPanel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeColorEdit(true); } });
    document.addEventListener('pointerdown', (e) => {
        if (!editPanel.hidden && !editPanel.contains(e.target) && !e.target.closest('.chip') && !isPreviewImg(e.target)) closeColorEdit(false);
    });
    window.addEventListener('resize', placeEditPanel);
    $('palette-list').addEventListener('scroll', placeEditPanel, { passive: true });
    $('edits-reset').addEventListener('click', () => {
        if ($('edits-reset').disabled) return;
        state.edits = {};
        state.keep.clear();
        closeColorEdit(false);
        editsChanged();
        toast('Color edits reset');
    });

    // Click the picture to pick a color: a hidden copy of the original, with every color
    // swapped for an id color and no anti-aliasing, is drawn to a canvas; the pixel under
    // the pointer says which color is on top there. The preview itself stays an <img>.
    let pick = null; // { doc, w, h, ctx, ids, colors, ready }
    function pickIds(n) {
        const steps = Math.max(2, Math.ceil(Math.cbrt(n + 1)));
        const v = (k) => Math.round((k * 255) / (steps - 1));
        const ids = [];
        for (let i = 0; i < n; i++) ids.push([v(i % steps), v(Math.floor(i / steps) % steps), v(Math.floor(i / steps / steps) % steps)]);
        return ids;
    }
    const hex2 = (x) => x.toString(16).padStart(2, '0');
    // Where the picture is drawn inside the <img> box (object-fit: contain).
    function drawnRect(img) {
        const r = img.getBoundingClientRect();
        const onCanvas = state.canvas && img.closest('#result-container');
        const aspect = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight
            : onCanvas ? state.canvas[0] / state.canvas[1] : viewBoxAspect(state.doc) || r.width / r.height;
        const w = Math.min(r.width, r.height * aspect), h = w / aspect;
        return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
    }
    function viewBoxAspect(doc) {
        const m = /<svg\b[^>]*?\sviewBox\s*=\s*["']\s*[-\d.eE+]+[\s,]+[-\d.eE+]+[\s,]+([\d.eE+]+)[\s,]+([\d.eE+]+)/i.exec(doc.norm);
        return m && Number(m[1]) > 0 && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null;
    }
    function preparePick(doc, rect, text) {
        const w = Math.max(1, Math.round(rect.width * 2)), h = Math.max(1, Math.round(rect.height * 2));
        if (pick && pick.doc === doc && pick.text === text && pick.w === w && pick.h === h) return pick;
        const colors = doc.palette.map((p) => p[0]);
        const ids = pickIds(colors.length);
        const mapping = {};
        colors.forEach((c, i) => { mapping[c] = ids[i].map(hex2).join(''); });
        const xml = new DOMParser().parseFromString(Engine.apply(text, mapping), 'image/svg+xml');
        const root = xml.documentElement;
        let loaded;
        const p = { doc, text, w, h, ids, colors, ready: false, ctx: null, loaded: new Promise((r) => { loaded = r; }) };
        pick = p;
        if (root.localName !== 'svg' || xml.querySelector('parsererror')) { loaded(); return p; }
        root.setAttribute('shape-rendering', 'crispEdges');
        xml.querySelectorAll('[shape-rendering]').forEach((el) => el.setAttribute('shape-rendering', 'crispEdges'));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        p.ctx = canvas.getContext('2d', { willReadFrequently: true });
        const img = new Image();
        img.onload = () => {
            if (pick !== p) return;
            p.ctx.drawImage(img, 0, 0, w, h);
            p.ready = true;
            loaded();
        };
        img.onerror = () => loaded();
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(root));
        return p;
    }
    // The original color under a point of a preview image; null for none, undefined while loading.
    function colorAt(img, x, y) {
        if (!state.doc || stage.dataset.view === 'slider') return null;
        const rect = drawnRect(img);
        // The recolored picture is on the canvas (placed); the original is as it was.
        const p = preparePick(state.doc, rect, img.closest('#result-container') ? placed(state.doc) : state.doc.norm);
        if (!p.ready) return undefined;
        const px = Math.floor(((x - rect.left) / rect.width) * p.w), py = Math.floor(((y - rect.top) / rect.height) * p.h);
        if (px < 0 || py < 0 || px >= p.w || py >= p.h) return null;
        const [r, g, b, a] = p.ctx.getImageData(px, py, 1, 1).data;
        if (a < 128) return null;
        let best = null, bestD = Infinity;
        p.ids.forEach(([ir, ig, ib], i) => {
            const d = (ir - r) ** 2 + (ig - g) ** 2 + (ib - b) ** 2;
            if (d < bestD) { bestD = d; best = p.colors[i]; }
        });
        return best;
    }
    const isPreviewImg = (t) => t instanceof HTMLImageElement && !!t.closest('#preview-container, #result-container');
    let hoverColor = null;
    function setHover(color, img) {
        if (color === hoverColor) return;
        hoverColor = color;
        $$('#palette-list .chip.hover').forEach((c) => c.classList.toggle('hover', false));
        if (color) { const chip = document.querySelector('.chip[data-color="' + color + '"]'); if (chip) chip.classList.add('hover'); }
        if (img) {
            img.classList.toggle('pickable', !!color);
            img.title = color ? '#' + color.toUpperCase() + ': click to edit this color' : '';
        }
        drawHoverOutline(img, color);
    }
    stage.addEventListener('pointermove', (e) => {
        if (!isPreviewImg(e.target) || e.pointerType === 'touch') return;
        const c = colorAt(e.target, e.clientX, e.clientY);
        if (c !== undefined) setHover(c, e.target);
    });
    stage.addEventListener('pointerout', (e) => { if (isPreviewImg(e.target)) setHover(null, e.target); });

    // The color under the pointer, outlined in the picture: its visible pixels on the pick
    // canvas (where it's on top), with a white edge inside and a dark one outside.
    const hoverCanvas = document.createElement('canvas');
    hoverCanvas.className = 'hover-outline';
    hoverCanvas.setAttribute('aria-hidden', 'true');
    // Square dilation of a 0/1 mask by r pixels (separable, so cheap).
    function dilate(m, w, h, r) {
        const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            let run = 0;
            for (let x = -r; x < w + r; x++) {
                if (x + r < w && m[y * w + x + r]) run++;
                if (x - r - 1 >= 0 && m[y * w + x - r - 1]) run--;
                if (x >= 0 && x < w) a[y * w + x] = run > 0 ? 1 : 0;
            }
        }
        for (let x = 0; x < w; x++) {
            let run = 0;
            for (let y = -r; y < h + r; y++) {
                if (y + r < h && a[(y + r) * w + x]) run++;
                if (y - r - 1 >= 0 && a[(y - r - 1) * w + x]) run--;
                if (y >= 0 && y < h) b[y * w + x] = run > 0 ? 1 : 0;
            }
        }
        return b;
    }
    function drawHoverOutline(img, color) {
        const p = pick;
        const i = color && p && p.ready ? p.colors.indexOf(color) : -1;
        if (i < 0 || !img || !img.isConnected) { hoverCanvas.remove(); return; }
        const key = p.text.length + '|' + p.w + 'x' + p.h + '|' + color + '|' + (p.doc && p.doc.name);
        if (hoverCanvas.dataset.key !== key || hoverCanvas.pick !== p) {
            const { w, h } = p;
            const src = p.ctx.getImageData(0, 0, w, h).data;
            const [ir, ig, ib] = p.ids[i];
            const inside = new Uint8Array(w * h);
            for (let k = 0, j = 0; k < w * h; k++, j += 4) {
                if (src[j + 3] >= 128 && Math.abs(src[j] - ir) < 12 && Math.abs(src[j + 1] - ig) < 12 && Math.abs(src[j + 2] - ib) < 12) inside[k] = 1;
            }
            const outside = new Uint8Array(w * h);
            for (let k = 0; k < w * h; k++) outside[k] = inside[k] ? 0 : 1;
            const nearOut = dilate(outside, w, h, 3), nearIn = dilate(inside, w, h, 2);
            const out = new ImageData(w, h);
            for (let k = 0, j = 0; k < w * h; k++, j += 4) {
                if (inside[k] && nearOut[k]) { out.data[j] = 255; out.data[j + 1] = 255; out.data[j + 2] = 255; out.data[j + 3] = 255; } // edge, inside
                else if (!inside[k] && nearIn[k]) { out.data[j] = 17; out.data[j + 1] = 19; out.data[j + 2] = 28; out.data[j + 3] = 235; } // edge, outside
                else if (inside[k]) { out.data[j] = 124; out.data[j + 1] = 92; out.data[j + 2] = 255; out.data[j + 3] = 46; } // a faint tint
            }
            hoverCanvas.width = w;
            hoverCanvas.height = h;
            hoverCanvas.getContext('2d').putImageData(out, 0, 0);
            hoverCanvas.dataset.key = key;
            hoverCanvas.pick = p;
        }
        const box = img.closest('.pane') || img.parentElement; // the positioned box around the picture
        const r = drawnRect(img), b = box.getBoundingClientRect();
        Object.assign(hoverCanvas.style, { left: (r.left - b.left) + 'px', top: (r.top - b.top) + 'px', width: r.width + 'px', height: r.height + 'px' });
        if (hoverCanvas.parentElement !== box) box.appendChild(hoverCanvas);
    }
    stage.addEventListener('click', async (e) => {
        if (!isPreviewImg(e.target)) return;
        let c = colorAt(e.target, e.clientX, e.clientY);
        if (c === undefined) { await pick.loaded; c = colorAt(e.target, e.clientX, e.clientY); }
        if (!c) { closeColorEdit(false); return; }
        // Open the panel at the click: a small box where the pointer is.
        const x = e.clientX, y = e.clientY;
        openColorEdit(c, { point: true, getBoundingClientRect: () => ({ left: x - 12, right: x + 12, top: y - 12, bottom: y + 12, width: 24, height: 24 }) });
    });

    // ------------------------------------------------------------------
    // Code tab: output formats
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // Language lists: a searchable, grouped list beside the code in the
    // Code and API tabs. Used for code formats and API snippets.
    // ------------------------------------------------------------------
    function createLangList(o) {
        const el = (suffix) => $(o.prefix + '-' + suffix);
        const list = el('list');
        const search = el('search');
        const saved = store.get(o.storeKey, o.fallback);
        let current = o.items.has(saved) ? saved : o.fallback;

        function sync(scroll) {
            list.querySelectorAll('.lang-item').forEach((b) => {
                const on = b.dataset.id === current;
                b.setAttribute('aria-pressed', String(on));
                b.tabIndex = on ? 0 : -1; // one tab stop; arrow keys move within the list
                if (on && scroll) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            });
        }
        // Best match for Enter: label prefix, then label, then keywords/file, then group.
        let best = null;
        const score = (it, q) => {
            const label = it.label.toLowerCase();
            if (label.startsWith(q)) return 0;
            if (label.includes(q) || it.id.includes(q)) return 1;
            if (((it.keywords || '') + ' ' + (it.file || '')).toLowerCase().includes(q)) return 2;
            return 3;
        };
        function render() {
            const q = search.value.trim().toLowerCase();
            list.replaceChildren();
            let shown = 0;
            best = null;
            let bestScore = 9;
            o.items.groups.forEach((g) => {
                const items = o.items.list.filter((it) => it.group === g
                    && (!q || (it.label + ' ' + it.id + ' ' + it.group + ' ' + (it.file || '') + ' ' + (it.keywords || '')).toLowerCase().includes(q)));
                if (!items.length) return;
                const group = document.createElement('div');
                group.className = 'lang-group';
                group.setAttribute('role', 'group');
                const h = document.createElement('h3');
                h.id = o.prefix + '-group-' + g.toLowerCase().replace(/[^a-z]+/g, '-');
                h.textContent = g;
                group.setAttribute('aria-labelledby', h.id);
                group.appendChild(h);
                list.appendChild(group);
                items.forEach((it) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'lang-item' + (it.prompt ? ' is-prompt' : '');
                    b.dataset.id = it.id;
                    b.title = it.file || it.label;
                    b.innerHTML = o.items.icon(it, 16);
                    const label = document.createElement('span');
                    label.textContent = it.label;
                    b.appendChild(label);
                    b.addEventListener('click', () => set(it.id));
                    group.appendChild(b);
                    shown++;
                    if (q) { const sc = score(it, q); if (sc < bestScore) { bestScore = sc; best = it.id; } }
                });
            });
            el('empty').hidden = shown > 0;
            if (!shown) el('empty-text').textContent = 'Nothing built in for "' + search.value.trim() + '".';
            sync(false);
        }
        function set(id) {
            if (!o.items.has(id)) id = o.fallback;
            current = id;
            store.set(o.storeKey, id);
            sync(true);
            o.onChange(id);
        }
        search.addEventListener('input', render);
        search.addEventListener('keydown', (e) => {
            const first = list.querySelector('.lang-item');
            if (e.key === 'Enter') {
                e.preventDefault();
                const pick = best && list.querySelector('.lang-item[data-id="' + best + '"]');
                if (pick || first) {
                    const id = (pick || first).dataset.id;
                    search.value = '';
                    render();
                    set(id);
                } else el('empty-ai').click();
            } else if (e.key === 'ArrowDown' && first) {
                e.preventDefault();
                first.focus();
            } else if (e.key === 'Escape') {
                search.value = '';
                render();
            }
        });
        list.addEventListener('keydown', (e) => {
            const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
            if (!step) return;
            const items = Array.from(list.querySelectorAll('.lang-item'));
            const i = items.indexOf(document.activeElement);
            if (i < 0) return;
            e.preventDefault();
            const next = items[i + step];
            if (next) { next.focus(); next.click(); } else if (step < 0) search.focus();
        });
        // Nothing matches: switch to the AI prompt, pre-filled with the search.
        el('empty-ai').addEventListener('click', () => {
            o.onPromptTarget(search.value.trim());
            search.value = '';
            render();
            set('ai');
        });
        render();
        return { get: () => current, set, focusSearch: () => { search.focus(); search.select(); } };
    }

    // ------------------------------------------------------------------
    // Code tab
    // ------------------------------------------------------------------
    const S = window.SvgSnippets;
    let codeCache = { key: null, text: '' };
    function codeFor(id) {
        if (!state.result) return '';
        const f = F.get(id);
        if (f.prompt) return S.codePrompt($('code-target').value, state.result.svg, state.result.filename);
        const key = id + '\u0000' + state.result.svg;
        if (codeCache.key !== key) codeCache = { key, text: F.convert(id, state.result.svg) };
        return codeCache.text;
    }
    function codeFileName(id) {
        if (id === 'svg') return state.result ? state.result.filename : 'icon.svg';
        return F.get(id).file.split('/').pop();
    }
    function renderCode() {
        const view = $('code-view');
        const f = F.get(state.format);
        $('code-prompt-bar').hidden = !f.prompt;
        setCodeLang('code-view', f.prompt ? 'AI prompt' : f.label);
        if (!state.result) {
            view.textContent = 'Load an SVG to see it as ' + f.label + ' code here.';
            $('code-meta').textContent = '';
            $('code-hint').textContent = '';
            return;
        }
        const text = codeFor(state.format);
        showCode(view, text.length > CODE_VIEW_LIMIT ? text.slice(0, CODE_VIEW_LIMIT) + '\n\n… shortened in this view. Copy and Download include everything.' : text, f.prompt ? 'text' : Hl.langFor(f.file));
        const meta = $('code-meta');
        meta.replaceChildren();
        const file = document.createElement('span');
        file.className = 'file';
        file.textContent = f.file;
        meta.append(file, ' · ' + formatBytes(new Blob([text]).size) + ' · ' + text.split('\n').length + ' lines');
        $('code-hint').textContent = f.usage;
    }
    const formatList = createLangList({
        prefix: 'format', items: F, storeKey: 'format', fallback: 'svg',
        onChange: (id) => {
            state.format = id;
            renderCode();
            syncCopyButton();
            syncDownload();
            if (F.get(id).prompt && !$('code-target').value) $('code-target').focus();
        },
        onPromptTarget: (t) => { if (t) { $('code-target').value = t; store.set('codeTarget', t); } },
    });
    $('code-target').value = store.get('codeTarget', '');
    $('code-target').addEventListener('input', (e) => {
        store.set('codeTarget', e.target.value);
        renderCode();
        syncDownload();
    });

    // ------------------------------------------------------------------
    // API tab: snippets for the current settings
    // ------------------------------------------------------------------
    function snippetContext() {
        // The API takes the same names as the page address (it runs the same geometry and SVGO).
        const q = publicParams();
        if (q.get('optimize')) {
            q.set('optimize', 'true');
            if (svgoSettings.precision !== 3) q.set('precision', String(svgoSettings.precision));
        }
        const params = {};
        // Numbers as numbers; lists stay comma-separated strings, which every snippet and the API take.
        for (const [k, v] of q) params[k] = /^(hue|saturation|lightness|gap|line|merge|detail|precision)$/.test(k) ? Number(v) : v;
        const getQ = new URLSearchParams(q);
        getQ.set('url', (state.doc && state.doc.fromUrl) || 'https://example.com/icon.svg');
        const input = state.doc && !state.doc.fromUrl ? state.doc.name : 'icon.svg';
        return {
            site: SITE, query: q.toString(), params, getUrl: SITE + '/api/recolor?' + getQ.toString(),
            input, output: input.replace(/\.svg$/i, '') + '-recolored.svg', target: $('api-target').value,
        };
    }
    function updateSnippet() {
        const sn = S.get(state.snippet);
        $('api-prompt-bar').hidden = !sn.prompt;
        setCodeLang('snippet', sn.prompt ? 'AI prompt' : sn.label);
        showCode($('snippet'), S.build(state.snippet, snippetContext()), sn.lang);
        const code = $('snippet').textContent;
        $('api-hint').textContent = sn.prompt
            ? 'Paste this into ChatGPT, Claude, Copilot or any AI agent.'
            : state.svgo && !svgoDefaultExceptPrecision()
                ? 'The API optimizes with the default SVGO settings (and your precision); your other SVGO changes only apply here.'
                : code.includes('example.com%2Ficon.svg')
                    ? 'Links need a public SVG: replace example.com/icon.svg with yours, or load your SVG from a link.'
                    : 'Uses your current settings. No API key needed.';
        showCode($('mcp-cmd'), 'claude mcp add --transport http svg-recolor ' + SITE + '/mcp', 'sh');
        $('llms-url').textContent = SITE + '/llms.txt';
    }
    const snippetList = createLangList({
        prefix: 'snippet', items: S, storeKey: 'snippet', fallback: 'curl',
        onChange: (id) => {
            state.snippet = id;
            updateSnippet();
            syncCopyButton();
            if (S.get(id).prompt && !$('api-target').value) $('api-target').focus();
        },
        onPromptTarget: (t) => { if (t) { $('api-target').value = t; store.set('apiTarget', t); } },
    });
    $('api-target').value = store.get('apiTarget', '');
    $('api-target').addEventListener('input', (e) => { store.set('apiTarget', e.target.value); updateSnippet(); });

    // ------------------------------------------------------------------
    // Tabs, view, background, copy, download, share
    // ------------------------------------------------------------------
    function setTab(tab) {
        state.tab = tab;
        $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
        ['preview', 'code', 'api'].forEach((name) => { $('tab-' + name).hidden = name !== tab; });
        $$('.ws-tools').forEach((el) => { el.hidden = el.dataset.for !== tab; });
        if (tab === 'code') renderCode();
        if (tab === 'api') updateSnippet();
        syncCopyButton();
        syncDownload();
    }
    $$('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
    $$('.tab').forEach((t, i, all) => t.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const next = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
        next.focus();
        setTab(next.dataset.tab);
    }));

    function syncCopyButton() {
        const btn = $('copy-btn');
        if (state.tab === 'api') {
            $('copy-label').textContent = S.get(state.snippet).prompt ? 'Copy prompt' : 'Copy snippet';
            btn.disabled = false;
        } else {
            $('copy-label').textContent = state.tab === 'code' && F.get(state.format).prompt ? 'Copy prompt' : 'Copy ' + (state.tab === 'code' ? F.get(state.format).label : 'SVG');
            btn.disabled = !state.result;
        }
    }
    // What a copy gives: always the complete text, never the shortened view.
    function snippetCopy() { return [S.build(state.snippet, snippetContext()), S.get(state.snippet).prompt ? 'Prompt' : 'Snippet']; }
    function codeCopy(id) { return state.result ? [codeFor(id), F.get(id).prompt ? 'Prompt' : F.get(id).label] : ['', '']; }
    function copyCurrent() {
        const [text, label] = state.tab === 'api' ? snippetCopy() : codeCopy(state.tab === 'code' ? state.format : 'svg');
        if (text) copyText(text, label);
    }
    copySources.set('code-view', () => codeCopy(state.format));
    copySources.set('snippet', snippetCopy);
    // Download follows the view: the SVG file, or the code file in the Code tab.
    let downloadUrl = null;
    function syncDownload() {
        if (!state.result) return;
        const id = state.tab === 'code' ? state.format : 'svg';
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        downloadUrl = id === 'svg' ? null : URL.createObjectURL(new Blob([codeFor(id)], { type: 'text/plain' }));
        downloadBtn.href = downloadUrl || resultUrl;
        downloadBtn.download = codeFileName(id);
        downloadBtn.title = 'Download ' + downloadBtn.download + ' (Ctrl+S)';
        downloadBtn.setAttribute('aria-disabled', 'false');
        downloadBtn.tabIndex = 0;
    }
    $('copy-btn').addEventListener('click', copyCurrent);
    downloadBtn.addEventListener('click', (e) => {
        if (!state.result) { e.preventDefault(); return; }
        toast('Downloading ' + downloadBtn.download);
    });

    function setBg(bg) {
        stage.dataset.bg = bg;
        $$('#bg-tabs button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.bg === bg)));
        store.set('bg', bg);
    }
    $$('#bg-tabs button').forEach((b) => b.addEventListener('click', () => setBg(b.dataset.bg)));
    function setView(view) {
        stage.dataset.view = view;
        $$('#view-tabs button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.view === view)));
        store.set('view', view);
    }
    $$('#view-tabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    // Small sizes: the result at 16, 32 and 64 px on light and dark, where icons get judged.
    function setSizes(on) {
        $('sizes-panel').hidden = !on;
        $('sizes-btn').setAttribute('aria-pressed', String(on));
        store.set('sizes', on);
    }
    $('sizes-btn').addEventListener('click', () => setSizes($('sizes-panel').hidden));
    setSizes(store.get('sizes', false));
    $('compare-range').addEventListener('input', (e) => stage.style.setProperty('--split', e.target.value + '%'));

    // After applying a set of settings (undo/redo, a recipe): recolor, or fit first.
    function settingsApplied() {
        if (state.fit !== null && state.doc) fitToCanvas(false);
        else editsChanged();
    }

    // Recipes: settings saved under a name, to use again on other SVGs. Not the edits of
    // single colors (they belong to one SVG's colors). Saved in this browser; a recipe's
    // link (the same parameters as the page address) works anywhere.
    const PER_SVG = ['replace', 'hide', 'remove', 'cut', 'keep', 'place'];
    const recipeParams = () => { const q = publicParams(); PER_SVG.forEach((k) => q.delete(k)); return q; };
    let recipes = store.get('recipes', []);
    if (!Array.isArray(recipes)) recipes = [];
    function describeRecipe(params) {
        const q = new URLSearchParams(params);
        const parts = [MODES[q.get('mode')] ? MODES[q.get('mode')].label : 'Colorize'];
        if (q.get('color') && MODES[q.get('mode') || 'colorize'] && MODES[q.get('mode') || 'colorize'].color) parts[0] += q.get('color') === 'auto' ? ' · auto color' : ' #' + q.get('color').toUpperCase();
        const unit = q.get('unit') === 'pct' ? ' %' : ' px';
        if (q.get('merge') || q.get('detail')) parts.push('simplified');
        if (q.get('gap')) parts.push('gaps ' + q.get('gap') + unit);
        if (q.get('line')) parts.push('line ' + q.get('line') + unit);
        if (q.get('canvas')) parts.push(q.get('canvas').replace('x', ' × ') + (q.get('fit') !== null ? ', fit ' + q.get('fit') : ''));
        if (q.get('holes') === 'light') parts.push('light → holes');
        if (q.get('outlines') === 'gap') parts.push('outlines → gaps');
        if (q.get('optimize')) parts.push('optimized');
        return parts.join(' · ');
    }
    function renderRecipes() {
        const list = $('recipes-list');
        list.replaceChildren();
        $('recipes-all').hidden = recipes.length < 2;
        if (!recipes.length) {
            const li = document.createElement('li');
            li.className = 'empty';
            li.textContent = 'No recipes yet. Set things up, name it below and save.';
            list.appendChild(li);
        }
        recipes.forEach((r, i) => {
            const li = document.createElement('li');
            const apply = document.createElement('button');
            apply.type = 'button';
            apply.className = 'recipe-apply';
            apply.title = 'Use these settings';
            const small = document.createElement('small');
            small.textContent = describeRecipe(r.params);
            apply.append(r.name, small);
            apply.addEventListener('click', () => applyRecipe(r));
            const link = document.createElement('button');
            link.type = 'button';
            link.className = 'icon-btn';
            link.title = 'Copy a link to this recipe';
            link.setAttribute('aria-label', 'Copy a link to ' + r.name);
            link.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
            link.addEventListener('click', () => {
                const q = new URLSearchParams(r.params);
                q.set('recipe', r.name);
                copyText(SITE + '/?' + q, 'Link to ' + r.name);
            });
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'icon-btn';
            del.title = 'Delete this recipe';
            del.setAttribute('aria-label', 'Delete ' + r.name);
            del.textContent = '✕';
            del.addEventListener('click', () => { recipes.splice(i, 1); store.set('recipes', recipes); renderRecipes(); });
            li.append(apply, link, del);
            list.appendChild(li);
        });
    }
    function applyRecipe(r) {
        const q = new URLSearchParams(r.params);
        // Keep this SVG's color edits.
        const mine = editParams(new URLSearchParams());
        PER_SVG.filter((k) => k !== 'place').forEach((k) => { if (mine.get(k)) q.set(k, mine.get(k)); });
        applySettings(q);
        closeColorEdit(false);
        setRecipes(false);
        settingsApplied();
        showRecipe(r.name, r.params);
    }
    // ------------------------------------------------------------------
    // Several recipes in one link (run=<a recipe's parameters>, repeated): switch between them,
    // and download every SVG you add in every recipe, in one ZIP. A recipe's optional suffix
    // names its files: docker-original.svg in a recipe with suffix=plain gives docker-plain.svg.
    // ------------------------------------------------------------------
    const MAX_RUNS = 12;
    const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    function parseRun(v, i) {
        const q = new URLSearchParams(v);
        const name = (q.get('recipe') || 'Recipe ' + (i + 1)).slice(0, 60);
        const suffix = slug(q.get('suffix'));
        ['recipe', 'suffix', 'url', 'run', ...PER_SVG].forEach((k) => q.delete(k));
        return { name, suffix, params: q.toString() };
    }
    function runParam(r) {
        const q = new URLSearchParams(r.params);
        q.set('recipe', r.name);
        if (r.suffix) q.set('suffix', r.suffix);
        return q.toString();
    }
    const setLink = (list) => SITE + '/?' + list.map((r) => 'run=' + encodeURIComponent(runParam(r))).join('&');
    function renderRecipeSet() {
        const set = state.recipeSet;
        $('recipe-set').hidden = !set;
        if (!set) return;
        const box = $('recipe-set-list');
        box.replaceChildren();
        set.forEach((r) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = r.name;
            b.title = describeRecipe(r.params) + ' · files: …-' + (r.suffix || slug(r.name)) + '.svg';
            b.setAttribute('aria-pressed', String(!!state.recipe && state.recipe.name === r.name));
            b.addEventListener('click', () => applyRecipe(r));
            box.appendChild(b);
        });
        $('recipe-set-label').textContent = set.length + ' recipes in this link';
    }
    // docker-original.svg in "plain" → docker-plain.svg; other names get the suffix added.
    function setFileName(src, r, i) {
        const stem = (src || 'image.svg').replace(/\.svg$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'image';
        const suffix = r.suffix || slug(r.name) || 'recipe-' + (i + 1);
        return (/(^|[-_])original([-_]|$)/.test(stem) ? stem.replace(/(^|[-_])original(?=[-_]|$)/, '$1' + suffix) : stem + '-' + suffix) + '.svg';
    }
    async function downloadSet() {
        const set = state.recipeSet;
        if (!set) return;
        const sources = state.batch ? state.batch.map((it) => ({ text: it.text, name: it.name }))
            : state.doc ? [{ text: state.doc.text, name: state.doc.name }] : [];
        if (!sources.length) { showError('Add one or more SVGs first: drop them, paste one, or load a link.'); return; }
        const btn = $('recipe-set-zip');
        btn.classList.add('loading');
        btn.disabled = true;
        setBusy(true, 'zip');
        // Each recipe's settings in turn (with this SVG's color edits), then back to yours.
        const back = publicParams(), backRecipe = state.recipe;
        const mine = editParams(new URLSearchParams());
        const out = [], used = new Set(), failed = [];
        const total = set.length * sources.length;
        restoring = true;
        try {
            for (const [ri, r] of set.entries()) {
                const q = new URLSearchParams(r.params);
                PER_SVG.filter((k) => k !== 'place').forEach((k) => { if (mine.get(k)) q.set(k, mine.get(k)); });
                applySettings(q);
                for (const [si, src] of sources.entries()) {
                    setStatus('work', r.name + ' · ' + (ri * sources.length + si + 1) + ' of ' + total);
                    try {
                        const svg = await renderDoc(makeDoc(src.text, src.name));
                        let name = setFileName(src.name, r, ri);
                        for (let k = 2; used.has(name); k++) name = name.replace(/(_\d+)?\.svg$/, '_' + k + '.svg');
                        used.add(name);
                        out.push([name, svg]);
                    } catch (err) {
                        failed.push(src.name + ' in ' + r.name + ' (' + err.message + ')');
                    }
                }
            }
            if (out.length) {
                const url = URL.createObjectURL(makeZip(out));
                const a = document.createElement('a');
                a.href = url;
                a.download = 'svg-recolor-' + set.length + '-recipes-' + out.length + '.zip';
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 60000);
            }
            toast(out.length + ' of ' + total + ' SVGs in the ZIP');
        } finally {
            applySettings(back);
            restoring = false;
            if (backRecipe) showRecipe(backRecipe.name, backRecipe.params);
            btn.classList.remove('loading');
            btn.disabled = false;
            setBusy(false, 'zip');
            settingsApplied();
            if (failed.length) setTimeout(() => showError('Not in the ZIP: ' + failed.join('; ')), 0);
        }
    }
    $('recipe-set-zip').addEventListener('click', downloadSet);
    $('recipe-set-save').addEventListener('click', () => {
        for (const r of state.recipeSet || []) {
            const at = recipes.findIndex((x) => x.name.toLowerCase() === r.name.toLowerCase());
            if (at >= 0) recipes[at] = { name: r.name, params: r.params }; else recipes.push({ name: r.name, params: r.params });
        }
        store.set('recipes', recipes);
        syncRecipeBanner();
        toast('Saved ' + (state.recipeSet || []).length + ' recipes');
    });
    $('recipes-copy-all').addEventListener('click', () => copyText(setLink(recipes.map((r) => ({ name: r.name, params: r.params })).slice(0, MAX_RUNS)), 'Link to all your recipes'));

    // The recipe in use (from a link or the list), named at the top of the settings so
    // whoever opens a recipe link sees what it is. Marked edited once the settings move.
    function showRecipe(name, params) {
        state.recipe = name ? { name: name.slice(0, 60), params: new URLSearchParams(params).toString() } : null;
        $('recipe-banner').hidden = !state.recipe;
        if (!state.recipe) return;
        $('recipe-banner-name').textContent = state.recipe.name;
        $('recipe-banner-desc').textContent = describeRecipe(state.recipe.params);
        renderRecipeSet();
        syncRecipeBanner();
    }
    // The same settings, in any order (a link's recipe may list them differently).
    const sameParams = (a, b) => { const c = (x) => [...new URLSearchParams(x)].map((kv) => kv.join('=')).sort().join('&'); return c(a) === c(b); };
    function recipeIntact() { return !!state.recipe && sameParams(recipeParams().toString(), state.recipe.params); }
    function syncRecipeBanner() {
        if (!state.recipe) return;
        $('recipe-banner-edited').hidden = recipeIntact();
        $('recipe-banner-back').hidden = recipeIntact() && !Object.keys(state.edits).length && !state.keep.size;
        const saved = recipes.some((r) => r.name.toLowerCase() === state.recipe.name.toLowerCase() && sameParams(r.params, state.recipe.params));
        $('recipe-banner-save').hidden = saved;
    }
    $('recipe-banner-close').addEventListener('click', () => { state.recipeSet = null; renderRecipeSet(); showRecipe(null); syncPageUrl(); });
    // Back to the recipe exactly as it came: its settings, and no color edits (a recipe has none).
    $('recipe-banner-back').addEventListener('click', () => {
        if (!state.recipe) return;
        const r = state.recipe;
        applySettings(new URLSearchParams(r.params));
        state.edits = {};
        state.keep.clear();
        closeColorEdit(false);
        settingsApplied();
        showRecipe(r.name, r.params);
        toast('Back to ' + r.name + ' (Ctrl+Z undoes)');
    });
    $('recipe-banner-save').addEventListener('click', () => {
        const { name, params } = state.recipe;
        const at = recipes.findIndex((r) => r.name.toLowerCase() === name.toLowerCase());
        if (at >= 0) recipes[at] = { name, params }; else recipes.push({ name, params });
        store.set('recipes', recipes);
        syncRecipeBanner();
        toast('Saved recipe: ' + name);
    });
    function setRecipes(open) {
        $('recipes-pop').hidden = !open;
        $('recipes-btn').setAttribute('aria-expanded', String(open));
        if (open) { renderRecipes(); $('recipe-name').focus(); }
    }
    $('recipes-btn').addEventListener('click', () => setRecipes($('recipes-pop').hidden));
    $('recipes-close').addEventListener('click', () => { setRecipes(false); $('recipes-btn').focus(); });
    $('recipes-pop').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); setRecipes(false); $('recipes-btn').focus(); } });
    // (A <div>, not a <form>: it sits inside the settings form, and forms can't nest.)
    function saveRecipe() {
        const name = $('recipe-name').value.trim();
        if (!name) { $('recipe-name').focus(); return; }
        const params = recipeParams().toString();
        const at = recipes.findIndex((r) => r.name.toLowerCase() === name.toLowerCase());
        if (at >= 0) recipes[at] = { name, params }; else recipes.push({ name, params });
        store.set('recipes', recipes);
        $('recipe-name').value = '';
        renderRecipes();
        toast('Saved recipe: ' + name);
        syncRecipeBanner();
    }
    $('recipe-save-btn').addEventListener('click', saveRecipe);
    $('recipe-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveRecipe(); } });

    // Undo / redo: snapshots of the settings (the same parameters as the page address).
    const undoStack = [];
    let undoAt = -1, restoring = false;
    const snapshot = () => publicParams().toString();
    function recordHistory() {
        if (restoring) return;
        const snap = snapshot();
        if (undoStack[undoAt] === snap) return;
        undoStack.splice(undoAt + 1);
        undoStack.push(snap);
        if (undoStack.length > 100) undoStack.shift();
        undoAt = undoStack.length - 1;
        syncHistoryButtons();
    }
    function syncHistoryButtons() {
        $('undo-btn').disabled = undoAt <= 0;
        $('redo-btn').disabled = undoAt >= undoStack.length - 1;
    }
    function stepHistory(by) {
        const at = undoAt + by;
        if (at < 0 || at >= undoStack.length) return;
        undoAt = at;
        restoring = true;
        try { applySettings(new URLSearchParams(undoStack[at])); } finally { restoring = false; }
        syncHistoryButtons();
        closeColorEdit(false);
        settingsApplied();
        toast(by < 0 ? 'Undone' : 'Redone');
    }
    $('undo-btn').addEventListener('click', () => stepHistory(-1));
    $('redo-btn').addEventListener('click', () => stepHistory(1));

    function shareParams() {
        const q = publicParams();
        if (state.doc && state.doc.fromUrl) q.set('url', state.doc.fromUrl);
        if (recipeIntact()) q.set('recipe', state.recipe.name);
        for (const r of state.recipeSet || []) q.append('run', runParam(r));
        return q;
    }
    function syncPageUrl() {
        clearTimeout(urlTimer);
        urlTimer = setTimeout(() => {
            try { history.replaceState(null, '', location.pathname + '?' + shareParams().toString() + location.hash); } catch (e) { /* ignore */ }
            recordHistory();
            syncRecipeBanner();
        }, 300);
    }
    // A pasted or uploaded SVG travels in the link itself: compressed, after the #, which
    // browsers never send to the server. SVGs from a link are shared by their address.
    const SHARE_MAX = 24000; // characters; longer links get cut off in chats and mail
    async function packSvg(text) {
        if (!window.CompressionStream) return null;
        const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    async function unpackSvg(data) {
        const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        // Read with a limit: a tiny link can't expand into gigabytes and freeze the page.
        const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > MAX_BYTES) {
                reader.cancel().catch(() => {});
                throw new Error('The SVG in this link is over 2 MB.');
            }
            chunks.push(value);
        }
        return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
    }
    async function shareLink() {
        const link = SITE + '/?' + shareParams().toString();
        const doc = state.doc;
        if (!doc || doc.fromUrl) return { link, label: doc ? 'Link with this SVG and settings' : 'Link with these settings' };
        const packed = await packSvg(doc.text).catch(() => null);
        if (packed && packed.length <= SHARE_MAX) {
            return { link: link + '#' + new URLSearchParams({ svg: packed, name: doc.name }).toString(), label: 'Link with this SVG and settings' };
        }
        return { link, label: packed ? 'This SVG is too big for a link, so only the settings were copied. Load it from a public URL to share it' : 'Link with these settings (this browser can\'t pack the SVG into it)' };
    }
    $('share-btn').addEventListener('click', async () => {
        const pending = shareLink();
        try {
            // Hand the clipboard a promise right away: Safari only allows clipboard
            // writes during the click, and packing the SVG takes a moment.
            if (window.ClipboardItem) {
                await navigator.clipboard.write([new ClipboardItem({ 'text/plain': pending.then((r) => new Blob([r.link], { type: 'text/plain' })) })]);
                const { label } = await pending;
                toast(label + (/copied|too big/.test(label) ? '' : ' copied to clipboard'));
                return;
            }
        } catch (e) { /* fall back to writeText below */ }
        const { link, label } = await pending;
        if (/too big/.test(label)) { await copyText(link, 'Settings link'); toast(label); } else copyText(link, label);
    });

    // ------------------------------------------------------------------
    // Keyboard shortcuts
    // ------------------------------------------------------------------
    const dialog = $('shortcuts');
    const openShortcuts = () => { if (dialog.showModal && !dialog.open) dialog.showModal(); };
    $('shortcuts-btn').addEventListener('click', openShortcuts);
    $('shortcuts-close').addEventListener('click', () => dialog.close());
    document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (mod && key === 's') { e.preventDefault(); if (state.result) downloadBtn.click(); return; }
        if (mod && e.shiftKey && key === 'c') { e.preventDefault(); copyCurrent(); return; }
        if (mod && e.key === 'Enter') { e.preventDefault(); recolor(); return; }
        const t = e.target;
        const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && !/^(range|checkbox|radio)$/.test(t.type || '');
        if (mod && !typing && (key === 'z' || key === 'y')) {
            e.preventDefault();
            stepHistory(key === 'y' || e.shiftKey ? 1 : -1);
            return;
        }
        if (mod || e.altKey || dialog.open || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
        if (/^[1-6]$/.test(key)) setMode(MODE_KEYS[+key - 1], true);
        else if (key === 'o') { showSourcePicker('file'); fileInput.click(); }
        else if (key === 'l') { showSourcePicker('link'); $('url-input').focus(); }
        else if (key === 'c') { hexInput.focus(); hexInput.select(); }
        else if (key === 'p') setTab('preview');
        else if (key === 'e') setTab('code');
        else if (key === 'a') setTab('api');
        else if (key === 'f') {
            if (state.tab === 'preview') setTab('code');
            (state.tab === 'api' ? snippetList : formatList).focusSearch();
        }
        else if (key === 'v') { const order = ['side', 'slider', 'code']; setView(order[(order.indexOf(stage.dataset.view) + 1) % order.length]); }
        else if (key === 'b') { const order = ['checker', 'light', 'dark']; setBg(order[(order.indexOf(stage.dataset.bg) + 1) % 3]); }
        else if (e.key === '?') openShortcuts();
        else return;
        e.preventDefault();
    });

    // Every setting from page-address parameters (start-up, undo/redo, recipes). What the
    // parameters don't mention goes back to its default.
    function applySettings(q) {
        state.colorAuto = q.get('color') === 'auto';
        if (!state.colorAuto) setColor(normalizeHex(q.get('color')) || '#FF0066', false);
        else if (state.doc) autoColorOf(state.doc).then((c) => { if (state.colorAuto) setColor(c, false); });
        syncAutoColor();
        ADJ.forEach(([k, lim]) => {
            const v = parseInt(q.get(k), 10);
            $('adj-' + k).value = Number.isNaN(v) ? 0 : Math.max(-lim, Math.min(lim, v));
        });
        syncAdjust(false);
        setMode(MODES[q.get('mode')] ? q.get('mode') : 'colorize', false);
        state.edits = editsFromParams(q);
        state.unit = q.get('unit') === 'pct' ? '%' : 'px';
        state.svgo = q.get('optimize') === '1';
        $('svgo-toggle').checked = state.svgo;
        state.holes = q.get('holes') === 'light';
        $('holes-toggle').checked = state.holes;
        state.outlines = q.get('outlines') === 'gap';
        $('outlines-toggle').checked = state.outlines;
        updateOptimizeFold();
        {
            const c = (q.get('canvas') || '').split('x').map(Number);
            state.canvas = c.length === 2 && c.every((v) => v > 0) ? c : null;
            const p = (q.get('place') || '').split(',').map(Number);
            state.place = null;
            if (p.length === 3 && p.every(Number.isFinite) && p[2] > 0) { state.place = p; keepPlacement = !state.doc; }
            const f = parseFloat(q.get('fit'));
            state.fit = Number.isFinite(f) && f >= 0 ? f : null;
            if (state.fit !== null) $('fit-pad').value = fmt(state.fit);
            syncCanvasUI();
        }
        $$('#unit-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.unit === state.unit)));
        state.gap = Math.max(0, parseFloat(q.get('gap')) || 0);
        state.line = Math.max(0, parseFloat(q.get('line')) || 0);
        state.merge = Math.max(0, parseFloat(q.get('merge')) || 0);
        state.detail = Math.max(0, parseFloat(q.get('detail')) || 0);
        syncRanges();
        mergeInput.value = String(state.merge);
        detailInput.value = String(state.detail);
        syncSimplify(false);
        gapInput.value = String(state.gap);
        syncGap(false);
        lineInput.value = String(state.line);
        state.lineInner = q.get('lines') !== 'outer';
        state.linePlain = q.get('lines') === 'plain';
        state.lineCenter = q.get('linealign') === 'center';
        state.gapsAuto = q.get('gaps') === 'auto';
        $('gaps-auto-toggle').checked = state.gapsAuto;
        $('line-center-toggle').checked = state.lineCenter;
        state.keep.clear();
        for (const v of (q.get('keep') || '').split(',')) { const h = normalizeHex(v); if (h) state.keep.add(h.slice(1).toLowerCase()); }
        syncLine(false);
    }

    // ------------------------------------------------------------------
    // Start: settings from the page URL, then remembered preferences
    // ------------------------------------------------------------------
    const start = new URLSearchParams(location.search);
    applySettings(start);
    if (start.get('recipe')) {
        // Named by the link; its settings are the ones just applied (less the per-SVG ones).
        showRecipe(start.get('recipe'), recipeParams().toString());
    }
    if (start.getAll('run').length) {
        state.recipeSet = start.getAll('run').slice(0, MAX_RUNS).map(parseRun);
        // Only recipes in the link: start with the first one's settings.
        if (!start.has('mode')) applySettings(new URLSearchParams(state.recipeSet[0].params));
        const first = state.recipe && state.recipeSet.find((r) => r.name === state.recipe.name) || state.recipeSet[0];
        showRecipe(first.name, first.params);
    }
    setBg(store.get('bg', 'checker'));
    setView(store.get('view', window.matchMedia('(max-width: 560px)').matches ? 'slider' : 'side'));
    renderRecent();
    // Open the sections that are in use (say, from a shared link); the rest stay closed.
    $$('details.fold').forEach((d) => { if (d.classList.contains('active')) d.open = true; });
    state.format = formatList.get();
    state.snippet = snippetList.get();
    updateSnippet();
    scheduleThumbs(0);
    syncCopyButton();
    recordHistory();
    if (start.get('url')) {
        showSourcePicker('link');
        $('url-input').value = start.get('url');
        loadFromLink();
    }
    const shared = new URLSearchParams(location.hash.slice(1));
    if (shared.get('svg')) {
        // A shared SVG (see shareLink): load it, then drop it from the address bar so
        // the page URL doesn't keep pointing at it after the SVG changes.
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
        unpackSvg(shared.get('svg'))
            .then((text) => {
                const name = (shared.get('name') || 'shared.svg').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'shared.svg';
                codeName = name;
                setCodeInput(text);
                loadText(text, name, new Blob([text]).size, null, 'code');
            })
            .catch((err) => showError(/2 MB/.test(err.message) ? err.message : 'The SVG in this link could not be read. The link may have been cut off when it was shared.'));
    }
})();
