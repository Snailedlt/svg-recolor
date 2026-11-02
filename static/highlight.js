/*
 * SvgHighlight: a small syntax highlighter for the Code and API tabs.
 *
 * Not a full parser: one pass of regex rules per language, good enough to make
 * keywords, strings, comments, tags and attributes stand out. It builds DOM nodes
 * (spans and text) and never uses innerHTML, so it is safe for any input and works
 * under the page's strict CSP. Long inputs are cut at LIMIT characters by the
 * caller, so the work per render stays small.
 *
 *   SvgHighlight.render(preElement, text, lang)
 *   SvgHighlight.tokens(text, lang)  -> [[className | '', text], ...]
 *   SvgHighlight.langFor(fileName)   -> language id for a file name
 */
(function (root) {
    'use strict';

    const words = (s) => new Set(s.split(' '));
    const LITERALS = words('true false null nil None True False undefined NaN self this');
    const KEYWORDS = {
        js: words('as async await break case catch class const continue default delete do else export extends finally for from function get if implements import in instanceof interface let new of private public readonly return set static super switch throw try type typeof var void while yield satisfies'),
        py: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'),
        go: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'),
        rust: words('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while'),
        java: words('abstract assert break case catch class const continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public record return static super switch synchronized throw throws try var void volatile while'),
        kotlin: words('as break by class companion continue data do else for fun if import in interface internal is object override package private public return suspend throw try typealias val var when while'),
        cs: words('abstract as async await base break case catch class const continue default do else enum event finally for foreach if in interface internal is lock namespace new out override params private protected public readonly record ref return sealed static struct switch throw try typeof using var virtual void while'),
        php: words('abstract and array as break case catch class clone const continue declare default do echo else elseif empty extends final finally fn for foreach function global if implements include instanceof interface isset match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use while yield'),
        ruby: words('begin break case class def do else elsif end ensure for if in module next not or raise redo require require_relative rescue retry return super then unless until when while yield'),
        swift: words('as associatedtype async await break case catch class continue default defer do else enum extension fallthrough for func guard if import in init inout is let protocol return static struct subscript super switch throw throws try var where while'),
        dart: words('abstract as async await break case catch class const continue default do else enum export extends final finally for if implements import in is late library new part required return static super switch throw try typedef var void while with yield'),
        sh: words('case do done elif else esac export fi for function if in local return then while'),
        ps: words('catch else elseif finally for foreach function if param return try while'),
    };

    // Rules are [className, regex]; the first rule that matches at the position wins.
    // An empty className leaves the text plain.
    const R = {
        lineSlash: ['t-c', /\/\/[^\n]*/y],
        lineHash: ['t-c', /#[^\n]*/y],
        block: ['t-c', /\/\*[\s\S]*?(?:\*\/|$)/y],
        triple: ['t-s', /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)/y],
        dq: ['t-s', /"(?:\\[\s\S]|[^"\\\n])*"?/y],
        sq: ['t-s', /'(?:\\[\s\S]|[^'\\\n])*'?/y],
        bt: ['t-s', /`(?:\\[\s\S]|[^`\\])*`?/y],
        rustRaw: ['t-s', /r(#*)"[\s\S]*?"\1/y],
        csVerbatim: ['t-s', /[@$]+"(?:""|[^"])*"?/y],
        number: ['t-n', /(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b/iy],
        decorator: ['t-k', /@[A-Za-z_][\w.]*/y],
        directive: ['t-k', /#[a-z]+\b/y],
        variable: ['t-v', /\$[A-Za-z_][\w]*|\$\{[^}\n]*\}/y],
        flag: ['t-a', /(?<=\s)--?[A-Za-z][\w-]*/y],
        hexColor: ['t-n', /#[\da-f]{3,8}\b/iy],
    };

    const LANGS = {
        js: { rules: [R.lineSlash, R.block, R.bt, R.dq, R.sq, R.decorator, R.number], kw: KEYWORDS.js, jsx: true },
        py: { rules: [R.lineHash, R.triple, R.dq, R.sq, R.decorator, R.number], kw: KEYWORDS.py },
        go: { rules: [R.lineSlash, R.block, R.bt, R.dq, R.sq, R.number], kw: KEYWORDS.go, types: true },
        rust: { rules: [R.lineSlash, R.block, R.rustRaw, R.dq, R.number], kw: KEYWORDS.rust, types: true },
        java: { rules: [R.lineSlash, R.block, R.triple, R.dq, R.sq, R.decorator, R.number], kw: KEYWORDS.java, types: true },
        kotlin: { rules: [R.lineSlash, R.block, R.triple, R.dq, R.sq, R.decorator, R.number], kw: KEYWORDS.kotlin, types: true },
        cs: { rules: [R.lineSlash, R.block, R.triple, R.csVerbatim, R.dq, R.sq, R.number], kw: KEYWORDS.cs, types: true },
        php: { rules: [R.lineSlash, R.lineHash, R.block, R.dq, R.sq, R.variable, R.number], kw: KEYWORDS.php, types: true },
        ruby: { rules: [R.lineHash, R.dq, R.sq, R.number], kw: KEYWORDS.ruby, types: true },
        swift: { rules: [R.lineSlash, R.block, R.triple, R.dq, R.directive, R.decorator, R.number], kw: KEYWORDS.swift, types: true },
        dart: { rules: [R.lineSlash, R.block, R.triple, R.dq, R.sq, R.decorator, R.number], kw: KEYWORDS.dart, types: true },
        sh: { rules: [R.lineHash, R.dq, R.sq, R.variable, R.flag], kw: KEYWORDS.sh, commands: true },
        ps: { rules: [R.lineHash, R.dq, R.sq, R.variable, R.flag], kw: KEYWORDS.ps, commands: true },
    };

    const IDENT = /[A-Za-z_$][\w$]*/y;
    const SPACE = /\s+/y;

    function at(re, text, i) {
        re.lastIndex = i;
        const m = re.exec(text);
        return m && m.index === i && m[0].length ? m[0] : null;
    }

    // ------------------------------------------------------------------
    // Code (C-like and friends)
    // ------------------------------------------------------------------
    function code(text, lang, out, start, end) {
        const L = LANGS[lang];
        let i = start;
        let plain = '';
        let prev = ''; // last significant token, to tell JSX tags from comparisons
        let lineStart = true;
        const flush = () => { if (plain) { out.push(['', plain]); plain = ''; } };
        const emit = (cls, s) => { flush(); out.push([cls, s]); };
        while (i < end) {
            const ch = text[i];
            if (ch === '\n') { plain += ch; i++; lineStart = true; continue; }
            const ws = at(SPACE, text, i);
            if (ws && !ws.includes('\n')) { plain += ws; i += ws.length; continue; }
            let hit = null;
            for (const [cls, re] of L.rules) {
                const s = at(re, text, i);
                if (s && i + s.length <= end) { hit = [cls, s]; break; }
            }
            if (hit) {
                emit(hit[0], hit[1]); i += hit[1].length; prev = 'x'; lineStart = false; continue;
            }
            if (L.jsx && ch === '<' && /[A-Za-z>]/.test(text[i + 1] || '') && (prev === '' || /[(=,?:{};>&|]$/.test(prev) || prev === 'return')) {
                flush();
                i = markup(text, out, i, end, { balanced: true });
                prev = '>'; lineStart = false; continue;
            }
            const id = at(IDENT, text, i);
            if (id) {
                let cls = '';
                if (L.kw.has(id)) cls = 't-k';
                else if (LITERALS.has(id)) cls = 't-l';
                else if (L.commands && lineStart) cls = 't-f';
                else if (/^\s*\(/.test(text.slice(i + id.length, i + id.length + 8))) cls = 't-f';
                else if (L.types && /^[A-Z][a-z]/.test(id)) cls = 't-y';
                if (cls) emit(cls, id); else plain += id;
                i += id.length; prev = id; lineStart = false; continue;
            }
            plain += ch; i++;
            if (!/\s/.test(ch)) { prev = ch; lineStart = false; }
        }
        flush();
        return end;
    }

    // ------------------------------------------------------------------
    // CSS
    // ------------------------------------------------------------------
    const CSS_RULES = [
        ['t-c', /\/\*[\s\S]*?(?:\*\/|$)/y],
        R.dq, R.sq,
        ['t-k', /@[\w-]+/y],
        ['t-a', /--?[A-Za-z][\w-]*(?=\s*:(?!:))|[a-z-]+(?=\s*:[^{};]*;)/y],
        ['t-f', /[\w-]+(?=\()/y],
        R.hexColor,
        ['t-n', /-?\d*\.?\d+(?:%|[a-z]+)?\b/iy],
        ['t-t', /[.#]?[A-Za-z][\w-]*(?=[^{};]*\{)/y],
    ];
    function css(text, out, start, end) { return simple(text, out, start, end, CSS_RULES); }

    // ------------------------------------------------------------------
    // Markdown: headings, links and images, code, emphasis, HTML comments
    // ------------------------------------------------------------------
    const MD_RULES = [
        ['t-c', /<!--[\s\S]*?(?:-->|$)/y],
        ['t-s', /```[\s\S]*?(?:```|$)|`[^`\n]*`/y],
        ['t-k', /(?<=^|\n)#{1,6}[ \t][^\n]*/y],
        ['t-a', /!?\[[^\]\n]*\]/y],
        ['t-s', /(?<=\])\([^)\s]*(?:\s+"[^"\n]*")?\)/y],
        ['t-k', /\*\*[^*\n]+\*\*|__[^_\n]+__/y],
        ['t-v', /(?<=^|\n)[ \t]*(?:[-*+]|\d+\.)(?=[ \t])/y],
    ];

    function simple(text, out, start, end, rules) {
        let i = start;
        let plain = '';
        while (i < end) {
            let hit = null;
            for (const [cls, re] of rules) {
                const s = at(re, text, i);
                if (s && i + s.length <= end) { hit = [cls, s]; break; }
            }
            if (hit) {
                if (plain) { out.push(['', plain]); plain = ''; }
                out.push(hit); i += hit[1].length;
            } else { plain += text[i]; i++; }
        }
        if (plain) out.push(['', plain]);
        return end;
    }

    // ------------------------------------------------------------------
    // Markup: SVG, HTML and component templates (Vue, Svelte, Astro, Blade,
    // Razor, Django). <script> and <style> bodies are highlighted as JS and CSS.
    // ------------------------------------------------------------------
    const ATTR_NAME = /[^\s"'<>/=]+/y;
    const TEMPLATE = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/y;
    const AT_DIRECTIVE = /@[A-Za-z]+/y;

    function markup(text, out, start, end, opts) {
        const balanced = opts && opts.balanced;
        let i = start;
        let depth = 0;
        let plain = '';
        const flush = () => { if (plain) { out.push(['', plain]); plain = ''; } };
        const emit = (cls, s) => { flush(); out.push([cls, s]); };
        while (i < end) {
            const ch = text[i];
            if (ch === '<') {
                if (text.startsWith('<!--', i)) {
                    const j = text.indexOf('-->', i + 4);
                    const stop = j < 0 ? end : Math.min(end, j + 3);
                    emit('t-c', text.slice(i, stop)); i = stop; continue;
                }
                const m = /^<(\/?)([A-Za-z!?][\w:.-]*|)/.exec(text.slice(i, i + 64));
                if (m && (m[2] || (balanced && m[1] === '' && text[i + m[0].length] === '>') || m[1])) {
                    const closing = m[1] === '/';
                    const name = m[2].toLowerCase();
                    emit('t-t', m[0]); i += m[0].length;
                    // attributes
                    let selfClosing = false;
                    while (i < end && text[i] !== '>') {
                        const sp = at(SPACE, text, i);
                        if (sp) { plain += sp; i += sp.length; continue; }
                        if (text.startsWith('/>', i)) { selfClosing = true; break; }
                        if (text.startsWith('?>', i)) break;
                        const q = text[i];
                        if (q === '"' || q === "'") {
                            const j = text.indexOf(q, i + 1);
                            const stop = j < 0 ? end : Math.min(end, j + 1);
                            emit('t-s', text.slice(i, stop)); i = stop; continue;
                        }
                        if (q === '{') { // JSX / Svelte / Astro expression
                            let d = 0; let j = i;
                            for (; j < end; j++) { if (text[j] === '{') d++; else if (text[j] === '}' && --d === 0) break; }
                            const stop = Math.min(end, j + 1);
                            emit('t-v', text.slice(i, stop)); i = stop; continue;
                        }
                        if (q === '=') { plain += q; i++; continue; }
                        const a = at(ATTR_NAME, text, i);
                        if (a) { emit('t-a', a); i += a.length; continue; }
                        plain += q; i++;
                    }
                    if (selfClosing) { emit('t-t', '/>'); i += 2; }
                    else if (text.startsWith('?>', i)) { emit('t-t', '?>'); i += 2; }
                    else if (i < end) { emit('t-t', '>'); i++; }
                    if (balanced && !m[2].startsWith('!')) {
                        if (closing) depth--; else if (!selfClosing) depth++;
                        if (depth <= 0) { flush(); return i; }
                    }
                    if (!closing && !selfClosing && (name === 'script' || name === 'style')) {
                        const close = text.toLowerCase().indexOf('</' + name, i);
                        const stop = close < 0 ? end : Math.min(end, close);
                        flush();
                        if (name === 'script') code(text, 'js', out, i, stop); else css(text, out, i, stop);
                        i = stop;
                    }
                    continue;
                }
            }
            if (ch === '{') {
                const t = at(TEMPLATE, text, i);
                if (t && i + t.length <= end) { emit('t-v', t); i += t.length; continue; }
                if (balanced || (opts && opts.braces)) {
                    let d = 0; let j = i;
                    for (; j < end; j++) { if (text[j] === '{') d++; else if (text[j] === '}' && --d === 0) break; }
                    const stop = Math.min(end, j + 1);
                    emit('t-v', text.slice(i, stop)); i = stop; continue;
                }
            }
            if (ch === '@' && opts && opts.at) {
                const d = at(AT_DIRECTIVE, text, i);
                if (d) { emit('t-k', d); i += d.length; continue; }
            }
            plain += ch; i++;
        }
        flush();
        return end;
    }

    function tokens(text, lang) {
        const out = [];
        if (!text) return out;
        const end = text.length;
        if (lang === 'markup' || lang === 'vue' || lang === 'svelte' || lang === 'astro' || lang === 'blade' || lang === 'razor') {
            let i = 0;
            if (lang === 'astro' && text.startsWith('---')) { // frontmatter
                const close = text.indexOf('\n---', 3);
                if (close > 0) {
                    out.push(['t-c', '---']);
                    code(text, 'js', out, 3, close + 1);
                    out.push(['t-c', '---']);
                    i = close + 4;
                }
            }
            markup(text, out, i, end, { braces: lang === 'svelte' || lang === 'astro', at: lang === 'blade' || lang === 'razor' });
        } else if (lang === 'css') css(text, out, 0, end);
        else if (lang === 'md') simple(text, out, 0, end, MD_RULES);
        else if (LANGS[lang]) code(text, lang, out, 0, end);
        else out.push(['', text]);
        return out;
    }

    function render(el, text, lang) {
        const frag = document.createDocumentFragment();
        for (const [cls, s] of tokens(text, lang)) {
            if (!cls) { frag.appendChild(document.createTextNode(s)); continue; }
            const span = document.createElement('span');
            span.className = cls;
            span.textContent = s;
            frag.appendChild(span);
        }
        el.replaceChildren(frag);
    }

    const BY_EXT = {
        svg: 'markup', html: 'markup', xml: 'markup', vue: 'vue', svelte: 'svelte', astro: 'astro', razor: 'razor',
        css: 'css', md: 'md', markdown: 'md', js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', py: 'py', dart: 'dart', go: 'go', rs: 'rust',
        java: 'java', kt: 'kotlin', cs: 'cs', php: 'php', rb: 'ruby', swift: 'swift', sh: 'sh', ps1: 'ps',
    };
    function langFor(fileName) {
        const name = String(fileName || '').toLowerCase();
        if (name.endsWith('.blade.php')) return 'blade';
        return BY_EXT[name.split('.').pop()] || 'text';
    }

    const api = { render, tokens, langFor, languages: Object.keys(LANGS).concat(['markup', 'vue', 'svelte', 'astro', 'blade', 'razor', 'css', 'md']) };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.SvgHighlight = api;
})(typeof window !== 'undefined' ? window : globalThis);
