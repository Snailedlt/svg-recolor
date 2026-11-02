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
        tint: { label: 'Tint', color: true, desc: 'Grayscale, then add your color. Dark areas take the color, highlights stay light.' },
        colorize: { label: 'Colorize', color: true, desc: 'Your hue and saturation on every color, keeping its lightness, so shading survives.' },
        hue: { label: 'Hue', color: true, desc: 'Changes only the hue. Saturation and lightness stay, so muted tones stay muted.' },
        solid: { label: 'Solid', color: true, desc: 'Every color becomes exactly your color. Best for single-color icons and logos.' },
        grayscale: { label: 'Grayscale', color: false, desc: 'Converts every color to its gray equivalent.' },
        adjust: { label: 'Adjust', color: false, desc: 'Keeps the colors. Use Fine-tune to shift hue, saturation and lightness.' },
    };
    const MODE_KEYS = Object.keys(MODES);
    const F = window.SvgFormats; // code formats, see formats.js
    const NAMED = {"aliceblue":"f0f8ff","antiquewhite":"faebd7","aqua":"00ffff","aquamarine":"7fffd4","azure":"f0ffff","beige":"f5f5dc","bisque":"ffe4c4","black":"000000","blanchedalmond":"ffebcd","blue":"0000ff","blueviolet":"8a2be2","brown":"a52a2a","burlywood":"deb887","cadetblue":"5f9ea0","chartreuse":"7fff00","chocolate":"d2691e","coral":"ff7f50","cornflowerblue":"6495ed","cornsilk":"fff8dc","crimson":"dc143c","cyan":"00ffff","darkblue":"00008b","darkcyan":"008b8b","darkgoldenrod":"b8860b","darkgray":"a9a9a9","darkgreen":"006400","darkgrey":"a9a9a9","darkkhaki":"bdb76b","darkmagenta":"8b008b","darkolivegreen":"556b2f","darkorange":"ff8c00","darkorchid":"9932cc","darkred":"8b0000","darksalmon":"e9967a","darkseagreen":"8fbc8f","darkslateblue":"483d8b","darkslategray":"2f4f4f","darkslategrey":"2f4f4f","darkturquoise":"00ced1","darkviolet":"9400d3","deeppink":"ff1493","deepskyblue":"00bfff","dimgray":"696969","dimgrey":"696969","dodgerblue":"1e90ff","firebrick":"b22222","floralwhite":"fffaf0","forestgreen":"228b22","fuchsia":"ff00ff","gainsboro":"dcdcdc","ghostwhite":"f8f8ff","gold":"ffd700","goldenrod":"daa520","gray":"808080","green":"008000","greenyellow":"adff2f","grey":"808080","honeydew":"f0fff0","hotpink":"ff69b4","indianred":"cd5c5c","indigo":"4b0082","ivory":"fffff0","khaki":"f0e68c","lavender":"e6e6fa","lavenderblush":"fff0f5","lawngreen":"7cfc00","lemonchiffon":"fffacd","lightblue":"add8e6","lightcoral":"f08080","lightcyan":"e0ffff","lightgoldenrodyellow":"fafad2","lightgray":"d3d3d3","lightgreen":"90ee90","lightgrey":"d3d3d3","lightpink":"ffb6c1","lightsalmon":"ffa07a","lightseagreen":"20b2aa","lightskyblue":"87cefa","lightslategray":"778899","lightslategrey":"778899","lightsteelblue":"b0c4de","lightyellow":"ffffe0","lime":"00ff00","limegreen":"32cd32","linen":"faf0e6","magenta":"ff00ff","maroon":"800000","mediumaquamarine":"66cdaa","mediumblue":"0000cd","mediumorchid":"ba55d3","mediumpurple":"9370db","mediumseagreen":"3cb371","mediumslateblue":"7b68ee","mediumspringgreen":"00fa9a","mediumturquoise":"48d1cc","mediumvioletred":"c71585","midnightblue":"191970","mintcream":"f5fffa","mistyrose":"ffe4e1","moccasin":"ffe4b5","navajowhite":"ffdead","navy":"000080","oldlace":"fdf5e6","olive":"808000","olivedrab":"6b8e23","orange":"ffa500","orangered":"ff4500","orchid":"da70d6","palegoldenrod":"eee8aa","palegreen":"98fb98","paleturquoise":"afeeee","palevioletred":"db7093","papayawhip":"ffefd5","peachpuff":"ffdab9","peru":"cd853f","pink":"ffc0cb","plum":"dda0dd","powderblue":"b0e0e6","purple":"800080","rebeccapurple":"663399","red":"ff0000","rosybrown":"bc8f8f","royalblue":"4169e1","saddlebrown":"8b4513","salmon":"fa8072","sandybrown":"f4a460","seagreen":"2e8b57","seashell":"fff5ee","sienna":"a0522d","silver":"c0c0c0","skyblue":"87ceeb","slateblue":"6a5acd","slategray":"708090","slategrey":"708090","snow":"fffafa","springgreen":"00ff7f","steelblue":"4682b4","tan":"d2b48c","teal":"008080","thistle":"d8bfd8","tomato":"ff6347","turquoise":"40e0d0","violet":"ee82ee","wheat":"f5deb3","white":"ffffff","whitesmoke":"f5f5f5","yellow":"ffff00","yellowgreen":"9acd32"};

    // ------------------------------------------------------------------
    // Engine: normalization and mapping, mirroring recolor.py exactly.
    // ------------------------------------------------------------------
    const Engine = (function () {
        const HEX_RE = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z_-])/gi;
        const FUNC_RE = /\b(rgba?|hsla?)\(\s*([^()]{1,80}?)\s*\)/gi;
        const NAMED_RE = /(\b(?:fill|stroke|stop-color|flood-color|lighting-color|color)\s*(?:=\s*["']\s*|:\s*))([a-z]+)\b(?!\s*\()/gi;
        const REF_RE = /(?:url\(\s*["']?|href\s*=\s*["']\s*)$/i;
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        // Python's round() rounds halves to even; match it so output is identical.
        const pyRound = (x) => { const f = Math.floor(x), d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); };
        const hex2 = (n) => pyRound(clamp(n, 0, 255)).toString(16).padStart(2, '0');
        const toHex = (r, g, b) => hex2(r) + hex2(g) + hex2(b);
        const isRef = (text, i) => REF_RE.test(text.slice(Math.max(0, i - 30), i));

        function hlsToRgb(h, l, s) {
            if (s === 0) return [l, l, l];
            const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s, m1 = 2 * l - m2;
            const v = (hue) => {
                hue = ((hue % 1) + 1) % 1;
                if (hue < 1 / 6) return m1 + (m2 - m1) * hue * 6;
                if (hue < 0.5) return m2;
                if (hue < 2 / 3) return m1 + (m2 - m1) * (2 / 3 - hue) * 6;
                return m1;
            };
            return [v(h + 1 / 3), v(h), v(h - 1 / 3)];
        }
        function parseFunc(kind, args) {
            const parts = args.trim().split(/[\s,/]+/).filter(Boolean);
            if (parts.length !== 3 && parts.length !== 4) return null;
            const vals = [];
            for (const p of parts) {
                const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg)?$/i.exec(p);
                if (!m) return null;
                vals.push([parseFloat(m[1]), (m[2] || '').toLowerCase()]);
            }
            let alpha = null;
            if (vals.length === 4) alpha = clamp(vals[3][1] === '%' ? vals[3][0] / 100 : vals[3][0], 0, 1);
            if (kind.toLowerCase().startsWith('rgb')) {
                return [toHex(...vals.slice(0, 3).map(([v, u]) => (u === '%' ? v * 2.55 : v))), alpha];
            }
            const [h, s, l] = vals.map((v) => v[0]);
            const rgb = hlsToRgb((((h % 360) + 360) % 360) / 360, clamp(l, 0, 100) / 100, clamp(s, 0, 100) / 100);
            return [toHex(rgb[0] * 255, rgb[1] * 255, rgb[2] * 255), alpha];
        }
        function normalize(svg) {
            svg = svg.replace(NAMED_RE, (all, pre, name) => {
                const hex = NAMED[name.toLowerCase()];
                return hex ? pre + '#' + hex : all;
            });
            svg = svg.replace(FUNC_RE, (all, kind, args) => {
                const p = parseFunc(kind, args);
                if (!p) return all;
                return '#' + p[0] + (p[1] === null || p[1] >= 1 ? '' : hex2(p[1] * 255));
            });
            const ref = svg;
            svg = svg.replace(HEX_RE, (all, h, offset) => {
                if (isRef(ref, offset)) return all;
                h = h.toLowerCase();
                if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
                return '#' + h;
            });
            const root = /<svg\b[^>]*>/i.exec(svg);
            if (root) {
                const tag = root[0];
                let add = '';
                if (!/\sfill\s*=|[\s;"']fill\s*:/i.test(tag)) add += ' fill="#000000"';
                if (/currentcolor/i.test(svg) && !/\scolor\s*=|[\s;"']color\s*:/i.test(tag)) add += ' color="#000000"';
                if (add) {
                    const end = tag.length - (tag.endsWith('/>') ? 2 : 1);
                    svg = svg.slice(0, root.index) + tag.slice(0, end) + add + tag.slice(end) + svg.slice(root.index + tag.length);
                }
            }
            return svg;
        }
        function palette(norm) {
            const counts = new Map();
            for (const m of norm.matchAll(HEX_RE)) {
                if (isRef(norm, m.index) || (m[1].length !== 6 && m[1].length !== 8)) continue;
                const c = m[1].slice(0, 6).toLowerCase();
                counts.set(c, (counts.get(c) || 0) + 1);
            }
            // Stable sort by count, like Python's sorted(): first-seen order breaks ties.
            return [...counts.entries()].sort((a, b) => b[1] - a[1]);
        }
        function apply(norm, mapping) {
            return norm.replace(HEX_RE, (all, h, offset) => {
                if (isRef(norm, offset) || (h.length !== 6 && h.length !== 8)) return all;
                h = h.toLowerCase();
                return '#' + (mapping[h.slice(0, 6)] || h.slice(0, 6)) + h.slice(6);
            });
        }
        return { normalize, palette, apply };
    })();

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
        doc: null, // { name, size, norm, palette: [[hex, count]], fromUrl }
        result: null, // { svg, filename, palette: [{from, to, count}] }
        mode: 'tint',
        color: '#FF0066',
        adj: { hue: 0, saturation: 0, lightness: 0 },
        tab: 'preview',
        format: 'svg', // set from storage at start
        snippet: 'curl',
    };
    const mapCache = new Map();
    let reqId = 0;
    let controller = null;
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
        } catch (e) {
            showError('Your browser blocked clipboard access. Select the text and copy it manually.');
        }
    }
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
    function settingsParams() {
        const q = new URLSearchParams();
        if (MODES[state.mode].color) q.set('color', state.color.slice(1).toLowerCase());
        q.set('mode', state.mode);
        for (const k of ['hue', 'saturation', 'lightness']) if (state.adj[k]) q.set(k, state.adj[k]);
        return q;
    }
    function settingsChanged() {
        updateSnippet();
        syncPageUrl();
        scheduleLive();
    }

    function setMode(mode, user) {
        if (!MODES[mode]) return;
        state.mode = mode;
        $$('.mode').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
        $('mode-desc').textContent = MODES[mode].desc;
        $('color-step').classList.toggle('step-off', !MODES[mode].color);
        $('color-note').textContent = MODES[mode].color ? '' : 'not used by ' + MODES[mode].label;
        if (mode === 'adjust') $('finetune').open = true;
        if (user) settingsChanged();
    }
    $$('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode, true)));

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
        $('finetune-badge').hidden = !(state.adj.hue || state.adj.saturation || state.adj.lightness);
        if (user) settingsChanged();
    }
    ADJ.forEach(([k]) => $('adj-' + k).addEventListener('input', () => syncAdjust(true)));
    $('adj-reset').addEventListener('click', () => { ADJ.forEach(([k]) => { $('adj-' + k).value = 0; }); syncAdjust(true); });

    $('reset-all').addEventListener('click', () => {
        ADJ.forEach(([k]) => { $('adj-' + k).value = 0; });
        syncAdjust(false);
        setColor('#FF0066', false);
        setMode('tint', false);
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
    function showSource(kind) {
        $('source-file').hidden = kind !== 'file';
        $('source-link').hidden = kind !== 'link';
        $$('#source-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.source === kind)));
    }
    function showSourcePicker(kind) {
        $('file-chip').hidden = true;
        $('source-tabs').hidden = false;
        $('example-row').hidden = false;
        showSource(kind);
    }
    $$('#source-tabs button').forEach((b) => b.addEventListener('click', () => {
        showSource(b.dataset.source);
        if (b.dataset.source === 'link') $('url-input').focus();
    }));
    $('change-file').addEventListener('click', () => {
        showSourcePicker(state.doc && state.doc.fromUrl ? 'link' : 'file');
        if (state.doc && state.doc.fromUrl) $('url-input').select(); else fileInput.click();
    });

    async function loadText(text, name, size, fromUrl) {
        clearError();
        if (size > MAX_BYTES) return showError('This file is ' + formatBytes(size) + '. The limit is 2 MB; try optimizing it with SVGO first.');
        if (!/<svg[\s>]/i.test(text)) return showError('That doesn\'t look like an SVG: no <svg> element was found.');
        const norm = Engine.normalize(text);
        state.doc = { name, size, norm, palette: Engine.palette(norm), fromUrl: fromUrl || null };
        state.result = null;

        if (originalUrl) URL.revokeObjectURL(originalUrl);
        originalUrl = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
        renderImage($('preview-container'), originalUrl, 'Original ' + name);
        $('file-thumb').src = originalUrl;
        $('file-name').textContent = name;
        $('file-size').textContent = formatBytes(size) + ' · ' + state.doc.palette.length + ' colors' + (fromUrl ? ' · from link' : '');
        $('file-chip').hidden = false;
        $('source-file').hidden = true;
        $('source-link').hidden = true;
        $('source-tabs').hidden = true;
        $('example-row').hidden = true;
        if (fromUrl) $('url-input').value = fromUrl;
        updateSnippet();
        syncPageUrl();
        recolor();
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
        if (t === hexInput || t === $('url-input')) return;
        const data = e.clipboardData;
        if (!data) return;
        const file = Array.from(data.files || []).find((f) => /svg/i.test(f.type) || /\.svg$/i.test(f.name));
        if (file) { e.preventDefault(); loadFile(file); return; }
        const text = data.getData('text/plain');
        if (text && /<svg[\s>]/i.test(text)) { e.preventDefault(); loadText(text, 'pasted.svg', new Blob([text]).size, null); return; }
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
            const res = await fetch('/static/examples/python.svg');
            if (!res.ok) throw new Error();
            const text = await res.text();
            loadText(text, 'python.svg', new Blob([text]).size, null);
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
    async function fetchMapping(colors) {
        const params = settingsParams();
        const key = params.toString();
        let known = mapCache.get(key) || {};
        const missing = colors.filter((c) => !(c in known)).sort();
        if (missing.length) {
            if (controller) controller.abort();
            controller = new AbortController();
            let res;
            if (missing.length <= MAX_GET_COLORS) {
                const q = new URLSearchParams(params);
                q.set('colors', missing.join(','));
                if (ENGINE_VERSION) q.set('v', ENGINE_VERSION);
                res = await fetch('/api/map-colors?' + q.toString(), { signal: controller.signal });
            } else {
                const body = Object.fromEntries(params);
                body.colors = missing;
                res = await fetch('/api/map-colors', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
                });
            }
            if (!res.ok) throw new Error(await errorDetail(res));
            const data = await res.json();
            known = Object.assign({}, known);
            for (const [from, to] of Object.entries(data.mapping)) known[from.slice(1).toLowerCase()] = to.slice(1).toLowerCase();
            mapCache.set(key, known);
            if (mapCache.size > 300) mapCache.delete(mapCache.keys().next().value);
        }
        return known;
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
            const mapping = colors.length ? await fetchMapping(colors) : {};
            if (id !== reqId || doc !== state.doc) return;
            state.result = {
                svg: Engine.apply(doc.norm, mapping),
                filename: outputName(),
                palette: doc.palette.map(([c, n]) => ({ from: '#' + c, to: '#' + (mapping[c] || c), count: n })),
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
        renderPalette(r.palette);
        if (state.tab === 'code') renderCode();
        syncCopyButton();
        syncDownload();
    }
    function renderPalette(entries) {
        const list = $('palette-list');
        list.replaceChildren();
        entries.forEach((e) => {
            const li = document.createElement('li');
            li.title = e.from + ' → ' + e.to + ' (used ' + e.count + '×)';
            const a = document.createElement('i'); a.style.background = e.from;
            const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '→';
            const b = document.createElement('i'); b.style.background = e.to;
            const t = document.createElement('span'); t.textContent = e.to.toUpperCase();
            li.append(a, arrow, b, t);
            list.appendChild(li);
        });
        $('palette').hidden = entries.length === 0;
    }

    // ------------------------------------------------------------------
    // Code tab: output formats
    // ------------------------------------------------------------------
    let codeCache = { key: null, text: '' };
    function codeFor(id) {
        if (!state.result) return '';
        const key = id + '\u0000' + state.result.svg;
        if (codeCache.key !== key) codeCache = { key, text: F.convert(id, state.result.svg) };
        return codeCache.text;
    }
    function codeFileName(id) {
        const f = F.get(id);
        if (id === 'svg') return state.result ? state.result.filename : 'icon.svg';
        return f.file.split('/').pop();
    }
    function renderCode() {
        const view = $('code-view');
        const f = F.get(state.format);
        if (!state.result) {
            view.textContent = 'Load an SVG to see it as ' + f.label + ' code here.';
            $('code-meta').textContent = '';
            $('code-hint').textContent = '';
            return;
        }
        const text = codeFor(state.format);
        view.textContent = text.length > CODE_VIEW_LIMIT ? text.slice(0, CODE_VIEW_LIMIT) + '\n\n… shortened in this view. Copy and Download include everything.' : text;
        const meta = $('code-meta');
        meta.replaceChildren();
        const file = document.createElement('span');
        file.className = 'file';
        file.textContent = f.file;
        meta.append(file, ' · ' + formatBytes(new Blob([text]).size) + ' · ' + text.split('\n').length + ' lines');
        $('code-hint').textContent = f.usage;
    }

    // Format picker: recent formats as icon buttons, plus a searchable menu.
    function setFormat(id, fromMenu) {
        if (!F.has(id)) id = 'svg';
        state.format = id;
        store.set('format', id);
        const recent = [id].concat(store.get('recentFormats', ['svg', 'react', 'vue', 'svelte']).filter((x) => x !== id && F.has(x))).slice(0, 4);
        store.set('recentFormats', recent);
        syncFormatButton();
        if (!fromMenu) renderQuickFormats();
        renderCode();
        syncCopyButton();
        syncDownload();
    }
    function syncFormatButton() {
        const f = F.get(state.format);
        $('format-btn-icon').innerHTML = F.icon(f, 16);
        $('format-btn-label').textContent = f.label;
        $$('.format-item, #quick-formats button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.format === state.format)));
    }
    function renderQuickFormats() {
        const box = $('quick-formats');
        box.replaceChildren();
        store.get('recentFormats', ['svg', 'react', 'vue', 'svelte']).filter((id) => F.has(id)).forEach((id) => {
            const f = F.get(id);
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.format = id;
            b.title = f.label;
            b.setAttribute('aria-label', f.label);
            b.innerHTML = F.icon(f, 15);
            b.addEventListener('click', () => setFormat(id, true));
            box.appendChild(b);
        });
        syncFormatButton();
    }
    function renderFormatMenu(filter) {
        const q = (filter || '').trim().toLowerCase();
        const groups = $('format-groups');
        groups.replaceChildren();
        let shown = 0;
        F.groups.forEach((g) => {
            const items = F.list.filter((f) => f.group === g && (!q || (f.label + ' ' + f.id + ' ' + f.group + ' ' + f.file).toLowerCase().includes(q)));
            if (!items.length) return;
            const section = document.createElement('div');
            section.className = 'format-group';
            const h = document.createElement('h3');
            h.textContent = g;
            const grid = document.createElement('div');
            grid.className = 'format-grid';
            items.forEach((f) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'format-item';
                b.dataset.format = f.id;
                b.title = f.file;
                b.innerHTML = F.icon(f, 16);
                const label = document.createElement('span');
                label.textContent = f.label;
                b.appendChild(label);
                b.addEventListener('click', () => { setFormat(f.id); closeFormatMenu(true); });
                grid.appendChild(b);
                shown++;
            });
            section.append(h, grid);
            groups.appendChild(section);
        });
        $('format-empty').hidden = shown > 0;
        syncFormatButton();
    }
    function openFormatMenu() {
        if (state.tab !== 'code') setTab('code');
        renderFormatMenu('');
        $('format-search').value = '';
        $('format-menu').hidden = false;
        $('format-btn').setAttribute('aria-expanded', 'true');
        $('format-search').focus();
    }
    function closeFormatMenu(focusButton) {
        if ($('format-menu').hidden) return;
        $('format-menu').hidden = true;
        $('format-btn').setAttribute('aria-expanded', 'false');
        if (focusButton) $('format-btn').focus();
    }
    $('format-btn').addEventListener('click', () => ($('format-menu').hidden ? openFormatMenu() : closeFormatMenu(false)));
    $('format-search').addEventListener('input', (e) => renderFormatMenu(e.target.value));
    $('format-search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const first = $('format-groups').querySelector('.format-item');
            if (first) first.click();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const first = $('format-groups').querySelector('.format-item');
            if (first) first.focus();
        }
    });
    $('format-menu').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFormatMenu(true); return; }
        if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key) || e.target.tagName === 'INPUT') return;
        const items = $$('#format-groups .format-item');
        const i = items.indexOf(e.target);
        if (i < 0) return;
        e.preventDefault();
        const step = { ArrowDown: 2, ArrowUp: -2, ArrowRight: 1, ArrowLeft: -1 }[e.key];
        const next = items[i + step];
        if (next) next.focus(); else if (step < 0) $('format-search').focus();
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.format-picker')) closeFormatMenu(false);
    });

    // ------------------------------------------------------------------
    // API tab: snippets for the current settings
    // ------------------------------------------------------------------
    function updateSnippet() {
        const q = settingsParams();
        const link = (state.doc && state.doc.fromUrl) || 'https://example.com/icon.svg';
        const getQ = new URLSearchParams(q);
        getQ.set('url', link);
        const getUrl = SITE + '/api/recolor?' + getQ.toString();
        const fname = state.doc && !state.doc.fromUrl ? state.doc.name : 'icon.svg';
        const out = fname.replace(/\.svg$/i, '') + '-recolored.svg';
        const pyParams = '{' + Array.from(q).map(([k, v]) => JSON.stringify(k) + ': ' + JSON.stringify(v)).join(', ') + '}';
        const jsonBody = Object.assign({ svg: '<svg …>' }, Object.fromEntries(q));
        const snippets = {
            curl: '# Upload a file\ncurl -X POST "' + SITE + '/api/recolor?' + q.toString() + '" \\\n  -F "file=@' + fname + '" \\\n  -o ' + out
                + '\n\n# Or send JSON and get the color mapping back too\ncurl -X POST "' + SITE + '/api/recolor?format=json" \\\n  -H "Content-Type: application/json" \\\n  -d \'' + JSON.stringify(jsonBody) + '\'',
            link: '# Recolor a linked SVG (cached, safe to hotlink)\n' + getUrl,
            html: '<\!-- Use the API directly as an image -->\n<img src="' + getUrl + '" alt="">',
            js: "const form = new FormData();\nform.append('file', file); // a File or Blob\n\nconst res = await fetch('" + SITE + '/api/recolor?' + q.toString() + "', {\n  method: 'POST',\n  body: form,\n});\nif (!res.ok) throw new Error((await res.json()).detail);\nconst svg = await res.text();",
            python: 'import requests\n\nwith open("' + fname + '", "rb") as f:\n    res = requests.post(\n        "' + SITE + '/api/recolor",\n        params=' + pyParams + ',\n        files={"file": f},\n    )\nres.raise_for_status()\n\nwith open("' + out + '", "wb") as f:\n    f.write(res.content)',
            mcp: '# Claude Code\nclaude mcp add --transport http svg-recolor ' + SITE + '/mcp\n\n# Other MCP clients (JSON config)\n{\n  "mcpServers": {\n    "svg-recolor": { "type": "http", "url": "' + SITE + '/mcp" }\n  }\n}\n\n# Then ask your agent, for example:\n# "Recolor ' + fname + ' with svg-recolor: mode ' + state.mode + (MODES[state.mode].color ? ', color ' + state.color : '') + '"',
        };
        $('snippet').textContent = snippets[state.snippet];
        $('mcp-cmd').textContent = 'claude mcp add --transport http svg-recolor ' + SITE + '/mcp';
        $('llms-url').textContent = SITE + '/llms.txt';
    }
    $$('#snippet-tabs button').forEach((b) => b.addEventListener('click', () => {
        state.snippet = b.dataset.snippet;
        $$('#snippet-tabs button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        updateSnippet();
    }));

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
        if (tab !== 'code') closeFormatMenu(false);
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
            $('copy-label').textContent = 'Copy snippet';
            btn.disabled = false;
        } else {
            $('copy-label').textContent = 'Copy ' + (state.tab === 'code' ? F.get(state.format).label : 'SVG');
            btn.disabled = !state.result;
        }
    }
    function copyCurrent() {
        if (state.tab === 'api') return copyText($('snippet').textContent, 'Snippet');
        if (!state.result) return;
        const id = state.tab === 'code' ? state.format : 'svg';
        copyText(codeFor(id), F.get(id).label);
    }
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
    $$('[data-copy-from]').forEach((b) => b.addEventListener('click', () => copyText($(b.dataset.copyFrom).textContent, 'Command')));
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
        const q = settingsParams();
        if (state.doc && state.doc.fromUrl) q.set('url', state.doc.fromUrl);
        return q;
    }
    function syncPageUrl() {
        clearTimeout(urlTimer);
        urlTimer = setTimeout(() => {
            try { history.replaceState(null, '', location.pathname + '?' + shareParams().toString() + location.hash); } catch (e) { /* ignore */ }
        }, 300);
    }
    $('share-btn').addEventListener('click', () => {
        const link = SITE + '/?' + shareParams().toString();
        copyText(link, state.doc && state.doc.fromUrl ? 'Link with this SVG and settings' : 'Link with these settings (uploads are not included)');
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
        else if (key === 'f') openFormatMenu();
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
    if (state.adj.hue || state.adj.saturation || state.adj.lightness) $('finetune').open = true;
    setMode(MODES[start.get('mode')] ? start.get('mode') : 'tint', false);
    setBg(store.get('bg', 'checker'));
    setView(store.get('view', window.matchMedia('(max-width: 560px)').matches ? 'slider' : 'side'));
    renderRecent();
    state.format = F.has(store.get('format', 'svg')) ? store.get('format', 'svg') : 'svg';
    renderQuickFormats();
    updateSnippet();
    syncCopyButton();
    if (start.get('url')) {
        showSourcePicker('link');
        $('url-input').value = start.get('url');
        loadFromLink();
    }
})();
