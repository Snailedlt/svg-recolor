// Loads the browser scripts into Node, the same way the page does.
import { createRequire } from 'node:module';

globalThis.window = globalThis;
const require = createRequire(import.meta.url);
for (const f of ['icons.js', 'engine.js', 'formats.js', 'snippets.js', 'highlight.js']) require('../../static/' + f);

export const { SvgFormats, SvgSnippets, SvgEngine, SvgIcons, SvgHighlight } = globalThis;
