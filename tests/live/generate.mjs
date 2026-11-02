// Writes every runnable API snippet (static/snippets.js) into build/<id>/ for run.sh,
// pointed at a local server. Usage: node generate.mjs http://127.0.0.1:8899
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';

globalThis.window = globalThis;
const require = createRequire(import.meta.url);
require('../../static/icons.js');
require('../../static/snippets.js');
require('../../static/formats.js');
const { SvgSnippets: S, SvgFormats: F } = globalThis;

const site = process.argv[2];
const ctx = {
    site, query: 'color=3ecf8e&mode=colorize&hue=20', params: { color: '3ecf8e', mode: 'colorize', hue: 20 },
    getUrl: site + '/api/recolor?url=x', input: 'icon.svg', output: 'out.svg', target: '',
};
const files = {
    curl: 'run.sh', httpie: 'run.sh', node: 'run.mjs', axios: 'run.mjs', requests: 'run.py', httpx: 'run.py',
    go: 'main.go', rust: 'main.rs', java: 'Recolor.java', kotlin: 'Recolor.kt', csharp: 'Snippet.cs.txt', php: 'run.php', ruby: 'run.rb',
};
const fixture = new URL('../fixtures/python.svg', import.meta.url);
for (const [id, file] of Object.entries(files)) {
    let code = S.build(id, ctx);
    if (id === 'curl') code = code.split('\n\n')[0]; // the upload example
    const dir = new URL(`./build/${id}/`, import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL(file, dir), code);
    copyFileSync(fixture, new URL('icon.svg', dir));
}

// Blazor: the generated component, rendered by .NET's HtmlRenderer in run.sh.
const blazor = new URL('./build/blazor/', import.meta.url);
mkdirSync(blazor, { recursive: true });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>user@example.com @if(x) {braces} @@ "q" &amp; ok</text><rect fill="#f00"/></svg>';
writeFileSync(new URL('RecoloredIcon.razor', blazor), F.convert('blazor', svg));
writeFileSync(new URL('expected.svg', blazor), svg.replace('<svg', '<svg class="size-6"'));
console.log('generated', Object.keys(files).length, 'snippets + blazor');
