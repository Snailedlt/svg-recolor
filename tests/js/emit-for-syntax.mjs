// Prints, as JSON, the snippets and formats that tests/test_syntax.py parses
// (languages without a compiler in CI: Swift, Dart/Flutter, PowerShell).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

globalThis.window = globalThis;
const require = createRequire(import.meta.url);
for (const f of ['icons', 'snippets', 'formats']) require(`../../static/${f}.js`);
const { SvgSnippets: S, SvgFormats: F } = globalThis;

const ctx = {
    site: 'https://svg-recolor.jorgenkh.no', query: 'color=3ecf8e&mode=colorize&hue=20', params: { color: '3ecf8e', mode: 'colorize', hue: 20 },
    getUrl: 'https://svg-recolor.jorgenkh.no/api/recolor?url=x', input: 'icon.svg', output: 'out.svg', target: '',
};
const plain = readFileSync(new URL('../fixtures/python.svg', import.meta.url), 'utf8');
const tricky = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>$x {y} \"q\" ''' \\back @a</text></svg>";
process.stdout.write(JSON.stringify({
    'swift snippet': ['swift', S.build('swift', ctx)],
    'dart snippet': ['dart', S.build('dart', ctx)],
    'powershell snippet': ['powershell', S.build('powershell', ctx)],
    'kotlin snippet': ['kotlin', S.build('kotlin', ctx)],
    'java snippet': ['java', S.build('java', ctx)],
    'flutter format': ['dart', F.convert('flutter', plain)],
    'flutter format, tricky SVG': ['dart', F.convert('flutter', tricky)],
}));
