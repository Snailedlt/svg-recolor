// API snippets: every language builds, uses the current settings and site, and the
// AI prompts carry the target. (Snippets were also run against a live server once;
// see the commit history.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SvgSnippets as S, SvgIcons } from './load.mjs';

const ctx = {
    site: 'https://svg-recolor.example', query: 'color=3ecf8e&mode=colorize&hue=20', params: { color: '3ecf8e', mode: 'colorize', hue: 20 },
    getUrl: 'https://svg-recolor.example/api/recolor?mode=colorize&url=x', input: 'icon.svg', output: 'icon-recolored.svg', target: 'Elixir',
};

for (const s of S.list) {
    test(`snippet ${s.id}`, () => {
        assert.ok(SvgIcons.has(s), 'icon exists');
        const code = S.build(s.id, ctx);
        assert.ok(!/undefined|NaN|\[object Object\]/.test(code));
        assert.ok(code.includes('svg-recolor.example'), 'uses the site URL');
        if (!['link', 'html', 'mcp', 'httpie', 'fetch'].includes(s.id)) assert.ok(code.includes('icon.svg'), 'reads the input file');
    });
}

test('API prompt names the language and settings', () => {
    const p = S.build('ai', ctx);
    assert.match(p, /^Write Elixir code/);
    assert.match(p, /color=3ecf8e, mode=colorize, hue=20/);
    assert.match(S.build('ai', { ...ctx, target: '' }), /\[your language or framework\]/);
});

test('code prompt embeds small SVGs and asks to attach large ones', () => {
    assert.match(S.codePrompt('Qwik', '<svg/>', 'a.svg'), /```svg\n<svg\/>\n```/);
    assert.match(S.codePrompt('Qwik', '<svg>' + 'x'.repeat(40000) + '</svg>', 'a.svg'), /attached it as "a.svg"/);
});
