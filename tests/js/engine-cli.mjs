// Reads [{svg, mapping, hide, remove}] as JSON on stdin and prints what static/engine.js makes of it.
// Used by tests/test_parity.py to compare the browser engine with recolor.py.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

globalThis.window = globalThis;
createRequire(import.meta.url)('../../static/engine.js');
const { SvgEngine } = globalThis;

const cases = JSON.parse(readFileSync(0, 'utf8'));
const out = cases.map(({ svg, mapping, hide, remove }) => {
    const norm = SvgEngine.normalize(svg);
    return { norm, palette: SvgEngine.palette(norm), out: SvgEngine.apply(SvgEngine.edit(norm, hide, remove), mapping) };
});
process.stdout.write(JSON.stringify(out));
