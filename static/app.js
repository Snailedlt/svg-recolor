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
        // { op: 'replace', to: '#rrggbb' } | { op: 'hide' } | { op: 'remove' }
        edits: {},
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
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = fill ? 'copy-chip' : 'btn btn-ghost btn-sm copy-btn-row';
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
        // Ctrl/Cmd+C with nothing selected copies the whole block.
        pre.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'c' && !String(window.getSelection())) {
                e.preventDefault();
                copy();
            }
        });
        if (fill) {
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
    $$('pre.code').forEach(setupCodeBlock);

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
        img.onload = () => { if (!img.naturalWidth) img.classList.add('fill'); };
        container.replaceChildren(img);
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
    function settingsParams(mode) {
        mode = mode || state.mode;
        const q = new URLSearchParams();
        if (MODES[mode].color) q.set('color', state.color.slice(1).toLowerCase());
        q.set('mode', mode);
        for (const k of ['hue', 'saturation', 'lightness']) if (state.adj[k]) q.set(k, state.adj[k]);
        return q;
    }
    // Edits as API parameters (replace=old:new,...&hide=...&remove=...). Kept out of
    // settingsParams, which also keys the cached /api/map-colors requests.
    function editParams(q) {
        q = q || new URLSearchParams();
        const by = { replace: [], hide: [], remove: [] };
        for (const [c, e] of Object.entries(state.edits)) by[e.op].push(e.op === 'replace' ? c + ':' + e.to.slice(1).toLowerCase() : c);
        for (const k of ['replace', 'hide', 'remove']) if (by[k].length) q.set(k, by[k].join(','));
        return q;
    }
    function editsFromParams(q) {
        const edits = {};
        const hex = (v) => { const h = normalizeHex(v); return h ? h.slice(1).toLowerCase() : null; };
        for (const pair of (q.get('replace') || '').split(',')) {
            const [a, b] = pair.split(':'); const from = hex(a), to = normalizeHex(b || '');
            if (from && to) edits[from] = { op: 'replace', to };
        }
        for (const op of ['hide', 'remove']) for (const v of (q.get(op) || '').split(',')) { const c = hex(v); if (c) edits[c] = { op }; }
        return edits;
    }
    // The mapping with own colors applied, and the SVG with hidden/removed colors applied.
    function editedSvg(doc, mapping) {
        const merged = Object.assign({}, mapping);
        const hide = [], remove = [];
        for (const [c, e] of Object.entries(state.edits)) {
            if (e.op === 'replace') merged[c] = e.to.slice(1).toLowerCase();
            else (e.op === 'hide' ? hide : remove).push(c);
        }
        return { svg: Engine.apply(Engine.edit(doc.norm, hide, remove), merged), merged };
    }
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
        state.color = hex;
        $('color-input').value = hex.toLowerCase();
        if (document.activeElement !== hexInput) hexInput.value = hex.slice(1);
        $('hex-field').classList.remove('invalid');
        root.style.setProperty('--pick', hex);
        $$('.preset').forEach((p) => p.setAttribute('aria-pressed', String(p.dataset.hex === hex)));
        if (user) settingsChanged();
    }
    $('color-input').addEventListener('input', (e) => setColor(e.target.value.toUpperCase(), true));
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
        if (user) settingsChanged();
    }
    ADJ.forEach(([k]) => $('adj-' + k).addEventListener('input', () => syncAdjust(true)));
    $('adj-reset').addEventListener('click', () => { ADJ.forEach(([k]) => { $('adj-' + k).value = 0; }); syncAdjust(true); });

    $('reset-all').addEventListener('click', () => {
        ADJ.forEach(([k]) => { $('adj-' + k).value = 0; });
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
        state.doc = { name, size, text, norm, palette: Engine.palette(norm), fromUrl: fromUrl || null, source };
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
    }
    async function loadFile(file) {
        if (!file) return;
        if (!(file.type === 'image/svg+xml' || /\.svg$/i.test(file.name) || file.type === '' || file.type.startsWith('text/'))) {
            return showError('That doesn\'t look like an SVG. Please choose a .svg file.');
        }
        if (file.size > MAX_BYTES) return showError('This file is ' + formatBytes(file.size) + '. The limit is 2 MB; try optimizing it with SVGO first.');
        loadText(await file.text(), file.name || 'image.svg', file.size, null);
    }
    fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });

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
        const file = e.dataTransfer && e.dataTransfer.files[0];
        if (file) { e.preventDefault(); loadFile(file); }
    });
    document.addEventListener('paste', (e) => {
        const t = e.target;
        if (t === hexInput || t === $('url-input') || t === $('code-input')) return;
        const data = e.clipboardData;
        if (!data) return;
        const file = Array.from(data.files || []).find((f) => /svg/i.test(f.type) || /\.svg$/i.test(f.name));
        if (file) { e.preventDefault(); loadFile(file); return; }
        const text = data.getData('text/plain');
        if (text && /<svg[\s>]/i.test(text)) { e.preventDefault(); setCodeInput(text); codeName = null; loadText(text, 'pasted.svg', new Blob([text]).size, null, 'code'); return; }
        if (text && /^https?:\/\/\S+$/i.test(text.trim()) && !(t && /^(INPUT|TEXTAREA)$/.test(t.tagName))) {
            e.preventDefault();
            showSourcePicker('link');
            $('url-input').value = text.trim();
            loadFromLink();
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
    function sharedParams() {
        const q = settingsParams('tint'); // color + adjustments
        q.delete('mode');
        return q;
    }
    async function fetchAllModes(colors) {
        const missing = MODE_KEYS.filter((m) => {
            const known = mapCache.get(settingsParams(m).toString());
            return !known || colors.some((c) => !(c in known));
        });
        if (!missing.length || !colors.length) return;
        const sorted = [...new Set(colors)].sort();
        const shared = sharedParams();
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
    async function mappingFor(mode, colors) {
        await fetchAllModes(colors);
        return mapCache.get(settingsParams(mode).toString()) || {};
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

    function outputName() {
        const stem = (state.doc.name || 'image.svg').replace(/\.svg$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'image';
        return stem + '_recolored_' + state.mode + (MODES[state.mode].color ? '_' + state.color.slice(1).toLowerCase() : '') + '.svg';
    }
    function setBusy(on) {
        $('submit-btn').classList.toggle('loading', on);
        const img = $('result-container').querySelector('img');
        if (img) img.classList.toggle('busy', on);
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
            const mapping = colors.length ? await mappingFor(state.mode, colors) : {};
            if (id !== reqId || doc !== state.doc) return;
            const { svg, merged } = editedSvg(doc, mapping);
            const to = (c) => {
                const e = state.edits[c];
                return e && e.op === 'remove' ? 'removed' : e && e.op === 'hide' ? 'none' : '#' + (merged[c] || c);
            };
            state.result = {
                svg,
                filename: outputName(),
                palette: doc.palette.map(([c, n]) => ({ from: '#' + c, to: to(c), count: n, edit: state.edits[c] || null })),
            };
            renderResult();
            if (MODES[state.mode].color) rememberColor(state.color);
            const size = formatBytes(new Blob([state.result.svg]).size);
            setStatus('ok', MODES[state.mode].label + (MODES[state.mode].color ? ' ' + state.color : '') + ' · ' + colors.length + ' colors · ' + size);
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
        renderImage($('result-container'), resultUrl, 'Recolored ' + state.doc.name);
        $('code-preview-img').src = resultUrl;
        renderPalette(r.palette);
        if (!editPanel.hidden && editColor) { editAnchor = document.querySelector('.chip[data-color="' + editColor + '"]'); placeEditPanel(); }
        if (state.tab === 'code') renderCode();
        syncCopyButton();
        syncDownload();
    }
    // Colors strip: each original color and what it became. Click a color to give it its
    // own color, hide it, or remove its shapes (see the color-edit panel below).
    const EDIT_LABEL = { replace: 'own color', hide: 'hidden', remove: 'removed' };
    function renderPalette(entries) {
        const list = $('palette-list');
        list.replaceChildren();
        entries.forEach((e) => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'chip' + (e.edit ? ' edited ' + e.edit.op : '');
            btn.dataset.color = e.from.slice(1);
            const shown = e.to === 'removed' ? 'Removed' : e.to === 'none' ? 'Hidden' : e.to.toUpperCase();
            btn.title = e.from.toUpperCase() + ' → ' + shown + ' (used ' + e.count + '×). Click to edit this color.';
            btn.setAttribute('aria-label', 'Edit ' + e.from.toUpperCase() + ', now ' + shown + (e.edit ? ' (' + EDIT_LABEL[e.edit.op] + ')' : ''));
            const a = document.createElement('i'); a.style.background = e.from;
            const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '→';
            const b = document.createElement('i');
            if (e.to.startsWith('#')) b.style.background = e.to; else b.className = 'gone';
            const t = document.createElement('span'); t.textContent = shown;
            btn.append(a, arrow, b, t);
            btn.addEventListener('click', () => openColorEdit(e.from.slice(1), btn));
            li.appendChild(btn);
            list.appendChild(li);
        });
        $('palette').hidden = entries.length === 0;
        $('edits-reset').hidden = !Object.keys(state.edits).length;
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
        const e = state.edits[color];
        const entry = state.result && state.result.palette.find((p) => p.from === '#' + color);
        $('color-edit-from').style.background = '#' + color;
        $('color-edit-title').textContent = '#' + color.toUpperCase();
        $('color-edit-count').textContent = entry ? 'used ' + entry.count + '×' : '';
        const op = e ? e.op : 'style';
        $$('#color-edit [name="color-edit-op"]').forEach((r) => { r.checked = r.value === op; });
        const styleTo = entry && entry.edit ? null : entry && entry.to;
        $('color-edit-own').value = e && e.op === 'replace' ? e.to : (styleTo && styleTo.startsWith('#') ? styleTo : '#' + color);
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
        if (state.doc) recolor();
    }
    $$('#color-edit [name="color-edit-op"]').forEach((r) => r.addEventListener('change', () => setColorEdit(r.value)));
    $('color-edit-own').addEventListener('input', () => {
        $$('#color-edit [name="color-edit-op"]').forEach((r) => { r.checked = r.value === 'replace'; });
        setColorEdit('replace');
    });
    $('color-edit-close').addEventListener('click', () => closeColorEdit(true));
    editPanel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeColorEdit(true); } });
    document.addEventListener('pointerdown', (e) => {
        if (!editPanel.hidden && !editPanel.contains(e.target) && !e.target.closest('.chip')) closeColorEdit(false);
    });
    window.addEventListener('resize', placeEditPanel);
    $('palette-list').addEventListener('scroll', placeEditPanel, { passive: true });
    $('edits-reset').addEventListener('click', () => {
        state.edits = {};
        closeColorEdit(false);
        editsChanged();
        toast('Color edits reset');
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
        const q = editParams(settingsParams());
        const params = {};
        for (const [k, v] of q) params[k] = /^(hue|saturation|lightness)$/.test(k) ? Number(v) : v;
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
    $('compare-range').addEventListener('input', (e) => stage.style.setProperty('--split', e.target.value + '%'));

    function shareParams() {
        const q = editParams(settingsParams());
        if (state.doc && state.doc.fromUrl) q.set('url', state.doc.fromUrl);
        return q;
    }
    function syncPageUrl() {
        clearTimeout(urlTimer);
        urlTimer = setTimeout(() => {
            try { history.replaceState(null, '', location.pathname + '?' + shareParams().toString() + location.hash); } catch (e) { /* ignore */ }
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
        return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
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
        else if (key === 'v') setView(stage.dataset.view === 'slider' ? 'side' : 'slider');
        else if (key === 'b') { const order = ['checker', 'light', 'dark']; setBg(order[(order.indexOf(stage.dataset.bg) + 1) % 3]); }
        else if (e.key === '?') openShortcuts();
        else return;
        e.preventDefault();
    });

    // ------------------------------------------------------------------
    // Start: settings from the page URL, then remembered preferences
    // ------------------------------------------------------------------
    const start = new URLSearchParams(location.search);
    setColor(normalizeHex(start.get('color')) || '#FF0066', false);
    ADJ.forEach(([k, lim]) => {
        const v = parseInt(start.get(k), 10);
        if (!Number.isNaN(v)) $('adj-' + k).value = Math.max(-lim, Math.min(lim, v));
    });
    syncAdjust(false);
    setMode(MODES[start.get('mode')] ? start.get('mode') : 'colorize', false);
    state.edits = editsFromParams(start);
    setBg(store.get('bg', 'checker'));
    setView(store.get('view', window.matchMedia('(max-width: 560px)').matches ? 'slider' : 'side'));
    renderRecent();
    state.format = formatList.get();
    state.snippet = snippetList.get();
    updateSnippet();
    scheduleThumbs(0);
    syncCopyButton();
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
            .catch(() => showError('The SVG in this link could not be read. The link may have been cut off when it was shared.'));
    }
})();
