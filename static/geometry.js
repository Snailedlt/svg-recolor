/* SVG Recolor: geometry for "Cut out" (loaded only when a color is cut out).
 *
 * A cut-out color becomes a gap: its shapes are subtracted from everything they
 * cover, respecting paint order (only the part you can see in the original is
 * cut). The drawing is then flattened to one path per color, so a one-color
 * icon (Solid + cut out) comes out as a single path: what icon sets like devicon
 * want for "plain" versions.
 *
 * Built on paper.js and paperjs-offset (bundled before this file in
 * /assets/geometry.js), the same tools as devicon's svg-icons agent skill.
 *
 * Sizes (`gap`, `line`) are in the SVG's own units (px), or in percent of its larger
 * side with `unit: '%'`.
 *
 * Gaps: with `gap` > 0, every boundary between two different original colors gets a
 * gap of that width, centered on the
 * boundary; each side gives up half. The outer edge stays where it is, and touching
 * shapes of the same color merge. With Solid that keeps the color areas apart.
 *
 * Lines: with `line` > 0 the drawing becomes a line version (like devicon's "line"
 * icons): only a band of that width along the edges is kept, measured inward from the
 * outer edge, and centered on the boundaries between colors (unless `lineInner` is
 * false: then only the outline of the whole shape). Colors in `keep` stay filled.
 *
 *   SvgGeometry.cutOut(svgText, { cut: ['dce0df'], map: { '5e97f6': 'ff0066' }, gap: 2, line: 3, keep: ['ffffff'] }) -> Promise<svgText>
 */
(function (global) {
    'use strict';
    const paper = global.paper;
    const PaperOffset = global.PaperOffset || (global.paperjsOffset && global.paperjsOffset.PaperOffset);
    const MAX_SHAPES = 1500; // boolean operations get slow past this; say so instead of freezing the page
    const PRECISION = 3;

    class GeometryError extends Error {}

    // paper.js misreads compact arc flags ("a1 1 0 0130 4" = flags 0,1 then x 30).
    // Rewrite path data with every number and flag separated by a space.
    function expandArcFlags(d) {
        const re = /([MmZzLlHhVvCcSsQqTtAa])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|[\s,]+/g;
        const out = [];
        let cmd = '';
        let argIndex = 0;
        let i = 0;
        while (i < d.length) {
            if (/[Aa]/.test(cmd) && (argIndex % 7 === 3 || argIndex % 7 === 4)) {
                while (i < d.length && /[\s,]/.test(d[i])) i++;
                if (d[i] === '0' || d[i] === '1') { out.push(d[i]); i++; argIndex++; continue; }
            }
            re.lastIndex = i;
            const m = re.exec(d);
            if (!m || m.index !== i) throw new GeometryError('Could not read a path in this SVG.');
            i = re.lastIndex;
            if (m[1]) { cmd = m[1]; argIndex = 0; out.push(cmd); } else if (m[2]) { out.push(m[2]); argIndex++; }
        }
        return out.join(' ');
    }

    // Parse the SVG, drop anything active, and copy the computed fill/stroke onto
    // every element: paper.js reads attributes, not <style> rules or classes.
    // flat: when everything ends up one color (like Solid), gradients and transparency don't
    // matter: paints become that color and partial transparency counts as solid.
    function prepare(svgText, lenient, flat, mids) {
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const svg = doc.documentElement;
        if (svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new GeometryError('This SVG could not be read.');
        svg.querySelectorAll('script, foreignObject, iframe').forEach((n) => n.remove());
        for (const el of [svg, ...svg.querySelectorAll('*')]) {
            for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
        }
        if (!lenient && svg.querySelector('text')) throw new GeometryError('Cut out, gaps and lines work on shapes, and this SVG has text. Convert the text to paths first (in Inkscape: Path → Object to Path).');
        if (!lenient && svg.querySelector('image')) throw new GeometryError('Cut out, gaps and lines work on shapes, and this SVG has an embedded image.');
        // paper.js doesn't apply masks, so the result would silently show what the mask hides.
        if (!lenient && [svg, ...svg.querySelectorAll('*')].some((el) => el.hasAttribute('mask') || /(^|;)\s*mask\s*:/i.test(el.getAttribute('style') || ''))) {
            throw new GeometryError('Cut out, gaps and lines don\'t support masks yet.');
        }
        // paper.js folds a transform on the root <svg> into the same matrix as the viewBox shift
        // (undone in readShapes). Keep it apart, on a group around the content.
        if (svg.hasAttribute('transform')) {
            const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('transform', svg.getAttribute('transform'));
            svg.removeAttribute('transform');
            while (svg.firstChild) g.appendChild(svg.firstChild);
            svg.appendChild(g);
        }

        // Measure computed styles in an invisible box on the page, inside a closed shadow tree,
        // so the SVG's own <style> rules can't reach the page (and the page's don't reach it).
        const box = document.createElement('div');
        box.style.cssText = 'position:absolute;left:-10000px;top:0;width:0;height:0;overflow:hidden';
        const live = document.importNode(svg, true);
        box.attachShadow({ mode: 'closed' }).appendChild(live);
        document.body.appendChild(box);
        try {
            const props = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'opacity', 'fill-opacity', 'stroke-opacity'];
            const all = [live, ...live.querySelectorAll('*')];
            // One color in the end (flat): each gradient or pattern still stands apart from its
            // neighbors (gaps and lines follow the original's parts), so it gets a color of its own
            // here, one the SVG doesn't use. compute() paints everything the one color at the end.
            const stand = new Map();
            let standIn = null;
            // mids (for the most prominent color): a gradient counts as the color at its middle.
            const hex = (v) => { const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v); return m ? m.slice(1).map((n) => (+n).toString(16).padStart(2, '0')).join('') : null; };
            const middleOf = (v) => {
                const m = /url\(\s*["']?#([^"')]+)/.exec(v);
                let el = m ? live.querySelector('[id="' + m[1].replace(/"/g, '') + '"]') : null;
                for (let hops = 0; el && !el.querySelector('stop') && hops < 8; hops++) {
                    const ref = /#(.+)$/.exec(el.getAttribute('href') || el.getAttribute('xlink:href') || '');
                    el = ref ? live.querySelector('[id="' + ref[1].replace(/"/g, '') + '"]') : null;
                }
                const stops = el ? [...el.querySelectorAll('stop')].map((s) => {
                    const o = String(s.getAttribute('offset') || '0').trim();
                    return { at: Math.min(1, Math.max(0, o.endsWith('%') ? parseFloat(o) / 100 : parseFloat(o) || 0)), hex: hex(getComputedStyle(s).stopColor) };
                }).filter((s) => s.hex) : [];
                if (!stops.length) return 'none';
                for (let i = 1; i < stops.length; i++) stops[i].at = Math.max(stops[i].at, stops[i - 1].at);
                const i = stops.findIndex((s) => s.at >= 0.5);
                if (i <= 0) return '#' + stops[i === 0 ? 0 : stops.length - 1].hex;
                const a = stops[i - 1], b = stops[i];
                const f = b.at === a.at ? 0 : (0.5 - a.at) / (b.at - a.at);
                return '#' + [0, 2, 4].map((k) => { const x = parseInt(a.hex.slice(k, k + 2), 16), y = parseInt(b.hex.slice(k, k + 2), 16); return Math.round(x + (y - x) * f).toString(16).padStart(2, '0'); }).join('');
            };
            if (flat) {
                const used = new Set();
                for (const el of all) {
                    const cs = getComputedStyle(el);
                    for (const v of [cs.fill, cs.stroke]) { const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v); if (m) used.add(m.slice(1).map((n) => (+n).toString(16).padStart(2, '0')).join('')); }
                }
                let next = 0x0a0b0c;
                // Its middle color, nudged until unused (so it looks like what it is: outlines are
                // told by how dark they are); else any unused color.
                standIn = (v) => {
                    if (!stand.has(v)) {
                        const mid = middleOf(v);
                        let c = mid !== 'none' ? mid.slice(1) : null;
                        for (let k = 0; c && used.has(c) && k < 256; k++) c = c.slice(0, 4) + ((parseInt(c.slice(4), 16) + 1) % 256).toString(16).padStart(2, '0');
                        if (!c || used.has(c)) do { c = (next = (next + 0x050301) % 0x1000000).toString(16).padStart(6, '0'); } while (used.has(c));
                        used.add(c);
                        stand.set(v, '#' + c);
                    }
                    return stand.get(v);
                };
            }
            for (const el of all) {
                // Gradient and pattern definitions keep their own styles: their stops' colours are
                // read later (a gradient's middle colour), and stop-color is often in a style attribute.
                if (el.closest('linearGradient, radialGradient, pattern')) continue;
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || (cs.visibility !== 'visible' && el.matches('path, rect, circle, ellipse, line, polyline, polygon'))) {
                    el.setAttribute('display', 'none');
                    continue;
                }
                if (!lenient && !flat && !mids && el.matches('path, rect, circle, ellipse, line, polyline, polygon') && /url\(/.test(cs.fill + cs.stroke)) {
                    throw new GeometryError('Cut out, gaps and lines work with flat colors, and this SVG uses gradients or patterns.');
                }
                for (const p of props) {
                    let v = p === 'stroke-width' ? String(parseFloat(cs.strokeWidth) || 0) : cs.getPropertyValue(p);
                    if (mids && (p === 'fill' || p === 'stroke') && /url\(/.test(v)) v = middleOf(v);
                    // Measuring (Fit): only the shapes count, so a paint server's colour doesn't matter.
                    if (lenient && !flat && !mids && (p === 'fill' || p === 'stroke') && /url\(/.test(v)) v = '#000000';
                    if (flat && (p === 'fill' || p === 'stroke') && /url\(/.test(v)) v = standIn(v.replace(/\s+/g, ''));
                    // One color: mostly see-through (shadows, glows) goes, the rest counts as solid.
                    if ((flat || mids) && /opacity$/.test(p)) v = parseFloat(v) < 0.5 ? '0' : '1';
                    el.setAttribute(p, v);
                }
                el.removeAttribute('style');
                el.removeAttribute('class');
            }
            live.querySelectorAll('style').forEach((n) => n.remove());
            // Every gradient or pattern paint is a colour by now (or the SVG was refused above).
            // Their definitions go: paper.js fails on gradients that take their stops from another
            // gradient through href (CachyOS), and nothing uses them anymore.
            if (![...live.querySelectorAll('*')].some((el) => /url\(/.test((el.getAttribute('fill') || '') + (el.getAttribute('stroke') || '')))) {
                live.querySelectorAll('linearGradient, radialGradient, pattern').forEach((n) => n.remove());
            }
            live.querySelectorAll('path[d]').forEach((p) => p.setAttribute('d', expandArcFlags(p.getAttribute('d'))));
            // A rect with only rx (or ry) has round corners per the spec; paper reads the missing one as 0.
            live.querySelectorAll('rect').forEach((r) => {
                const rx = r.getAttribute('rx'), ry = r.getAttribute('ry');
                if (rx && !ry) r.setAttribute('ry', rx);
                if (ry && !rx) r.setAttribute('rx', ry);
            });
            live._standIns = [...stand.values()].map((c) => c.slice(1).toLowerCase());
            return live;
        } finally {
            box.remove();
        }
    }

    const hex6 = (color) => color.toCSS(true).slice(1).toLowerCase();

    // Visible shapes in paint order as global paths with a color (fill, then stroke).
    function leaves(scope, root) {
        const isPath = (it) => it instanceof scope.Path || it instanceof scope.CompoundPath;
        const out = [];
        const walk = (item, clip) => {
            if (!item.visible || item.opacity === 0) return;
            if (item.className === 'Group' || item.className === 'Layer') {
                if (item.opacity < 1) throw new GeometryError('Cut out, gaps and lines don\'t support semi-transparent groups yet.');
                let mask = clip;
                const kids = item.children.slice();
                if (item.clipped && kids.length && isPath(kids[0])) {
                    const m = kids[0].clone({ insert: false });
                    m.transform(kids[0].parent.globalMatrix);
                    mask = clip ? clip.intersect(m, { insert: false }) : m;
                    kids.shift();
                }
                kids.forEach((k) => walk(k, mask));
                return;
            }
            if (item.className === 'SymbolItem') throw new GeometryError('Cut out, gaps and lines don\'t support <use> elements yet. Expand them first (in Inkscape: Edit → Clone → Unlink Clone).');
            if (!isPath(item) || item.clipMask) return;
            const base = item.clone({ insert: false });
            base.transform(item.parent.globalMatrix);
            const add = (p, color) => {
                if (color.gradient) throw new GeometryError('Cut out, gaps and lines work with flat colors, and this SVG uses gradients.');
                if (color.alpha < 1 || item.opacity < 1) throw new GeometryError('Cut out, gaps and lines don\'t support semi-transparent colors yet.');
                p.fillColor = null; p.strokeColor = null;
                if (clip) p = p.intersect(clip, { insert: false });
                if (!p.isEmpty() && p.bounds.width > 0 && p.bounds.height > 0) out.push({ path: p, color: hex6(color) });
            };
            if (item.fillColor && item.fillColor.alpha !== 0) add(base.clone({ insert: false }), item.fillColor);
            if (item.strokeColor && item.strokeWidth > 0 && item.strokeColor.alpha !== 0) {
                if (!PaperOffset) throw new GeometryError('Strokes need the offset library, which did not load.');
                // The stroke width is in the shape's own coordinates: outline it there, then
                // transform the outline, so a non-uniform scale stretches the stroke like it should.
                const local = item.clone({ insert: false });
                local.matrix = new scope.Matrix();
                const outline = PaperOffset.offsetStroke(local, item.strokeWidth / 2, { cap: item.strokeCap || 'butt', join: item.strokeJoin || 'miter', insert: false });
                outline.transform(item.globalMatrix);
                add(outline, item.strokeColor);
            }
            if (out.length > MAX_SHAPES) throw new GeometryError('This SVG has too many shapes for cut out, gaps and lines (over ' + MAX_SHAPES + ').');
        };
        walk(root, null);
        return out;
    }

    // Reading the SVG needs the page (DOM, computed styles); the heavy part (boolean
    // operations and offsets) runs in a worker when it can, so the page never freezes,
    // and a newer request stops an older one right away.
    function readShapes(svgText, flat, mids) {
        const live = prepare(svgText, false, flat, mids);
        const scope = new paper.PaperScope();
        scope.setup(document.createElement('canvas'));
        try {
            const viewBox = live.getAttribute('viewBox');
            const width = live.getAttribute('width');
            const height = live.getAttribute('height');
            // Work in viewBox units: without width/height paper keeps user coordinates.
            if (viewBox) { live.removeAttribute('width'); live.removeAttribute('height'); }
            const root = scope.project.importSVG(live, { expandShapes: true, insert: true, applyMatrix: false });
            // Bake each shape's own transform into its points before turning it into path data.
            // paper moves the drawing so the viewBox starts at 0,0; move it back, so the
            // shapes stay in the original coordinates (the output keeps the original viewBox).
            const undo = root.matrix.inverted();
            const shapes = leaves(scope, root).map(({ path, color }) => {
                path.transform(undo);
                // Bake the whole transform into a fresh copy (path data leaves an item's own matrix
                // out, and applyMatrix doesn't bake it into a compound path's children).
                const baked = new scope.CompoundPath({ pathData: path.pathData, fillRule: path.fillRule, insert: false });
                baked.transform(path.matrix);
                // Drop empty subpaths ("m0 0"): they upset the boolean steps, and the server's
                // reader (picosvg) drops them too, so both sides start from the same shapes.
                baked.children.slice().forEach((k) => { if (k.segments.length < 2 || k.length < 1e-9) k.remove(); });
                return { d: baked.getPathData(null, 12), rule: path.fillRule || 'nonzero', color };
            }).filter((sh) => sh.d);
            const b = root.bounds;
            // Which colors stand in for gradients (Simplify never merges them: each gradient part stays one).
            // Which colors stand in for gradients (Simplify never merges them: each gradient part stays one).
            return { shapes, viewBox, width, height, bounds: [b.width, b.height], standIns: live._standIns || [] };
        } finally {
            scope.project.remove();
        }
    }

    const tick = () => new Promise((r) => setTimeout(r));

    // A band of `half` on both sides of an outline, built from simple pieces: a rectangle along
    // each straight segment of a flattened copy and a circle at each corner, merged in pairs.
    // Slower than paperjs-offset but always well formed: the fallback when that one fails.
    function sausage(path, half, scope) {
        const flat = path.clone({ insert: false });
        flat.flatten(Math.max(half / 2, 0.05));
        const pts = flat.segments.map((sg) => sg.point);
        if (flat.closed && pts.length) pts.push(pts[0]);
        let parts = [];
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i], b = pts[i + 1];
            const v = b.subtract(a);
            if (v.length < 1e-9) continue;
            const n = v.normalize(half).rotate(90);
            parts.push(new scope.Path({ segments: [a.add(n), b.add(n), b.subtract(n), a.subtract(n)], closed: true, insert: false }));
            parts.push(new scope.Path.Circle({ center: a, radius: half, insert: false }));
        }
        if (!parts.length) return null;
        while (parts.length > 1) {
            const next = [];
            for (let i = 0; i < parts.length; i += 2) next.push(i + 1 < parts.length ? parts[i].unite(parts[i + 1], { insert: false }) : parts[i]);
            parts = next;
        }
        return parts[0];
    }

    // Outer outlines clockwise, holes counter-clockwise, by how deep each outline is nested
    // (even: an outer edge, odd: a hole). paper.js's reorient() does the same in principle,
    // but sometimes turns holes into filled shapes in some browsers.
    function orient(p) {
        // A region's outline never has the same contour twice, but boolean results sometimes do
        // (in some JS engines): keep one of each, or the nesting count below goes wrong.
        if (p.children) {
            const seen = new Set();
            for (const k of p.children.slice()) {
                const b = k.bounds;
                const key = [b.x, b.y, b.width, b.height, Math.abs(k.area)].map((v) => v.toFixed(3)).join(',');
                if (seen.has(key)) k.remove(); else seen.add(key);
            }
        }
        const kids = p.children ? p.children.slice() : [p];
        if (kids.length < 2) { if (kids[0] && !kids[0].clockwise) kids[0].reverse(); return; }
        const info = kids.map((k) => ({ k, size: Math.abs(k.area), pt: k.interiorPoint }));
        for (const a of info) {
            let depth = 0;
            for (const b of info) if (b !== a && b.size > a.size && b.k.contains(a.pt)) depth++;
            if (a.k.clockwise !== (depth % 2 === 0)) a.k.reverse();
        }
    }

    // A zero-width spike: an outline that runs along a curve and straight back (boolean steps leave
    // these where two shapes share an edge, like the two blues of Vuetify merged in a one-colour
    // version). It encloses nothing but confuses widths and outlines (a line version filled the
    // shape in). Fold each one away: drop the tip and the point it returns to.
    function despike(item) {
        for (const k of (item.children ? item.children : [item])) {
            for (let guard = 0; guard < 500 && k.segments && k.segments.length > 3; guard++) {
                const cs = k.curves;
                let hit = -1;
                for (let i = 0; i < cs.length; i++) {
                    const a = cs[i], b = cs[(i + 1) % cs.length];
                    const tol = 1e-3 * Math.max(1, a.length);
                    if (a.point1.getDistance(b.point2) < tol && Math.abs(a.length - b.length) < tol
                        && a.getPointAtTime(0.5).getDistance(b.getPointAtTime(0.5)) < tol) { hit = i; break; }
                }
                if (hit < 0) break;
                const n = k.segments.length;
                const start = k.segments[hit], tip = (hit + 1) % n, back = (hit + 2) % n;
                start.handleOut = k.segments[back].handleOut.clone(); // the curve after the spike starts here
                for (const j of [tip, back].sort((x, y) => y - x)) k.segments[j].remove();
            }
        }
        return item;
    }

    async function compute(input, opts, progress) {
        const report = progress || (() => {});
        const { shapes: raw, viewBox, width, height, bounds } = input;
        const cut = new Set(opts.cut || []);
        const map = opts.map || {};
        // Everything ends up this one color (flat): the colors only tell the parts apart.
        const flat = opts.flat ? String(opts.flat).toLowerCase() : null;
        const outOf = (c) => flat || (map[c] || c).toLowerCase();
        const scope = new paper.PaperScope();
        scope.setup(new paper.Size(1, 1));
        try {
            const shapes = raw.map(({ d, rule, color }) => {
                const path = new scope.CompoundPath({ pathData: d, fillRule: rule, insert: false });
                // A fill closes every outline, `z` or not; lines and gaps need them closed too, or the
                // missing last edge gets no band (Android's arm, head and eyes).
                path.children.forEach((k) => { k.closed = true; });
                despike(path);
                return { path, color };
            });

            // Top to bottom: what each shape shows is what's not covered by the shapes above it.
            // A cut-out shape shows nothing but still covers (so it leaves a gap below it).
            const regions = new Map(); // original color -> [visible paths]
            let covered = null;
            for (let i = shapes.length - 1; i >= 0; i--) {
                const { path, color } = shapes[i];
                if (!cut.has(color)) {
                    const visible = covered ? path.subtract(covered, { insert: false }) : path.clone({ insert: false });
                    if (!visible.isEmpty()) {
                        if (!regions.has(color)) regions.set(color, []);
                        regions.get(color).push(visible);
                    }
                }
                covered = covered ? covered.unite(path, { insert: false }) : path.clone({ insert: false });
                if (i % 25 === 0) { report((shapes.length - i) / shapes.length * (opts.gap > 0 || opts.line > 0 ? 0.15 : 1)); await tick(); } // also keeps the page responsive without a worker
            }

            // Union, without the zero-width spikes a union leaves where shapes share an edge (the next
            // boolean step on such an outline can fail and return the region filled in).
            const unite = (list) => { const u = list.reduce((a, p) => (a ? a.unite(p, { insert: false }) : p), null); return u && list.length > 1 ? despike(u) : u; };
            // paper.js's boolean steps fail now and then on awkward outlines (Vuetify's blues): a union
            // that lost area, an intersection bigger than either side. Check by area, retry with the
            // sides swapped, and else take the safe side.
            const area = (q) => (q ? Math.abs(q.area) : 0);
            const safeUnite = (a, b) => {
                const most = Math.max(area(a), area(b)), tol = 0.01 * most + 1e-6;
                for (const r of [() => a.unite(b, { insert: false }), () => b.unite(a, { insert: false })]) {
                    const u = r();
                    if (area(u) >= most - tol && area(u) <= area(a) + area(b) + tol) return u;
                }
                return area(a) >= area(b) ? a : b;
            };
            const safeIntersect = (a, b) => {
                const least = Math.min(area(a), area(b)), tol = 0.01 * least + 1e-6;
                for (const r of [() => a.intersect(b, { insert: false }), () => b.intersect(a, { insert: false })]) {
                    const x = r();
                    if (area(x) <= least + tol) return x;
                }
                return null;
            };
            // One region per original color, in the order the colors first appear (bottom first).
            const order = [...regions.keys()].reverse();
            // Hairline slivers (outlines on average under 0.02 units wide) are rounding left
            // over where colors meet. Invisible, but lines and gaps would outline them.
            const clean = (p) => {
                if (p) despike(p);
                if (p && p.children) p.children.slice().forEach((k) => { if (k.length > 0 && (2 * Math.abs(k.area)) / k.length < 0.02) k.remove(); });
                return p;
            };
            let byColor = order.map((c) => [c, clean(unite(regions.get(c)))]).filter(([, p]) => p && !p.isEmpty());

            const vb = (viewBox || '').trim().split(/[\s,]+/).map(Number);
            const size = vb.length === 4 && vb.every(Number.isFinite) ? Math.max(vb[2], vb[3]) : Math.max(bounds[0], bounds[1]);
            // Sizes are in the SVG's own units (px), or with unit '%' in percent of its larger side.
            const scale = opts.unit === '%' ? size / 100 : 1;

            // "Light colors become holes" (opts.holes: the light colors): a light color is a hole
            // where it's drawn against other colors (the "5" on HTML5's shield, Docker's eye, a white
            // background) and stays a part of the logo where it stands on its own (CMake's gray
            // triangle). A hole loses its visible part, as a cut-out does (it still covers what's below).
            const soft = new Set((opts.holes || []).map((c) => String(c).toLowerCase()));
            // A light gradient (Azure SQL's letters, a pale highlight) is a light color too: with
            // light colors as holes (opts.lightHoles), its stand-in joins them.
            if (opts.lightHoles) {
                const isLight = (c) => ((x) => Math.min(...x) >= 0xe0 || (Math.min(...x) >= 0xc8 && Math.max(...x) - Math.min(...x) <= 48))([0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)));
                for (const c of input.standIns || []) if (/^[0-9a-f]{6}$/.test(c) && isLight(c) && !(opts.keep || []).includes(c)) soft.add(c);
            }
            const holed = [];
            const asLines = []; // outline colors that are a line version's lines as they are
            const splitOutlines = new Map(); // outline color -> its width: gaps inside, ink on the edge
            const eps = 0.004 * size;
            // Does p border q (within eps)? Sampled along p's outlines.
            const touch = (p, q) => {
                if (!q.bounds.expand(eps * 2).intersects(p.bounds)) return false;
                for (const k of (p.children ? p.children : [p])) {
                    const len = k.length;
                    const count = Math.max(24, Math.min(200, Math.round(len / eps)));
                    for (let i = 0; i < count && len > 0; i++) {
                        const at = (len * (i + 0.5)) / count;
                        const pt = k.getPointAt(at), n = k.getNormalAt(at);
                        if (pt && n && (q.contains(pt.add(n.multiply(eps))) || q.contains(pt.subtract(n.multiply(eps))))) return true;
                    }
                }
                return false;
            };
            // Simplify (opts.merge, an RGB distance): shades of one colour (shading, highlights,
            // the facets of a gradient-like logo) count as one part, so they get no gaps or lines
            // of their own. Each colour joins the largest part whose colour is within the distance.
            const mergeD = Number(opts.merge) || 0;
            if (mergeD > 0 && byColor.length > 1) {
                const rgbOf = (c) => [0, 2, 4].map((i) => parseInt(String(c).slice(i, i + 2), 16));
                // Near-identical colors only (a small distance, under 20): the parts of gradients stay
                // apart (Node's facets). A larger distance simplifies shading, gradients included.
                const standIns = new Set(mergeD < 20 ? input.standIns || [] : []);
                const fixed = (c) => soft.has(c) || standIns.has(c) || (opts.cut || []).includes(c) || (opts.keep || []).includes(c);
                const groups = []; // [colour, [regions], rgb]
                for (const [c, p] of [...byColor].sort((a, b) => Math.abs(b[1].area) - Math.abs(a[1].area))) {
                    const x = rgbOf(c);
                    const g = fixed(c) ? null : groups.find(([d, , y]) => !fixed(d) && Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) <= mergeD);
                    if (g) g[1].push(p); else groups.push([c, [p], x]);
                }
                if (groups.length < byColor.length) {
                    const was = byColor.map(([c]) => c);
                    byColor = groups.map(([c, list]) => [c, list.length > 1 ? clean(unite(list)) : list[0]])
                        .filter(([, q]) => q && !q.isEmpty())
                        .sort((a, b) => was.indexOf(a[0]) - was.indexOf(b[0]));
                }
            }
            // Simplify (opts.detail, a size): a piece or a hole smaller than detail in every direction
            // goes (a piece drops, a hole fills in), so small specks get no gaps or lines of their own.
            // A thin line is long, so it stays (HAProxy's connectors).
            const detail = (Number(opts.detail) || 0) * scale;
            if (detail > 0) {
                const least = detail * detail;
                byColor = byColor.map(([c, q]) => {
                    const speck = (k) => Math.max(k.bounds.width, k.bounds.height) < detail && Math.abs(k.area) < least;
                    if (q.children) q.children.slice().forEach((k) => { if (speck(k)) k.remove(); });
                    else if (speck(q)) return [c, null];
                    return [c, q];
                }).filter(([, q]) => q && !q.isEmpty() && Math.abs(q.area) > 0);
            }
            if (soft.size) {
                const others = byColor.filter(([c]) => !soft.has(c));
                byColor = byColor.filter(([c, p]) => {
                    if (!soft.has(c) || !others.some(([, q]) => touch(p, q))) return true;
                    holed.push(c);
                    return false;
                });
            }
            // opts.outlines: an outline color (its visible part thin, at most 2% of the icon wide on
            // average, running between parts of other colors at least twice as wide) becomes a gap,
            // so a one-color version keeps the parts it outlined apart (Docker's dark outline).
            if (opts.outlines && byColor.length > 2) {
                const width = (p) => { const kids = p.children ? p.children : [p]; const len = kids.reduce((t, k) => t + k.length, 0); return len > 0 ? (2 * Math.abs(p.area)) / len : 0; };
                const widths = new Map(byColor.map(([c, p]) => [c, width(p)]));
                const keepColors = new Set(opts.keep || []);
                // Of p's outline, the share that runs against (within eps of) one of `parts`; and
                // how many of them it meets.
                const against = (p, parts) => {
                    let near = 0, all = 0, out = 0;
                    const met = new Set();
                    for (const k of (p.children ? p.children : [p])) {
                        const len = k.length;
                        const count = Math.max(8, Math.min(120, Math.round(len / (4 * eps))));
                        for (let i = 0; i < count && len > 0; i++) {
                            const at = (len * (i + 0.5)) / count;
                            const pt = k.getPointAt(at), n = k.getNormalAt(at);
                            if (!pt || !n) continue;
                            all++;
                            const sides = [pt.add(n.multiply(eps)), pt.subtract(n.multiply(eps))];
                            const hit = sides.map((q) => parts.findIndex(([, r]) => r.bounds.contains(q) && r.contains(q))).find((j) => j >= 0);
                            if (hit !== undefined) { near++; met.add(hit); } else if (sides.some((q) => !p.contains(q))) out++; // the outside
                        }
                    }
                    return { share: all ? near / all : 0, met: met.size, outside: all ? out / all : 0, metColors: [...met].map((j) => parts[j][0]) };
                };
                // An outline runs against other colors for much of its length (line art, whose thin
                // lines are the drawing, doesn't), between at least two parts, some much thicker, and
                // mostly inside the drawing: a thin band along its edge (an octopus's tentacle
                // undersides) is part of the silhouette, and cutting it would change the shape.
                const outline = byColor.filter(([c]) => !keepColors.has(c) && !(opts.cut || []).includes(c) && widths.get(c) <= 0.02 * size).map(([c, p]) => {
                    const near = byColor.filter(([d, q]) => d !== c && q.bounds.expand(eps * 2).intersects(p.bounds));
                    if (near.length < 2 || !near.some(([d]) => widths.get(d) >= 2 * widths.get(c))) return null;
                    const { share, met, outside, metColors } = against(p, near);
                    // ...and darker than the parts it runs between (lighter thin parts, like an
                    // octopus's pink tentacle undersides, are parts of the drawing, not outlines).
                    const lum = (h) => { const x = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); return (Math.max(...x) + Math.min(...x)) / 2; }; // HSL lightness
                    const around = metColors.map((d) => lum(d));
                    const darker = around.length && lum(c) < around.reduce((t, v) => t + v, 0) / around.length - 20;
                    return share >= 0.4 && met >= 2 && outside <= 0.45 && darker ? c : null;
                }).filter(Boolean);
                if (outline.length && outline.length < byColor.length) {
                    if (Number(opts.line) > 0 && !opts.linePlain) asLines.push(...outline); // a line version: they are the lines
                    else { outline.forEach((c) => splitOutlines.set(c, widths.get(c))); holed.push(...outline); }
                }
            }

            // A part thinner than half the gap or line (on average) can't show as a part of its own:
            // usually a sliver where two shapes of the original almost line up. Left alone, its gap or
            // lines would bite into its neighbors (a notch in Node's outer edge). It joins the
            // neighbor it borders most instead.
            // With gaps, a part thinner than the gap itself would be cut away from both sides
            // (SQL Server's connecting bars, the ring around GCC's egg) and the drawing would lose
            // it: it joins its neighbour too, so the silhouette keeps it.
            const thin = Math.max(Number(opts.gap) || 0, (Number(opts.line) || 0) / 2) * scale;
            if (thin > 0 && byColor.length > 1) {
                for (const entry of byColor) {
                    const p = entry[1];
                    for (const k of (p.children ? p.children.slice() : [p])) {
                        const len = k.length;
                        if (!(len > 0) || (2 * Math.abs(k.area)) / len >= thin) continue;
                        const piece = new scope.Path({ segments: k.segments, closed: true, insert: false });
                        if (Math.abs(piece.area) < 1e-9) continue;
                        // Filled (not a hole): taking it away makes the region smaller by about its area.
                        const cur = entry[1];
                        const rest = cur.subtract(piece, { insert: false });
                        if (Math.abs(cur.area) - Math.abs(rest.area) < 0.5 * Math.abs(piece.area)) continue;
                        // Which neighbor: the one just outside most of its outline.
                        const votes = new Map();
                        const eps = Math.min(thin, 0.05 * size);
                        for (let i = 0; i < 24; i++) {
                            const at = (len * (i + 0.5)) / 24;
                            const pt = piece.getPointAt(at), n = piece.getNormalAt(at);
                            if (!pt || !n) continue;
                            for (const q of [pt.add(n.multiply(eps)), pt.subtract(n.multiply(eps))]) {
                                for (const other of byColor) if (other !== entry && other[1].contains(q)) votes.set(other, (votes.get(other) || 0) + 1);
                            }
                        }
                        if (!votes.size) continue; // on its own: keep it
                        const to = [...votes].sort((x, y) => y[1] - x[1])[0][0];
                        to[1] = to[1].unite(piece, { insert: false });
                        entry[1] = rest;
                    }
                }
                byColor = byColor.filter(([, p]) => p && !p.isEmpty());
                // Thin arms too: a strip of a color narrower than half the gap, still attached to the
                // rest of it (a hairline of the background shape showing along the edge of a part drawn
                // over it, as in Bitbucket). The gaps would split it off as a stray line; it joins the
                // color beside it instead.
                const gapW = (Number(opts.gap) || 0) * scale;
                if (gapW > 0 && PaperOffset) {
                    const r = gapW / 4;
                    for (const entry of byColor) {
                        const p = entry[1];
                        let opened = null;
                        try {
                            const shrunk = PaperOffset.offset(p, -r, { join: 'round', insert: false });
                            opened = shrunk && !shrunk.isEmpty() ? PaperOffset.offset(shrunk, r + Math.max(0.01, r / 50), { join: 'round', insert: false }) : null;
                        } catch (err) { opened = null; }
                        if (!opened || opened.isEmpty()) continue;
                        // Grown a hair past p's own outline, so the two never share an edge exactly
                        // (paper.js loses parts of a subtraction along shared edges).
                        const arms = p.subtract(opened, { insert: false });
                        for (const k of (arms.children ? arms.children.slice() : [arms])) {
                            const piece = new scope.Path({ segments: k.segments, closed: true, insert: false });
                            const area = Math.abs(piece.area);
                            if (!(area > 16 * r * r) || !(piece.length > 0) || (2 * area) / piece.length > 2 * r) continue;
                            const votes = new Map();
                            const len = piece.length, e2 = Math.min(2 * r, 0.05 * size);
                            for (let t = 0; t < 32; t++) {
                                const at = (len * (t + 0.5)) / 32, pt = piece.getPointAt(at), n = piece.getNormalAt(at);
                                if (!pt || !n) continue;
                                for (const q of [pt.add(n.multiply(e2)), pt.subtract(n.multiply(e2))]) {
                                    for (const other of byColor) if (other !== entry && other[1].contains(q)) votes.set(other, (votes.get(other) || 0) + 1);
                                }
                            }
                            if (!votes.size) continue;
                            const to = [...votes].sort((x, y) => y[1] - x[1])[0][0];
                            const grown = safeUnite(to[1], piece);
                            const rest = safeIntersect(entry[1], entry[1].subtract(piece, { insert: false })) || entry[1].subtract(piece, { insert: false });
                            if (grown && rest) { to[1] = grown; entry[1] = rest; }
                        }
                    }
                    byColor = byColor.filter(([, p]) => p && !p.isEmpty());
                }
            }
            // A band of `half` on both sides of every outline of `p`. An outline narrower than the
            // band is covered whole (its inward offset would turn inside out): filled, then grown.
            // forLines: the band is a line of a line version (a part narrower than it stays filled
            // only when its hole couldn't show); otherwise (gaps, outline gaps) the older, plainer rule.
            const stroke = (p, half, forLines = false) => {
                let acc = null;
                for (const c of (p.children ? p.children : [p])) {
                    const path = c.clone({ insert: false });
                    const b = path.bounds;
                    if (!(b.width > 0 || b.height > 0)) continue;
                    // A sliver (on average under 0.02 units wide) has no inside to outline; growing it
                    // can produce garbage.
                    if ((2 * Math.abs(path.area)) / Math.max(path.length, 1e-9) < 0.02) continue;
                    // paperjs-offset can fail on slivers left by the boolean steps: retry on a finely
                    // flattened copy (within 0.02 units), else leave this one outline without a band.
                    // A band is about perimeter x width; much more means the offset filled the shape
                    // in instead (paperjs-offset does that now and then): treat that as a failure too.
                    // Check a band where it matters: just beside the outline (both sides) it must cover,
                    // well past its reach it must not. paperjs-offset sometimes returns a shape filled in
                    // or with pieces missing; those fail here and get built the slow, reliable way.
                    const len = path.length;
                    const samples = [];
                    const count = Math.max(12, Math.min(120, Math.round(len / (4 * half))));
                    for (let i = 0; i < count && len > 0; i++) {
                        const at = (len * (i + 0.5)) / count;
                        const pt = path.getPointAt(at), n = path.getNormalAt(at);
                        if (!pt || !n) continue;
                        samples.push({ pt: pt.add(n.multiply(half * 0.5)), in: true }, { pt: pt.subtract(n.multiply(half * 0.5)), in: true });
                        for (const far of [pt.add(n.multiply(half * 2.5)), pt.subtract(n.multiply(half * 2.5))]) {
                            if (path.getNearestPoint(far).getDistance(far) > half * 1.5) samples.push({ pt: far, in: false });
                        }
                    }
                    const sane = (r) => {
                        if (!r || Math.abs(r.area) > 1.35 * len * 2 * half + 4 * Math.PI * half * half) return false;
                        let misses = 0;
                        for (const sm of samples) if (r.contains(sm.pt) !== sm.in && ++misses > 1) return false;
                        return true;
                    };
                    const band = () => {
                        const opts = { join: 'round', cap: 'butt', insert: false };
                        try { const r = PaperOffset.offsetStroke(path, half, opts); if (sane(r)) return r; } catch (err) { /* retry below */ }
                        try {
                            const flat = path.clone({ insert: false });
                            flat.flatten(0.02);
                            const r = PaperOffset.offsetStroke(flat, half, opts);
                            if (sane(r)) return r;
                        } catch (err) { /* build it from simple pieces below */ }
                        return sausage(path, half, scope);
                    };
                    let part;
                    // Narrower than the band: already a line (a thin stripe, an antenna, a sliver).
                    // Outlining it would leave ticks, or a hole too small to see; it stays as it is.
                    // Its thickness as a strip's (area = length x thickness), so a small square
                    // (HAProxy's boxes) is measured by its side, and gets an outline while its hole
                    // can still show (over 3/4 of a band).
                    const pa = Math.abs(path.area), pd = len * len - 16 * pa;
                    const thickness = pd > 0 ? (len - Math.sqrt(pd)) / 4 : len / 4;
                    if (forLines ? thickness < 2.2 * half : (2 * pa) / Math.max(len, 1e-9) < 2 * half) {
                        if (path.area < 0) path.reverse();
                        let keep = path;
                        // Thin on average, but maybe not everywhere: a box with long thin connectors
                        // (HAProxy) measures as thin. Its thick parts (those that survive shrinking
                        // by 1.375 bands) still get their line inside: what's left of them shrunk by
                        // one band more is cut out; the thin bits stay filled.
                        if (forLines && PaperOffset) {
                            try {
                                const r = 1.375 * half;
                                const sh = PaperOffset.offset(path, -r, { join: 'round', insert: false });
                                if (sh && !sh.isEmpty() && Math.abs(sh.area) > 0) {
                                    const core = PaperOffset.offset(sh, r - half, { join: 'round', insert: false });
                                    if (core && !core.isEmpty() && Math.abs(core.area) < Math.abs(path.area)) {
                                        const cut = path.subtract(core, { insert: false });
                                        if (cut && !cut.isEmpty() && Math.abs(cut.area) >= Math.abs(path.area) - Math.abs(core.area) - 1e-6 && Math.abs(cut.area) < Math.abs(path.area)) keep = cut;
                                    }
                                }
                            } catch (err) { keep = path; }
                        }
                        acc = acc ? acc.unite(keep, { insert: false }) : keep;
                        continue;
                    }
                    if (Math.min(b.width, b.height) > 2 * half) {
                        part = band();
                        if (!part) continue;
                    } else {
                        // paperjs-offset can fail on tiny or odd outlines: fall back step by step.
                        if (path.area < 0) path.reverse();
                        try {
                            part = PaperOffset.offset(path, half, { join: 'round', insert: false });
                        } catch (err) {
                            const b2 = band();
                            part = b2 ? path.unite(b2, { insert: false }) : path;
                        }
                    }
                    acc = acc ? acc.unite(part, { insert: false }) : part;
                }
                return acc || new scope.Path({ insert: false });
            };

            // Outline colors (opts.outlines), by the rule devicon's maintainers use for outlined
            // logos: where an outline has fill on both sides it becomes a gap; along the edge of
            // the drawing (fill on one side, nothing on the other) it stays ink, so the silhouette
            // keeps its shape (Docker's outer ring).
            if (splitOutlines.size) {
                const all = clean(unite(byColor.map(([, p]) => p.clone({ insert: false }))));
                byColor = byColor.map(([c, p]) => {
                    if (!splitOutlines.has(c)) return [c, p];
                    const edge = all.intersect(stroke(all, 1.5 * splitOutlines.get(c)), { insert: false });
                    return [c, clean(p.intersect(edge, { insert: false }))];
                }).filter(([, p]) => p && !p.isEmpty());
            }

            // Lines, from the regions before gaps: a band inside the outer edge, plus (with
            // lineInner) a band centered on every boundary between two colors.
            const line = Number(opts.line) || 0;
            const centered = opts.lineAlign === 'center';
            let lines = null;
            if (line > 0 && byColor.length && !opts.linePlain) {
                if (!PaperOffset) throw new GeometryError('Lines need the offset library, which did not load.');
                const w = line * scale;
                const whole = clean(unite(byColor.map(([, p]) => p.clone({ insert: false }))));
                // opts.lineAlign 'center': the line straddles the edge, half outside, as a stroke drawn
                // on the outline and turned into a shape (Inkscape's Stroke to Path, the way devicon's
                // guide makes line icons). Default: inside the edge, so the drawing keeps its size.
                lines = centered ? stroke(whole, w / 2, true) : whole.intersect(stroke(whole, w, true), { insert: false });
                report(opts.gap > 0 ? 0.15 : 0.3);
                await tick();
                if (opts.lineInner !== false && byColor.length > 1) {
                    for (const [i, [, p]] of byColor.entries()) {
                        const inner = centered ? stroke(p, w / 2, true) : safeIntersect(whole, stroke(p, w / 2, true));
                        if (inner) lines = safeUnite(lines, inner);
                        report((opts.gap > 0 ? 0.15 : 0.3) + (opts.gap > 0 ? 0.25 : 0.6) * (i + 1) / byColor.length);
                        await tick();
                    }
                }
                // Outline colors are the line drawing as they are. The other colors' lines along them
                // (the double line around Docker, its filled container slats) give way to them.
                if (asLines.length) {
                    const drawn = unite(byColor.filter(([c]) => asLines.includes(c)).map(([, p]) => p.clone({ insert: false })));
                    // Where the outline color swells into a blob (GCC's hoof and ear, drawn solid in
                    // the outline color) it is outlined too, not drawn solid: the parts more than three
                    // lines thick (what is left of it shrunk by 1.5 lines and grown back).
                    let asDrawn = drawn;
                    try {
                        const r = 1.5 * w;
                        const shrunk = PaperOffset.offset(drawn, -r, { join: 'round', insert: false });
                        const blobs = shrunk && !shrunk.isEmpty() ? PaperOffset.offset(shrunk, r + Math.max(0.01, r / 50), { join: 'round', insert: false }) : null;
                        if (blobs && !blobs.isEmpty() && Math.abs(blobs.area) > 4 * w * w) {
                            const inside = safeIntersect(blobs, drawn);
                            if (inside && !inside.isEmpty()) {
                                const ring = safeIntersect(inside, stroke(inside, w, true));
                                const rest = drawn.subtract(inside, { insert: false });
                                const next = ring ? safeUnite(rest, ring) : null;
                                if (next && Math.abs(next.area) < Math.abs(drawn.area) + 1e-6) asDrawn = next;
                            }
                        }
                    } catch (err) { asDrawn = drawn; }
                    lines = lines.subtract(stroke(drawn, w / 2), { insert: false }).unite(asDrawn, { insert: false });
                }
            }

            let gap = Number(opts.gap) || 0;
            // opts.gaps 'auto': no gaps when the one-colour drawing already shows its parts through
            // its holes (a mesh like SQL Server's, line art like GCC's bull, HAProxy's grid): the
            // holes' outlines, against the drawing's size, past 14. Gaps there only cut it up.
            if (gap > 0 && opts.gaps === 'auto' && byColor.length > 1) {
                const all = clean(unite(byColor.map(([, p]) => p.clone({ insert: false }))));
                const kids = all.children ? all.children : [all];
                const depthOf = (k) => { const at = k.firstSegment && k.firstSegment.point; return at ? kids.filter((c) => c !== k && c.bounds.contains(k.bounds) && c.contains(at)).length : 0; };
                const holeLen = kids.filter((k) => depthOf(k) % 2 === 1).reduce((t, k) => t + k.length, 0);
                if (holeLen / Math.sqrt(Math.abs(all.area) || 1) > 14) gap = 0;
            }
            if (gap > 0 && byColor.length > 1) {
                if (!PaperOffset) throw new GeometryError('Gaps need the offset library, which did not load.');
                const half = (gap * scale) / 2;
                // Only colors that come within a gap of each other need the work.
                const near = (a, b) => a.bounds.expand(half * 2 + 1e-6).intersects(b.bounds);
                // The smaller of two parts gives up the whole gap, along the larger one's edge: the
                // larger keeps its exact shape (so the silhouette stays whole where they meet the
                // edge), and every cut runs straight through. A thin part (under three gaps thick: a
                // line of the drawing, Grunt's features) would vanish that way: it and its neighbour
                // share the gap, half each, as before.
                const sizes = byColor.map(([, p]) => Math.abs(p.area));
                const thickOf = (p) => {
                    const kids = p.children ? p.children : [p];
                    const per = kids.reduce((t, k) => t + k.length, 0), area = Math.abs(p.area);
                    const disc = per * per - 16 * area;
                    return disc > 0 ? (per - Math.sqrt(disc)) / 4 : (2 * area) / (per || 1);
                };
                const thick = byColor.map(([, p]) => opts.gapSplit !== 'half' && thickOf(p) >= 3 * gap * scale);
                const bigger = (j, i) => sizes[j] > sizes[i] || (sizes[j] === sizes[i] && j < i);
                // How i and j share: i loses a whole gap ('full'), half ('half') or nothing.
                const share = (i, j) => (bigger(j, i) ? (thick[i] ? 'full' : 'half') : (thick[j] ? null : 'half'));
                const full = [], halfB = [];
                for (const [i, [, p]] of byColor.entries()) {
                    let needFull = false, needHalf = false;
                    byColor.forEach(([, q], j) => {
                        if (j === i || !near(p, q)) return;
                        const how = share(j, i); // what j loses to i
                        if (how === 'full') needFull = true; else if (how === 'half') needHalf = true;
                    });
                    full.push(needFull ? stroke(p, 2 * half) : null);
                    halfB.push(needHalf ? stroke(p, half) : null);
                    report((lines ? 0.4 : 0.2) + (lines ? 0.5 : 0.7) * (i + 1) / byColor.length);
                    await tick();
                }
                const before = clean(unite(byColor.map(([, p]) => p.clone({ insert: false }))));
                byColor = byColor.map(([c, p], i) => {
                    let out = p;
                    byColor.forEach((e, j) => {
                        if (j === i) return;
                        const how = share(i, j), band = how === 'full' ? full[j] : how === 'half' ? halfB[j] : null;
                        if (band && band.bounds.intersects(out.bounds)) out = out.subtract(band, { insert: false });
                    });
                    return [c, out];
                }).filter(([, p]) => !p.isEmpty());
                // Where a gap leaves the drawing at a shallow angle it would take a long wedge out of
                // the silhouette (the gap looks far wider at its ends). There the edge stays: the
                // part of the gap within half a gap of the edge, if it runs along the edge for more
                // than about two gaps, goes back to the color it borders most. A gap that meets the
                // edge head-on stays open.
                // Hairlines the gaps split off (a sliver of a color running along the edge outside
                // another) would show as stray lines: they go.
                byColor = byColor.map(([c, p]) => {
                    if (p.children) p.children.slice().forEach((k) => { if (k.length > 0 && (2 * Math.abs(k.area)) / k.length < half && k.area * (p.area || 1) > 0) k.remove(); });
                    return [c, p];
                }).filter(([, p]) => p && !p.isEmpty());
                if (opts.gapEdges === true && byColor.length) {
                    try {
                        const rim = 2 * half;
                        const core = PaperOffset.offset(before, -rim, { join: 'round', insert: false });
                        if (core && !core.isEmpty() && Math.abs(core.area) < Math.abs(before.area)) {
                            const after = unite(byColor.map(([, p]) => p.clone({ insert: false })));
                            const lost = before.subtract(after, { insert: false }).subtract(core, { insert: false });
                            for (const k of (lost.children ? lost.children.slice() : [lost])) {
                                const piece = new scope.Path({ segments: k.segments, closed: true, insert: false });
                                const area = Math.abs(piece.area);
                                if (!(area > 0) || area / rim < 2.2 * 2 * half) continue;
                                const votes = new Map();
                                const len = piece.length, step = Math.min(half, 0.05 * size);
                                for (let t = 0; t < 32; t++) {
                                    const at = (len * (t + 0.5)) / 32, pt = piece.getPointAt(at), n = piece.getNormalAt(at);
                                    if (!pt || !n) continue;
                                    for (const q of [pt.add(n.multiply(step)), pt.subtract(n.multiply(step))]) {
                                        for (const e of byColor) if (e[1].contains(q)) votes.set(e, (votes.get(e) || 0) + 1);
                                    }
                                }
                                if (!votes.size) continue;
                                const to = [...votes].sort((x, y) => y[1] - x[1])[0][0];
                                const grown = safeUnite(to[1], piece);
                                if (grown) to[1] = grown;
                            }
                        }
                    } catch (err) { /* keep the gaps as they are */ }
                }
            }

            // linePlain: the lines of the one-colour version. Made after holes, outline gaps and
            // gaps, so whatever the plain version shows apart gets its own outline (the way
            // devicon's tools make line icons: the plain shape, outlined inward).
            if (line > 0 && byColor.length && opts.linePlain) {
                if (!PaperOffset) throw new GeometryError('Lines need the offset library, which did not load.');
                const whole = clean(unite(byColor.map(([, p]) => p.clone({ insert: false }))));
                lines = centered ? stroke(whole, (line * scale) / 2, true) : whole.intersect(stroke(whole, line * scale, true), { insert: false });
                report(0.9);
                await tick();
            }

            // A thin, long part (a stroke drawn as a shape: a curve, a ring, a bar) between one and
            // three line widths wide would get a line along each side: two lines close together that
            // read as one thick one, or a filled stripe. It gets one line down its middle instead:
            // the part shrunk until it is one line wide.
            if (lines && opts.centerlines !== false) {
                const w = line * scale;
                const shrink = (piece, d) => {
                    try {
                        const r = PaperOffset.offset(piece, -d, { join: 'round', insert: false });
                        if (r && !r.isEmpty() && Math.abs(r.area) > 0 && Math.abs(r.area) < Math.abs(piece.area)) return r;
                    } catch (err) { /* keep it as it was */ }
                    return null;
                };
                for (const [, p] of byColor) {
                    const kids = p.children ? p.children : [p];
                    // Filled or a hole: how many of the other outlines it lies inside (even: filled).
                    const depth = (k) => { const at = k.firstSegment && k.firstSegment.point; return at ? kids.filter((c) => c !== k && c.bounds.contains(k.bounds) && c.contains(at)).length : 0; };
                    const filled = kids.filter((k) => depth(k) % 2 === 0);
                    const holes = kids.filter((k) => !filled.includes(k));
                    for (const k of filled) {
                        const inside = holes.filter((h) => k.bounds.contains(h.bounds) && k.contains(h.firstSegment.point) && depth(h) === depth(k) + 1);
                        // A stroke or a ring (one hole at most); a mesh of strands keeps its outlines.
                        if (inside.length > 1) continue;
                        const area = Math.abs(k.area) - inside.reduce((t, h) => t + Math.abs(h.area), 0);
                        const per = k.length + inside.reduce((t, h) => t + h.length, 0);
                        if (!(area > 0 && per > 0)) continue;
                        // Its thickness as a strip's (area = length x thickness, outline = 2 (length + thickness)),
                        // which counts the ends of a short bar right; and only a long part, at least four
                        // times longer than thick, is a stroke.
                        const disc = per * per - 16 * area;
                        const width = disc > 0 ? (per - Math.sqrt(disc)) / 4 : (2 * area) / per;
                        if (width < 1.2 * w || width >= 3 * w || area / width < 4 * width) continue;
                        let piece = new scope.Path({ segments: k.segments, closed: true, insert: false });
                        if (piece.area < 0) piece.reverse();
                        for (const h of inside) piece = piece.subtract(h, { insert: false });
                        const d = (width - w) / 2;
                        const center = shrink(piece, d);
                        if (!center) continue;
                        // Only a part of fairly even width: grown back, the line covers most of it.
                        // A mesh of strands of many widths (SQL Server's) would lose its thin strands.
                        let back = null;
                        try { back = PaperOffset.offset(center, d, { join: 'round', insert: false }); } catch (err) { back = null; }
                        if (!back || Math.abs(back.area) < 0.85 * Math.abs(piece.area)) continue;
                        // And the line it leaves is one line wide (a part of uneven width shrinks too little).
                        const ca = Math.abs(center.area), cl = center.length, cd = cl * cl - 16 * ca;
                        const ct = cd > 0 ? (cl - Math.sqrt(cd)) / 4 : (2 * ca) / cl;
                        if (!(cl > 0) || ct > 1.4 * w) continue;
                        // Even in thickness: no point of the line is more than about a line's width from
                        // its edge. A part with a thick bit (a box on a thin connector) would otherwise keep
                        // that bit solid as its "line". (Sampled on a grid; offsets shrunk past a part's
                        // middle can return garbage, so they're no help here.)
                        const cb = center.bounds, step = Math.max(w / 2, Math.max(cb.width, cb.height) / 60);
                        let thickBit = false;
                        for (let x = cb.x + step / 2; x < cb.x + cb.width && !thickBit; x += step) {
                            for (let y = cb.y + step / 2; y < cb.y + cb.height; y += step) {
                                const pt = new scope.Point(x, y);
                                if (!center.contains(pt)) continue;
                                const near = center.getNearestPoint(pt);
                                if (near && near.getDistance(pt) > 0.85 * w) { thickBit = true; break; }
                            }
                        }
                        // Unless the lines there are nearly a solid blob anyway (a tapering wedge, SQL Server's
                        // and CachyOS's; a box keeps its hole, so well under this):
                        // then even an uneven centerline is better.
                        if (thickBit) {
                            const there = safeIntersect(lines, piece);
                            if (!there || Math.abs(there.area) < 0.85 * Math.abs(piece.area)) continue;
                        }
                        let cut = piece;
                        if (centered) { try { const g = PaperOffset.offset(piece, w / 2, { join: 'round', insert: false }); if (g && Math.abs(g.area) > Math.abs(piece.area)) cut = g; } catch (err) { cut = piece; } }
                        const rest = lines.subtract(cut, { insert: false });
                        // A boolean step that went wrong takes away more than the part ever covered.
                        if (Math.abs(lines.area) - Math.abs(rest.area) > 1.02 * Math.abs(cut.area) + 1e-6) continue;
                        const next = safeUnite(rest, center);
                        if (next && !next.isEmpty() && Math.abs(next.area) >= Math.max(Math.abs(rest.area), Math.abs(center.area)) - 1e-6) lines = next;
                    }
                }
            }

            // Line version: each color keeps only its part of the lines, unless it stays filled.
            if (lines) {
                // Merge the colors that end up the same color first, then take their part of the
                // lines once: fewer boolean steps, and the per-region ones sometimes went wrong.
                const keep = new Set(opts.keep || []);
                const groups = new Map(); // output color -> [first original color, [regions]]
                const kept = [];
                for (const [c, p] of byColor) {
                    if (keep.has(c)) { kept.push([c, p]); continue; }
                    const to = outOf(c);
                    if (!groups.has(to)) groups.set(to, [c, []]);
                    groups.get(to)[1].push(p);
                }
                // Each color's part of the lines, two ways that should agree: its region's part, and
                // the lines minus every other region. A failed boolean step only ever adds area, so
                // keep the smaller one.
                const regionsOf = [...groups.values()].map(([c, list]) => [c, unite(list)]);
                const keptAll = kept.length ? unite(kept.map(([, p]) => p.clone({ insert: false }))) : null;
                // Centered lines reach half a line outside the drawing: each color takes the lines
                // within half a line of its region, the first come keeping a shared stretch.
                if (centered && regionsOf.length + kept.length > 1) {
                    let taken = keptAll ? keptAll.clone({ insert: false }) : null;
                    const half = (line * scale) / 2;
                    byColor = regionsOf.map(([c, region]) => {
                        let near = region;
                        try { const g = PaperOffset.offset(region, half * 1.02, { join: 'round', insert: false }); if (g && Math.abs(g.area) > Math.abs(region.area)) near = g; } catch (err) { near = region; }
                        let part = safeIntersect(near, lines) || near.intersect(lines, { insert: false });
                        if (taken) part = part.subtract(taken, { insert: false });
                        taken = taken ? safeUnite(taken, part) : part.clone({ insert: false });
                        return [c, part];
                    }).concat(kept).filter(([, p]) => p && !p.isEmpty());
                } else byColor = regionsOf.map(([c, region], i) => {
                    const a = region.intersect(lines, { insert: false });
                    // One colour in the end: the lines lie inside the drawing already, so they are its part.
                    if (regionsOf.length + kept.length < 2) return [c, centered ? lines : safeIntersect(region, lines) || lines];
                    let others = keptAll ? keptAll.clone({ insert: false }) : null;
                    regionsOf.forEach(([, r], j) => { if (j !== i) others = others ? others.unite(r, { insert: false }) : r.clone({ insert: false }); });
                    const b = others ? lines.subtract(others, { insert: false }) : a;
                    return [c, Math.abs(b.area) < Math.abs(a.area) - 1e-6 ? b : a];
                }).concat(kept).filter(([, p]) => p && !p.isEmpty());
            }

            // One path per output color: colors the style maps to the same color merge.
            const outColors = [];
            const outRegions = new Map();
            for (const [c, p] of byColor) {
                const to = outOf(c);
                if (!outRegions.has(to)) { outRegions.set(to, []); outColors.push(to); }
                outRegions.get(to).push(p);
            }
            const paths = [];
            for (const color of outColors) {
                const merged = unite(outRegions.get(color));
                if (!merged || merged.isEmpty()) continue;
                despike(merged);
                orient(merged); // outer shapes clockwise, holes the other way (icon fonts fill nonzero)
                paths.push('<path fill="#' + color + '" d="' + merged.getPathData(null, PRECISION) + '"/>');
            }
            // These come from the input (already unescaped by the parser): escape them again.
            const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const sizeAttrs = (width ? ' width="' + esc(width) + '"' : '') + (height ? ' height="' + esc(height) + '"' : '');
            const vbAttr = viewBox ? ' viewBox="' + esc(viewBox) + '"' : '';
            // Which light colors became holes, for the caller (it takes this comment out again).
            const note = soft.size || opts.outlines ? '<!--holes:' + holed.join(',') + '-->' : '';
            return '<svg xmlns="http://www.w3.org/2000/svg"' + vbAttr + sizeAttrs + '>' + paths.join('') + note + '</svg>\n';
        } finally {
            scope.project.remove();
        }
    }

    // The worker runs this same file (it is the last part of /assets/geometry.js).
    const scriptUrl = typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : null;
    let worker = null;
    let pending = null; // { reject } of the job the worker is on
    let jobs = 0;
    function runInWorker(input, opts) {
        if (pending) { // a newer request: stop the old work at once
            worker.terminate();
            worker = null;
            pending.reject(new GeometryError('superseded'));
            pending = null;
        }
        if (!worker) worker = new Worker(scriptUrl);
        const id = ++jobs;
        return new Promise((resolve, reject) => {
            pending = { reject };
            worker.onmessage = (e) => {
                if (e.data.id !== id) return;
                if (e.data.progress !== undefined) { if (opts.onProgress) opts.onProgress(e.data.progress); return; }
                pending = null;
                if (e.data.error) reject(new GeometryError(e.data.error)); else resolve(e.data.svg);
            };
            worker.onerror = (e) => {
                e.preventDefault();
                pending = null;
                worker = null;
                compute(input, opts, opts.onProgress).then(resolve, reject); // a worker that can't start: do it here
            };
            worker.postMessage({ id, input, opts: { cut: opts.cut, map: opts.map, gap: opts.gap, line: opts.line, lineInner: opts.lineInner, keep: opts.keep, unit: opts.unit, flat: opts.flat || null, holes: opts.holes || [], outlines: !!opts.outlines, linePlain: !!opts.linePlain, merge: Number(opts.merge) || 0, detail: Number(opts.detail) || 0, lineAlign: opts.lineAlign || null, gaps: opts.gaps || null, lightHoles: !!opts.lightHoles } });
        });
    }

    async function cutOut(svgText, opts) {
        if (!paper) throw new GeometryError('The geometry library did not load.');
        opts = opts || {};
        const input = readShapes(svgText, opts.flat || null);
        if (scriptUrl && typeof Worker !== 'undefined' && opts.worker !== false) return runInWorker(input, opts);
        return compute(input, opts, opts.onProgress);
    }

    if (typeof document === 'undefined' && typeof global.postMessage === 'function') {
        global.onmessage = async (e) => {
            const { id, input, opts } = e.data;
            try {
                let last = -1;
                const progress = (f) => { const pct = Math.floor(f * 100); if (pct !== last) { last = pct; global.postMessage({ id, progress: f }); } };
                global.postMessage({ id, svg: await compute(input, opts, progress) });
            } catch (err) {
                global.postMessage({ id, error: err instanceof GeometryError ? err.message : 'The geometry step failed: ' + err.message });
            }
        };
    }

    // The box around what's visible (strokes included, clipping respected), in the SVG's
    // own coordinates: [x, y, width, height], or null for an empty drawing. For "Fit".
    function bounds(svgText) {
        if (!paper) throw new GeometryError('The geometry library did not load.');
        const live = prepare(svgText, true);
        const scope = new paper.PaperScope();
        scope.setup(document.createElement('canvas'));
        try {
            if (live.getAttribute('viewBox')) { live.removeAttribute('width'); live.removeAttribute('height'); }
            const root = scope.project.importSVG(live, { expandShapes: true, insert: true, applyMatrix: false });
            const undo = root.matrix.inverted();
            const globalRect = (rect, matrix) => {
                const pts = [rect.topLeft, rect.topRight, rect.bottomLeft, rect.bottomRight].map((p) => undo.transform(matrix.transform(p)));
                return new scope.Rectangle(pts[0], pts[3]).include(pts[1]).include(pts[2]);
            };
            let box = null;
            for (const item of root.getItems({ recursive: true })) {
                const drawn = item instanceof scope.PathItem || item instanceof scope.Shape || item instanceof scope.TextItem || item instanceof scope.Raster;
                if (!drawn || item.clipMask || (item.parent instanceof scope.CompoundPath)) continue;
                const painted = item instanceof scope.Raster || (item.fillColor && item.fillColor.alpha !== 0)
                    || (item.strokeColor && item.strokeWidth > 0 && item.strokeColor.alpha !== 0);
                if (!painted) continue;
                let hidden = false;
                let rect = globalRect(item.strokeBounds, item.parent.globalMatrix);
                for (let a = item.parent; a && a !== root.parent; a = a.parent) {
                    if (!a.visible || a.opacity === 0) { hidden = true; break; }
                    if (a.clipped && a.children[0] && a.children[0] !== item) rect = rect.intersect(globalRect(a.children[0].bounds, a.globalMatrix));
                }
                if (hidden || !item.visible || item.opacity === 0 || rect.width <= 0 || rect.height <= 0) continue;
                box = box ? box.unite(rect) : rect;
            }
            return box ? [box.x, box.y, box.width, box.height] : null;
        } finally {
            scope.project.remove();
        }
    }

    // The same box from shapes that are already plain filled paths (the server's input).
    function boundsOfShapes(shapes) {
        const scope = new paper.PaperScope();
        scope.setup(new paper.Size(1, 1));
        try {
            let box = null;
            for (const { d, rule } of shapes) {
                const b = new scope.CompoundPath({ pathData: d, fillRule: rule, insert: false }).bounds;
                if (b.width > 0 || b.height > 0) box = box ? box.unite(b) : b;
            }
            return box ? [box.x, box.y, box.width, box.height] : null;
        } finally {
            scope.project.remove();
        }
    }

    // The most prominent color: the one seen most, sampled on a grid over the drawing (each
    // point takes the color of the topmost shape there; a gradient counts as its middle color).
    // Near-white colors only count when there's nothing else. As in server/shapes.py.
    function prominent(input) {
        const scope = new paper.PaperScope();
        scope.setup(new paper.Size(1, 1));
        try {
            const shapes = input.shapes.map(({ d, rule, color }) => ({ path: new scope.CompoundPath({ pathData: d, fillRule: rule, insert: false }), color }));
            if (!shapes.length) return null;
            const box = shapes.map((s) => s.path.bounds).reduce((a, b) => a.unite(b));
            const N = 48, seen = new Map();
            for (let i = 0; i < N; i++) {
                for (let j = 0; j < N; j++) {
                    const pt = new scope.Point(box.x + (box.width * (i + 0.5)) / N, box.y + (box.height * (j + 0.5)) / N);
                    for (let k = shapes.length - 1; k >= 0; k--) {
                        const { path, color } = shapes[k];
                        if (path.bounds.contains(pt) && path.contains(pt)) { seen.set(color, (seen.get(color) || 0) + 1); break; }
                    }
                }
            }
            // Near white, as "Light colors become holes" (app.js, server/shapes.py).
            const light = (c) => ((x) => Math.min(...x) >= 0xe0 || (Math.min(...x) >= 0xc8 && Math.max(...x) - Math.min(...x) <= 48))([0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)));
            const rgb = (c) => [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
            let pool = [...seen].filter(([c]) => !light(c));
            if (!pool.length) pool = [...seen];
            if (!pool.length) return null;
            // Shades of one color (a logo drawn in several blues) count together: each color scores
            // what's seen of it and of the colors close to it; the best scoring color wins.
            const near = (a, b) => { const [x, y] = [rgb(a), rgb(b)]; return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) <= 80; };
            // Grays (outlines, text, window frames) count a third: a logo's color is rarely its gray.
            const gray = (c) => { const x = rgb(c); return Math.max(...x) - Math.min(...x) < 40; };
            const score = (c) => pool.reduce((sum, [d, n]) => sum + (near(c, d) ? n : 0), 0) * (gray(c) ? 1 / 3 : 1);
            pool.sort((a, b) => score(b[0]) - score(a[0]) || b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
            // A one-colour icon has to show on white: skip pale colours (HSL lightness over 72%,
            // like GCC's peach egg) when there's a darker one.
            const lightness = (c) => { const x = rgb(c); return (Math.max(...x) + Math.min(...x)) / 510; };
            return (pool.find(([c]) => lightness(c) <= 0.72) || pool[0])[0];
        } finally {
            scope.project.remove();
        }
    }
    function prominentColor(svgText) {
        if (!paper) throw new GeometryError('The geometry library did not load.');
        return prominent(readShapes(svgText, null, true));
    }

    global.SvgGeometry = { cutOut, bounds, compute, boundsOfShapes, prominent, prominentColor, GeometryError, expandArcFlags };
})(typeof window !== 'undefined' ? window : globalThis);
