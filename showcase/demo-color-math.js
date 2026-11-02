/* Showcase only: the svgray + svgshift color math ported to the browser, so the
 * standalone demo page works without the server. Results can differ from the
 * real tools by 1 in a channel (svgshift uses 32-bit floats). The live site and
 * the API always use the real tools.
 */
// In-browser port of recolor.py: same normalization, palette mapping and svgray/svgshift math.
const DemoEngine = (function () {
    const NAMED = {"aliceblue": "f0f8ff", "antiquewhite": "faebd7", "aqua": "00ffff", "aquamarine": "7fffd4", "azure": "f0ffff", "beige": "f5f5dc", "bisque": "ffe4c4", "black": "000000", "blanchedalmond": "ffebcd", "blue": "0000ff", "blueviolet": "8a2be2", "brown": "a52a2a", "burlywood": "deb887", "cadetblue": "5f9ea0", "chartreuse": "7fff00", "chocolate": "d2691e", "coral": "ff7f50", "cornflowerblue": "6495ed", "cornsilk": "fff8dc", "crimson": "dc143c", "cyan": "00ffff", "darkblue": "00008b", "darkcyan": "008b8b", "darkgoldenrod": "b8860b", "darkgray": "a9a9a9", "darkgreen": "006400", "darkgrey": "a9a9a9", "darkkhaki": "bdb76b", "darkmagenta": "8b008b", "darkolivegreen": "556b2f", "darkorange": "ff8c00", "darkorchid": "9932cc", "darkred": "8b0000", "darksalmon": "e9967a", "darkseagreen": "8fbc8f", "darkslateblue": "483d8b", "darkslategray": "2f4f4f", "darkslategrey": "2f4f4f", "darkturquoise": "00ced1", "darkviolet": "9400d3", "deeppink": "ff1493", "deepskyblue": "00bfff", "dimgray": "696969", "dimgrey": "696969", "dodgerblue": "1e90ff", "firebrick": "b22222", "floralwhite": "fffaf0", "forestgreen": "228b22", "fuchsia": "ff00ff", "gainsboro": "dcdcdc", "ghostwhite": "f8f8ff", "gold": "ffd700", "goldenrod": "daa520", "gray": "808080", "green": "008000", "greenyellow": "adff2f", "grey": "808080", "honeydew": "f0fff0", "hotpink": "ff69b4", "indianred": "cd5c5c", "indigo": "4b0082", "ivory": "fffff0", "khaki": "f0e68c", "lavender": "e6e6fa", "lavenderblush": "fff0f5", "lawngreen": "7cfc00", "lemonchiffon": "fffacd", "lightblue": "add8e6", "lightcoral": "f08080", "lightcyan": "e0ffff", "lightgoldenrodyellow": "fafad2", "lightgray": "d3d3d3", "lightgreen": "90ee90", "lightgrey": "d3d3d3", "lightpink": "ffb6c1", "lightsalmon": "ffa07a", "lightseagreen": "20b2aa", "lightskyblue": "87cefa", "lightslategray": "778899", "lightslategrey": "778899", "lightsteelblue": "b0c4de", "lightyellow": "ffffe0", "lime": "00ff00", "limegreen": "32cd32", "linen": "faf0e6", "magenta": "ff00ff", "maroon": "800000", "mediumaquamarine": "66cdaa", "mediumblue": "0000cd", "mediumorchid": "ba55d3", "mediumpurple": "9370db", "mediumseagreen": "3cb371", "mediumslateblue": "7b68ee", "mediumspringgreen": "00fa9a", "mediumturquoise": "48d1cc", "mediumvioletred": "c71585", "midnightblue": "191970", "mintcream": "f5fffa", "mistyrose": "ffe4e1", "moccasin": "ffe4b5", "navajowhite": "ffdead", "navy": "000080", "oldlace": "fdf5e6", "olive": "808000", "olivedrab": "6b8e23", "orange": "ffa500", "orangered": "ff4500", "orchid": "da70d6", "palegoldenrod": "eee8aa", "palegreen": "98fb98", "paleturquoise": "afeeee", "palevioletred": "db7093", "papayawhip": "ffefd5", "peachpuff": "ffdab9", "peru": "cd853f", "pink": "ffc0cb", "plum": "dda0dd", "powderblue": "b0e0e6", "purple": "800080", "rebeccapurple": "663399", "red": "ff0000", "rosybrown": "bc8f8f", "royalblue": "4169e1", "saddlebrown": "8b4513", "salmon": "fa8072", "sandybrown": "f4a460", "seagreen": "2e8b57", "seashell": "fff5ee", "sienna": "a0522d", "silver": "c0c0c0", "skyblue": "87ceeb", "slateblue": "6a5acd", "slategray": "708090", "slategrey": "708090", "snow": "fffafa", "springgreen": "00ff7f", "steelblue": "4682b4", "tan": "d2b48c", "teal": "008080", "thistle": "d8bfd8", "tomato": "ff6347", "turquoise": "40e0d0", "violet": "ee82ee", "wheat": "f5deb3", "white": "ffffff", "whitesmoke": "f5f5f5", "yellow": "ffff00", "yellowgreen": "9acd32"};
    const HEX_RE = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z_-])/gi;
    const FUNC_RE = /\b(rgba?|hsla?)\(\s*([^()]{1,80}?)\s*\)/gi;
    const NAMED_RE = /(\b(?:fill|stroke|stop-color|flood-color|lighting-color|color)\s*(?:=\s*["']\s*|:\s*))([a-z]+)\b(?!\s*\()/gi;
    const REF_RE = /(?:url\(\s*["']?|href\s*=\s*["']\s*)$/i;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const toHex = (r, g, b) => [r, g, b].map((c) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, '0')).join('');
    const isRef = (t, i) => REF_RE.test(t.slice(Math.max(0, i - 30), i));
    function hslToRgbFloat(h, s, l) {
        if (s === 0) return [l * 255, l * 255, l * 255];
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
        const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
        return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
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
        if (kind.toLowerCase().startsWith('rgb')) return [toHex(...vals.slice(0, 3).map(([v, u]) => (u === '%' ? v * 2.55 : v))), alpha];
        const [h, s, l] = vals.map((v) => v[0]);
        return [toHex(...hslToRgbFloat(((h % 360) + 360) % 360 / 360, clamp(s, 0, 100) / 100, clamp(l, 0, 100) / 100)), alpha];
    }
    function parseColor(v) {
        v = String(v || '').trim().toLowerCase();
        if (NAMED[v]) v = '#' + NAMED[v];
        let m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(v);
        if (m) { let h = m[1]; if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
        throw new Error("Invalid color '" + v + "'.");
    }
    function normalize(svg) {
        svg = svg.replace(NAMED_RE, (all, pre, name) => (NAMED[name.toLowerCase()] ? pre + '#' + NAMED[name.toLowerCase()] : all));
        svg = svg.replace(FUNC_RE, (all, kind, args) => {
            const p = parseFunc(kind, args);
            if (!p) return all;
            return '#' + p[0] + (p[1] === null || p[1] >= 1 ? '' : Math.round(p[1] * 255).toString(16).padStart(2, '0'));
        });
        const ref = svg;
        svg = svg.replace(HEX_RE, (all, h, off) => {
            if (isRef(ref, off)) return all;
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
    function palette(svg) {
        const counts = new Map();
        for (const m of svg.matchAll(HEX_RE)) {
            if (isRef(svg, m.index) || (m[1].length !== 6 && m[1].length !== 8)) continue;
            const c = m[1].slice(0, 6).toLowerCase();
            counts.set(c, (counts.get(c) || 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    }
    // svgshift's own RGB<->HSL (H 0-360, S/L 0-100, half-up rounding, truncating back to RGB).
    const fround = (x) => { const i = Math.trunc(x); return i + (x - i >= 0.5 ? 1 : 0); };
    function rgbToHsl([R, G, B]) {
        const r = R / 255, g = G / 255, b = B / 255, max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        let h = 0, s = 0; const l = (max + min) / 2;
        if (max !== min) {
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            h /= 6;
        }
        return [fround(h * 360), fround(s * 100), fround(l * 100)];
    }
    const hslToRgb = ([h, s, l]) => hslToRgbFloat(h / 360, s / 100, l / 100).map((v) => Math.trunc(v));
    const hexToRgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    function svgshift(op, values, colors) {
        const kind = op.slice(0, 3), isRgb = op.endsWith('rgb');
        return colors.map((hex) => {
            const rgb = hexToRgb(hex);
            let c = isRgb ? rgb : rgbToHsl(rgb);
            c = c.map((v, i) => (values[i] == null ? v : kind === 'set' ? values[i] : kind === 'add' ? v + values[i] : v - values[i]));
            if (isRgb) return toHex(...c.map((v) => clamp(v, 0, 255)));
            c = [clamp(c[0], 0, 360), clamp(c[1], 0, 100), clamp(c[2], 0, 100)];
            return toHex(...hslToRgb(c));
        });
    }
    const gray = (hex) => { const [r, g, b] = hexToRgb(hex); const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b); return toHex(y, y, y); };
    function rotateHue(colors, deg) {
        const d = ((deg % 360) + 360) % 360;
        if (!d) return colors;
        return colors.map((c) => {
            const [h, s] = rgbToHsl(hexToRgb(c));
            if (s === 0) return c;
            return h + d < 360 ? svgshift('addhsl', [d, null, null], [c])[0] : svgshift('subhsl', [360 - d, null, null], [c])[0];
        });
    }
    function transform(colors, o) {
        const usesColor = ['tint', 'colorize', 'hue', 'solid'].includes(o.mode);
        if (o.mode === 'tint' || o.mode === 'grayscale') colors = colors.map(gray);
        if (usesColor) {
            const rgb = parseColor(o.color);
            if (o.mode === 'tint') colors = svgshift('addrgb', rgb, colors);
            else if (o.mode === 'solid') colors = svgshift('setrgb', rgb, colors);
            else {
                const h = colorsysHsl(rgb);
                colors = svgshift('sethsl', o.mode === 'colorize' ? [h[0], h[1], null] : [h[0], null, null], colors);
            }
        }
        if (o.hue) colors = rotateHue(colors, o.hue);
        const s = o.saturation, l = o.lightness;
        if (s > 0 || l > 0) colors = svgshift('addhsl', [null, s > 0 ? s : null, l > 0 ? l : null], colors);
        if (s < 0 || l < 0) colors = svgshift('subhsl', [null, s < 0 ? -s : null, l < 0 ? -l : null], colors);
        return colors;
    }
    function colorsysHsl([R, G, B]) {
        const r = R / 255, g = G / 255, b = B / 255, max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
        if (max === min) return [0, 0, Math.round(l * 100)];
        const d = max - min, s = l <= 0.5 ? d / (max + min) : d / (2 - max - min);
        let h = max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
        h = ((h / 6) % 1 + 1) % 1;
        return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
    }
    function recolor(svgText, o, name) {
        if (!/<svg[\s>]/i.test(svgText)) throw new Error("That doesn't look like an SVG: no <svg> element was found.");
        const norm = normalize(svgText);
        const pal = palette(norm);
        const orig = pal.map((p) => p[0]);
        const next = transform(orig, o);
        const map = new Map(orig.map((c, i) => [c, next[i]]));
        const out = norm.replace(HEX_RE, (all, h, off) => {
            if (isRef(norm, off) || (h.length !== 6 && h.length !== 8)) return all;
            h = h.toLowerCase();
            return '#' + (map.get(h.slice(0, 6)) || h.slice(0, 6)) + h.slice(6);
        });
        const usesColor = ['tint', 'colorize', 'hue', 'solid'].includes(o.mode);
        const stem = (name || 'image.svg').replace(/\.svg$/i, '');
        return {
            filename: stem + '_recolored_' + o.mode + (usesColor ? '_' + toHex(...parseColor(o.color)) : '') + '.svg',
            palette: pal.map(([c, n]) => ({ from: '#' + c, to: '#' + map.get(c), count: n })),
            svg: out,
        };
    }
    function mapColors(colors, o) { const next = transform(colors, o); const m = {}; colors.forEach((c, i) => { m[c] = next[i]; }); return m; }
    return { recolor, mapColors };
})();
