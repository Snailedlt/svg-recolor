// Syntax highlighting: lossless for every format and snippet, and it marks up
// the parts that matter (tags, attributes, strings, keywords, comments).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SvgFormats as F, SvgSnippets as S, SvgHighlight as H } from './load.mjs';

const svg = readFileSync(new URL('../fixtures/python.svg', import.meta.url), 'utf8');
const ctx = {
    site: 'https://svg-recolor.example', query: 'mode=tint&color=ff0066', params: { mode: 'tint', color: 'ff0066' },
    getUrl: 'https://svg-recolor.example/api/recolor?url=x', input: 'icon.svg', output: 'icon-recolored.svg', target: 'Elixir',
};
const join = (toks) => toks.map((t) => t[1]).join('');
const kinds = (toks) => new Set(toks.map((t) => t[0]).filter(Boolean));
const tokenOf = (toks, text) => toks.find((t) => t[1] === text);

for (const f of F.list) {
    test(`format ${f.id} highlights losslessly`, () => {
        const code = F.convert(f.id, svg);
        const lang = f.prompt ? 'text' : H.langFor(f.file);
        assert.equal(join(H.tokens(code, lang)), code);
    });
}

for (const s of S.list) {
    test(`snippet ${s.id} highlights losslessly`, () => {
        assert.ok(s.lang, 'has a lang');
        assert.ok(s.lang === 'text' || H.languages.includes(s.lang), 'lang is known: ' + s.lang);
        const code = S.build(s.id, ctx);
        const toks = H.tokens(code, s.lang);
        assert.equal(join(toks), code);
        if (!['text', 'sh'].includes(s.lang) || s.id === 'curl') assert.ok(kinds(toks).has('t-s'), 'strings are marked');
    });
}

test('markup: tags, attributes and values', () => {
    const toks = H.tokens('<svg viewBox="0 0 24 24"><!-- c --><path d="M0"/></svg>', 'markup');
    assert.equal(tokenOf(toks, '<svg')[0], 't-t');
    assert.equal(tokenOf(toks, 'viewBox')[0], 't-a');
    assert.equal(tokenOf(toks, '"0 0 24 24"')[0], 't-s');
    assert.equal(tokenOf(toks, '<!-- c -->')[0], 't-c');
    assert.equal(tokenOf(toks, '/>')[0], 't-t');
});

test('Vue and Svelte: script blocks are highlighted as code', () => {
    const toks = H.tokens('<script setup>\nconst props = defineProps({ size: Number });\n</script>\n<template>\n  <svg :width="size"></svg>\n</template>', 'vue');
    assert.equal(tokenOf(toks, 'const')[0], 't-k', 'keywords inside <script>');
    assert.equal(tokenOf(toks, '<template')[0], 't-t');
    assert.equal(tokenOf(toks, ':width')[0], 't-a');
    const sv = H.tokens('<script>\n  let { size = 24 } = $props();\n</script>\n<svg width={size}></svg>', 'svelte');
    assert.equal(tokenOf(sv, 'let')[0], 't-k');
    assert.equal(tokenOf(sv, '{size}')[0], 't-v');
});

test('React: JSX inside JavaScript is markup, generics are not', () => {
    const toks = H.tokens(F.convert('react', svg), 'js');
    assert.equal(tokenOf(toks, 'export')[0], 't-k');
    assert.equal(tokenOf(toks, '<svg')[0], 't-t');
    const ts = H.tokens('const a: Array<string> = [];', 'js');
    assert.ok(!ts.some((t) => t[0] === 't-t'), 'Array<string> is not a tag');
});

test('code: keywords, literals, functions, comments', () => {
    const toks = H.tokens('// hi\nconst x = await fetch("u", { ok: true });', 'js');
    assert.equal(tokenOf(toks, '// hi')[0], 't-c');
    assert.equal(tokenOf(toks, 'const')[0], 't-k');
    assert.equal(tokenOf(toks, 'fetch')[0], 't-f');
    assert.equal(tokenOf(toks, '"u"')[0], 't-s');
    assert.equal(tokenOf(toks, 'true')[0], 't-l');
    const py = H.tokens('RECOLORED = """<svg/>"""  # x', 'py');
    assert.equal(tokenOf(py, '"""<svg/>"""')[0], 't-s');
    const rs = H.tokens('let s = r#"a "b""#;', 'rust');
    assert.equal(tokenOf(rs, 'r#"a "b""#')[0], 't-s');
    const sh = H.tokens('curl -X POST "u" \\\n  -F "file=@icon.svg"', 'sh');
    assert.equal(tokenOf(sh, 'curl')[0], 't-f');
    assert.equal(tokenOf(sh, '-X')[0], 't-a');
    const swift = H.tokens('#if canImport(X)\n', 'swift');
    assert.equal(tokenOf(swift, '#if')[0], 't-k');
});

test('markdown: headings, images, links and code', () => {
    const toks = H.tokens('# Title\n\n![Icon](https://x/a.svg) and [docs](https://x) with `code`\n<!-- c -->\n- item', 'md');
    assert.equal(tokenOf(toks, '# Title')[0], 't-k');
    assert.equal(tokenOf(toks, '![Icon]')[0], 't-a');
    assert.equal(tokenOf(toks, '(https://x/a.svg)')[0], 't-s');
    assert.equal(tokenOf(toks, '`code`')[0], 't-s');
    assert.equal(tokenOf(toks, '<!-- c -->')[0], 't-c');
    assert.equal(tokenOf(toks, '-')[0], 't-v');
    assert.equal(H.langFor('icon.md'), 'md');
});

test('unknown languages and empty input are plain', () => {
    assert.deepEqual(H.tokens('a < b', 'text'), [['', 'a < b']]);
    assert.deepEqual(H.tokens('', 'js'), []);
    assert.equal(H.langFor('resources/views/components/x.blade.php'), 'blade');
    assert.equal(H.langFor('icon.b64.txt'), 'text');
});

test('unterminated input never loops or loses text', () => {
    for (const lang of H.languages) {
        for (const bad of ['"abc', "'", '/* x', '<svg a="', '<!-- x', '{{ x', '<', '{', 'r#"x', '`x ${']) {
            assert.equal(join(H.tokens(bad, lang)), bad, lang + ': ' + bad);
        }
    }
});
