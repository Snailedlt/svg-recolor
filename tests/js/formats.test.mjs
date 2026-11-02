// Every code format must produce code that its real toolchain accepts, for a plain
// SVG and for one with <style>, braces, backticks, ${} and quotes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import { compile } from 'svelte/compiler';
import { parse as vueParse, compileTemplate, compileScript } from '@vue/compiler-sfc';
import { SvgFormats as F, SvgIcons } from './load.mjs';

const plain = readFileSync(new URL('../fixtures/python.svg', import.meta.url), 'utf8');
const tricky = '<?xml version="1.0"?>\n<!-- c -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" class="ic" style="stroke-width: 2; fill-rule: evenodd">'
    + '<style>.a{fill:#ff0000}</style><text>{x} @user `tick` ${y} \\back """ \'\'\'</text>'
    + '<rect class="a" stroke-linecap="round" xlink:href="#q" width="4" height="4"/></svg>';

const JSX = ['react', 'react-native', 'solid', 'lit', 'webcomponent'];
const TSX = ['react-ts', 'angular'];

function python(code) {
    const dir = mkdtempSync(join(tmpdir(), 'svgr-'));
    const file = join(dir, 'icon.py');
    writeFileSync(file, code);
    execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', file]);
}

for (const [name, svg] of [['plain', plain], ['tricky', tricky]]) {
    for (const f of F.list) {
        test(`${f.id} (${name} SVG)`, async () => {
            assert.ok(SvgIcons.has(f), 'icon exists');
            const code = F.convert(f.id, svg);
            assert.ok(code.length > 10);
            assert.ok(!/undefined|NaN/.test(code.replace(svg, '')), 'no undefined/NaN');
            if (JSX.includes(f.id)) await esbuild.transform(code, { loader: 'jsx' });
            else if (TSX.includes(f.id)) await esbuild.transform(code, { loader: 'tsx', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } });
            else if (f.id === 'svelte') compile(code, { filename: 'Icon.svelte' });
            else if (f.id === 'vue') {
                const { descriptor, errors } = vueParse(code);
                assert.equal(errors.length, 0);
                if (descriptor.scriptSetup) compileScript(descriptor, { id: 'x' });
                const t = compileTemplate({ source: descriptor.template.content, filename: 'Icon.vue', id: 'x' });
                assert.equal(t.errors.length, 0, String(t.errors[0]));
            } else if (f.id === 'python' || f.id === 'streamlit') python(code);
            else if (f.id === 'datauri') assert.equal(decodeURIComponent(code.slice('data:image/svg+xml,'.length)), svg.replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/, '').trim().replace(/\s*\n\s*/g, ' '));
            else if (f.id === 'base64') assert.equal(Buffer.from(code, 'base64').toString('utf8'), svg);
        });
    }
}

test('embedded SVG strings round-trip exactly', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>`a` ${b} \\c """ \'\'\'</text></svg>';
    const rn = F.convert('react-native', svg);
    const literal = rn.match(/const xml = (`[\s\S]*?(?<!\\)`);/)[1];
    assert.equal(eval(literal), svg); // eslint-disable-line no-eval
    const py = F.convert('python', svg);
    const out = execFileSync('python3', ['-c', 'ns={}; exec(open(0).read(), ns); print(ns["RECOLORED_ICON"], end="")'], { input: py }).toString();
    assert.equal(out, svg);
});

test('the AI prompt entry is a prompt', () => {
    assert.equal(F.get('ai').prompt, true);
});
