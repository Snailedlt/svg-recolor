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
 * Gaps: with `gap` > 0, every boundary between two different original colors gets a
 * gap of that width (in units of a 128-unit icon, devicon's scale), centered on the
 * boundary; each side gives up half. The outer edge stays where it is, and touching
 * shapes of the same color merge. With Solid that keeps the color areas apart.
 *
 *   SvgGeometry.cutOut(svgText, { cut: ['dce0df'], map: { '5e97f6': 'ff0066' }, gap: 2 }) -> Promise<svgText>
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
    function prepare(svgText) {
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const svg = doc.documentElement;
        if (svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new GeometryError('This SVG could not be read.');
        svg.querySelectorAll('script, foreignObject, iframe').forEach((n) => n.remove());
        for (const el of [svg, ...svg.querySelectorAll('*')]) {
            for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
        }
        if (svg.querySelector('text')) throw new GeometryError('Cut out works on shapes, and this SVG has text. Convert the text to paths first (in Inkscape: Path → Object to Path).');
        if (svg.querySelector('image')) throw new GeometryError('Cut out works on shapes, and this SVG has an embedded image.');

        // Measure computed styles in an invisible box on the page.
        const box = document.createElement('div');
        box.style.cssText = 'position:absolute;left:-10000px;top:0;width:0;height:0;overflow:hidden';
        const live = document.importNode(svg, true);
        box.appendChild(live);
        document.body.appendChild(box);
        try {
            const props = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'opacity', 'fill-opacity', 'stroke-opacity'];
            const all = [live, ...live.querySelectorAll('*')];
            for (const el of all) {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || (cs.visibility !== 'visible' && el.matches('path, rect, circle, ellipse, line, polyline, polygon'))) {
                    el.setAttribute('display', 'none');
                    continue;
                }
                if (el.matches('path, rect, circle, ellipse, line, polyline, polygon') && /url\(/.test(cs.fill + cs.stroke)) {
                    throw new GeometryError('Cut out works with flat colors, and this SVG uses gradients or patterns.');
                }
                for (const p of props) el.setAttribute(p, p === 'stroke-width' ? String(parseFloat(cs.strokeWidth) || 0) : cs.getPropertyValue(p));
                el.removeAttribute('style');
                el.removeAttribute('class');
            }
            live.querySelectorAll('style').forEach((n) => n.remove());
            live.querySelectorAll('path[d]').forEach((p) => p.setAttribute('d', expandArcFlags(p.getAttribute('d'))));
            // A rect with only rx (or ry) has round corners per the spec; paper reads the missing one as 0.
            live.querySelectorAll('rect').forEach((r) => {
                const rx = r.getAttribute('rx'), ry = r.getAttribute('ry');
                if (rx && !ry) r.setAttribute('ry', rx);
                if (ry && !rx) r.setAttribute('rx', ry);
            });
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
                if (item.opacity < 1) throw new GeometryError('Cut out doesn\'t support semi-transparent groups yet.');
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
            if (item.className === 'SymbolItem') throw new GeometryError('Cut out doesn\'t support <use> elements yet. Expand them first (in Inkscape: Edit → Clone → Unlink Clone).');
            if (!isPath(item) || item.clipMask) return;
            const base = item.clone({ insert: false });
            base.transform(item.parent.globalMatrix);
            const add = (p, color) => {
                if (color.gradient) throw new GeometryError('Cut out works with flat colors, and this SVG uses gradients.');
                if (color.alpha < 1 || item.opacity < 1) throw new GeometryError('Cut out doesn\'t support semi-transparent colors yet.');
                p.fillColor = null; p.strokeColor = null;
                if (clip) p = p.intersect(clip, { insert: false });
                if (!p.isEmpty() && p.bounds.width > 0 && p.bounds.height > 0) out.push({ path: p, color: hex6(color) });
            };
            if (item.fillColor && item.fillColor.alpha !== 0) add(base.clone({ insert: false }), item.fillColor);
            if (item.strokeColor && item.strokeWidth > 0 && item.strokeColor.alpha !== 0) {
                if (!PaperOffset) throw new GeometryError('Strokes need the offset library, which did not load.');
                const g = item.parent.globalMatrix;
                const w = item.strokeWidth * Math.sqrt(Math.abs(g.scaling.x * g.scaling.y));
                add(PaperOffset.offsetStroke(base, w / 2, { cap: item.strokeCap || 'butt', join: item.strokeJoin || 'miter', insert: false }), item.strokeColor);
            }
            if (out.length > MAX_SHAPES) throw new GeometryError('This SVG has too many shapes for Cut out (over ' + MAX_SHAPES + ').');
        };
        walk(root, null);
        return out;
    }

    // Reading the SVG needs the page (DOM, computed styles); the heavy part (boolean
    // operations and offsets) runs in a worker when it can, so the page never freezes,
    // and a newer request stops an older one right away.
    function readShapes(svgText) {
        const live = prepare(svgText);
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
            const shapes = leaves(scope, root).map(({ path, color }) => {
                path.applyMatrix = true;
                return { d: path.pathData, rule: path.fillRule || 'nonzero', color };
            });
            const b = root.bounds;
            return { shapes, viewBox, width, height, bounds: [b.width, b.height] };
        } finally {
            scope.project.remove();
        }
    }

    const tick = () => new Promise((r) => setTimeout(r));

    async function compute(input, opts, progress) {
        const report = progress || (() => {});
        const { shapes: raw, viewBox, width, height, bounds } = input;
        const cut = new Set(opts.cut || []);
        const map = opts.map || {};
        const scope = new paper.PaperScope();
        scope.setup(new paper.Size(1, 1));
        try {
            const shapes = raw.map(({ d, rule, color }) => ({ path: new scope.CompoundPath({ pathData: d, fillRule: rule, insert: false }), color }));

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
                if (i % 25 === 0) { report((shapes.length - i) / shapes.length * (opts.gap > 0 ? 0.2 : 1)); await tick(); } // also keeps the page responsive without a worker
            }

            const unite = (list) => list.reduce((a, p) => (a ? a.unite(p, { insert: false }) : p), null);
            // One region per original color, in the order the colors first appear (bottom first).
            const order = [...regions.keys()].reverse();
            let byColor = order.map((c) => [c, unite(regions.get(c))]).filter(([, p]) => p && !p.isEmpty());

            const gap = Number(opts.gap) || 0;
            if (gap > 0 && byColor.length > 1) {
                if (!PaperOffset) throw new GeometryError('Gaps need the offset library, which did not load.');
                const vb = (viewBox || '').split(/[\s,]+/).map(Number);
                const size = vb.length === 4 && vb.every(Number.isFinite) ? Math.max(vb[2], vb[3]) : Math.max(bounds[0], bounds[1]);
                const half = (gap * size) / 128 / 2;
                // A band of half the gap on each side of a color's edge; other colors lose what it
                // covers. Only colors that come within the band of each other need the work.
                const near = (a, b) => a.bounds.expand(half * 2 + 1e-6).intersects(b.bounds);
                const bands = [];
                for (const [i, [, p]] of byColor.entries()) {
                    bands.push(byColor.some(([, q], j) => j !== i && near(p, q))
                        ? PaperOffset.offsetStroke(p, half, { join: 'round', cap: 'butt', insert: false }) : null);
                    report(0.2 + 0.7 * (i + 1) / byColor.length);
                    await tick();
                }
                byColor = byColor.map(([c, p], i) => {
                    let out = p;
                    bands.forEach((band, j) => { if (j !== i && band && band.bounds.intersects(out.bounds)) out = out.subtract(band, { insert: false }); });
                    return [c, out];
                }).filter(([, p]) => !p.isEmpty());
            }

            // One path per output color: colors the style maps to the same color merge.
            const outColors = [];
            const outRegions = new Map();
            for (const [c, p] of byColor) {
                const to = (map[c] || c).toLowerCase();
                if (!outRegions.has(to)) { outRegions.set(to, []); outColors.push(to); }
                outRegions.get(to).push(p);
            }
            const paths = [];
            for (const color of outColors) {
                const merged = unite(outRegions.get(color));
                if (!merged || merged.isEmpty()) continue;
                merged.reorient(true, true); // outer shapes clockwise, holes the other way (icon fonts fill nonzero)
                paths.push('<path fill="#' + color + '" d="' + merged.getPathData(null, PRECISION) + '"/>');
            }
            const sizeAttrs = (width ? ' width="' + width + '"' : '') + (height ? ' height="' + height + '"' : '');
            const vbAttr = viewBox ? ' viewBox="' + viewBox + '"' : '';
            return '<svg xmlns="http://www.w3.org/2000/svg"' + vbAttr + sizeAttrs + '>' + paths.join('') + '</svg>\n';
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
            worker.postMessage({ id, input, opts: { cut: opts.cut, map: opts.map, gap: opts.gap } });
        });
    }

    async function cutOut(svgText, opts) {
        if (!paper) throw new GeometryError('The geometry library did not load.');
        opts = opts || {};
        const input = readShapes(svgText);
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

    global.SvgGeometry = { cutOut, GeometryError, expandArcFlags };
})(typeof window !== 'undefined' ? window : globalThis);
