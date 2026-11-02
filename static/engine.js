/* SVG Recolor — browser engine.
 *
 * Normalizes an SVG's colors, extracts its palette and applies a color mapping,
 * byte-for-byte like recolor.py (normalize_svg, extract_palette, apply_mapping).
 * The colors themselves are computed on the server (svgray/svgshift).
 * tests/test_parity.py checks that both engines produce identical output.
 */
(function (global) {
    'use strict';
    const NAMED = {"aliceblue":"f0f8ff","antiquewhite":"faebd7","aqua":"00ffff","aquamarine":"7fffd4","azure":"f0ffff","beige":"f5f5dc","bisque":"ffe4c4","black":"000000","blanchedalmond":"ffebcd","blue":"0000ff","blueviolet":"8a2be2","brown":"a52a2a","burlywood":"deb887","cadetblue":"5f9ea0","chartreuse":"7fff00","chocolate":"d2691e","coral":"ff7f50","cornflowerblue":"6495ed","cornsilk":"fff8dc","crimson":"dc143c","cyan":"00ffff","darkblue":"00008b","darkcyan":"008b8b","darkgoldenrod":"b8860b","darkgray":"a9a9a9","darkgreen":"006400","darkgrey":"a9a9a9","darkkhaki":"bdb76b","darkmagenta":"8b008b","darkolivegreen":"556b2f","darkorange":"ff8c00","darkorchid":"9932cc","darkred":"8b0000","darksalmon":"e9967a","darkseagreen":"8fbc8f","darkslateblue":"483d8b","darkslategray":"2f4f4f","darkslategrey":"2f4f4f","darkturquoise":"00ced1","darkviolet":"9400d3","deeppink":"ff1493","deepskyblue":"00bfff","dimgray":"696969","dimgrey":"696969","dodgerblue":"1e90ff","firebrick":"b22222","floralwhite":"fffaf0","forestgreen":"228b22","fuchsia":"ff00ff","gainsboro":"dcdcdc","ghostwhite":"f8f8ff","gold":"ffd700","goldenrod":"daa520","gray":"808080","green":"008000","greenyellow":"adff2f","grey":"808080","honeydew":"f0fff0","hotpink":"ff69b4","indianred":"cd5c5c","indigo":"4b0082","ivory":"fffff0","khaki":"f0e68c","lavender":"e6e6fa","lavenderblush":"fff0f5","lawngreen":"7cfc00","lemonchiffon":"fffacd","lightblue":"add8e6","lightcoral":"f08080","lightcyan":"e0ffff","lightgoldenrodyellow":"fafad2","lightgray":"d3d3d3","lightgreen":"90ee90","lightgrey":"d3d3d3","lightpink":"ffb6c1","lightsalmon":"ffa07a","lightseagreen":"20b2aa","lightskyblue":"87cefa","lightslategray":"778899","lightslategrey":"778899","lightsteelblue":"b0c4de","lightyellow":"ffffe0","lime":"00ff00","limegreen":"32cd32","linen":"faf0e6","magenta":"ff00ff","maroon":"800000","mediumaquamarine":"66cdaa","mediumblue":"0000cd","mediumorchid":"ba55d3","mediumpurple":"9370db","mediumseagreen":"3cb371","mediumslateblue":"7b68ee","mediumspringgreen":"00fa9a","mediumturquoise":"48d1cc","mediumvioletred":"c71585","midnightblue":"191970","mintcream":"f5fffa","mistyrose":"ffe4e1","moccasin":"ffe4b5","navajowhite":"ffdead","navy":"000080","oldlace":"fdf5e6","olive":"808000","olivedrab":"6b8e23","orange":"ffa500","orangered":"ff4500","orchid":"da70d6","palegoldenrod":"eee8aa","palegreen":"98fb98","paleturquoise":"afeeee","palevioletred":"db7093","papayawhip":"ffefd5","peachpuff":"ffdab9","peru":"cd853f","pink":"ffc0cb","plum":"dda0dd","powderblue":"b0e0e6","purple":"800080","rebeccapurple":"663399","red":"ff0000","rosybrown":"bc8f8f","royalblue":"4169e1","saddlebrown":"8b4513","salmon":"fa8072","sandybrown":"f4a460","seagreen":"2e8b57","seashell":"fff5ee","sienna":"a0522d","silver":"c0c0c0","skyblue":"87ceeb","slateblue":"6a5acd","slategray":"708090","slategrey":"708090","snow":"fffafa","springgreen":"00ff7f","steelblue":"4682b4","tan":"d2b48c","teal":"008080","thistle":"d8bfd8","tomato":"ff6347","turquoise":"40e0d0","violet":"ee82ee","wheat":"f5deb3","white":"ffffff","whitesmoke":"f5f5f5","yellow":"ffff00","yellowgreen":"9acd32"};
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

    global.SvgEngine = { normalize, palette, apply, NAMED };
})(typeof window !== 'undefined' ? window : globalThis);
