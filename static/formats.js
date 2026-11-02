/* SVG Recolor — code formats.
 *
 * Each format turns the recolored SVG into ready-to-paste code for a language or
 * framework. To add one, add an entry to FORMATS: an id, a label, a group, an
 * icon, the file name to save as, a usage hint and a `code(svg, h)` function.
 * Icons come from icons.js.
 */
(function (global) {
    'use strict';

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    const clean = (svg) => svg.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '').replace(/<!(?:--)[\s\S]*?-->/g, '').trim();
    const indent = (text, n) => text.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');
    const oneLine = (svg) => clean(svg).replace(/\s*\n\s*/g, ' ');
    const dataUri = (svg) => 'data:image/svg+xml,' + encodeURIComponent(oneLine(svg)).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
    const base64 = (svg) => btoa(unescape(encodeURIComponent(svg)));
    const textNodes = (svg) => svg.replace(/<[^>]*>/g, '');
    // Markup that a template language would try to interpret: CSS in <style>,
    // braces or '@' in text. Those formats fall back to injecting the raw string.
    const hasStyle = (svg) => /<style[\s>]/i.test(svg) || /<(?:script)[\s>]/i.test(svg);
    const hasBraces = (svg) => /[{}]/.test(textNodes(svg));
    const templateSafe = (svg) => !hasStyle(svg) && !hasBraces(svg);
    const jsTemplate = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    const addAttr = (svg, attr) => svg.replace(/<svg\b/, '<svg ' + attr);
    const camel = (n) => n.replace(/[-:]([a-z])/g, (m, c) => c.toUpperCase());

    // SVG -> JSX attributes (React style: className, camelCase, style objects).
    function jsxMarkup(svg) {
        return clean(svg).replace(/<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g, (tag, name, attrs, selfClose) => {
            const fixed = attrs.replace(/([\w:-]+)\s*=\s*("[^"]*"|'[^']*')/g, (a, key, val) => {
                if (key === 'class') return 'className=' + val;
                if (key === 'style') {
                    const obj = val.slice(1, -1).split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
                        const i = d.indexOf(':');
                        return i < 0 ? '' : JSON.stringify(camel(d.slice(0, i).trim())) + ': ' + JSON.stringify(d.slice(i + 1).trim());
                    }).filter(Boolean).join(', ');
                    return 'style={{ ' + obj + ' }}';
                }
                if (/^(data|aria)-/.test(key) || key === 'xmlns' || key.startsWith('xmlns:')) return key + '=' + val;
                return camel(key) + '=' + val;
            });
            return '<' + name + fixed + (selfClose ? ' />' : '>');
        });
    }
    function reactComponent(svg, ts) {
        const sig = ts ? 'props: SVGProps<SVGSVGElement>' : 'props';
        const head = ts ? "import type { SVGProps } from 'react';\n\n" : '';
        if (!templateSafe(svg)) {
            return head + 'const svg = `' + jsTemplate(clean(svg)) + '`;\n\n'
                + '// This SVG has CSS or braces, so it is injected as a string.\nexport default function RecoloredIcon(' + (ts ? 'props: React.HTMLAttributes<HTMLSpanElement>' : 'props') + ') {\n'
                + '  return <span {...props} dangerouslySetInnerHTML={{ __html: svg }} />;\n}\n';
        }
        return head + 'export default function RecoloredIcon(' + sig + ') {\n  return (\n' + indent(addAttr(jsxMarkup(svg), '{...props}'), 4) + '\n  );\n}\n';
    }

    // ------------------------------------------------------------------
    // Formats
    // ------------------------------------------------------------------
    const FORMATS = [
        // Basics
        { id: 'svg', label: 'SVG', group: 'Basics', icon: 'svg', file: 'icon.svg', usage: 'Inline it in HTML or save as a file.',
            code: (s) => s },
        { id: 'html', label: 'HTML <img>', group: 'Basics', icon: 'html5', file: 'icon.html', usage: 'No extra file: the SVG is embedded in the src.',
            code: (s) => '<img src="' + dataUri(s) + '" alt="" width="24" height="24">' },
        { id: 'css', label: 'CSS', group: 'Basics', icon: 'css3', file: 'icon.css', usage: 'Add class="icon" to any element.',
            code: (s) => '.icon {\n  width: 24px;\n  height: 24px;\n  background: url("' + dataUri(s) + '") center / contain no-repeat;\n}' },
        { id: 'tailwind', label: 'Tailwind', group: 'Basics', icon: 'tailwindcss', file: 'icon.html', usage: 'Uses an arbitrary background-image value.',
            code: (s) => '<span class="inline-block size-6 bg-contain bg-center bg-no-repeat bg-[url(\'' + dataUri(s) + '\')]"></span>' },
        { id: 'datauri', label: 'Data URI', group: 'Basics', generic: 'datauri', file: 'icon.txt', usage: 'Use as an src, href or CSS url().',
            code: (s) => dataUri(s) },
        { id: 'base64', label: 'Base64', group: 'Basics', generic: 'base64', file: 'icon.b64.txt', usage: 'For data:image/svg+xml;base64,… or APIs that want Base64.',
            code: (s) => base64(s) },
        { id: 'markdown', label: 'Markdown', group: 'Basics', icon: 'markdown', file: 'icon.md', usage: 'Works where Markdown allows data URIs.',
            code: (s) => '![Icon](' + dataUri(s) + ')' },

        // JavaScript
        { id: 'react', label: 'React', group: 'JavaScript', icon: 'react', file: 'RecoloredIcon.jsx', usage: '<RecoloredIcon className="size-6" />',
            code: (s) => reactComponent(s, false) },
        { id: 'react-ts', label: 'React (TS)', group: 'JavaScript', icon: 'typescript', file: 'RecoloredIcon.tsx', usage: '<RecoloredIcon className="size-6" />',
            code: (s) => reactComponent(s, true) },
        { id: 'react-native', label: 'React Native', group: 'JavaScript', icon: 'react', file: 'RecoloredIcon.jsx', usage: 'Needs react-native-svg. <RecoloredIcon width={24} height={24} />',
            code: (s) => "import { SvgXml } from 'react-native-svg';\n\nconst xml = `" + jsTemplate(clean(s)) + "`;\n\nexport default function RecoloredIcon(props) {\n  return <SvgXml xml={xml} {...props} />;\n}\n" },
        { id: 'vue', label: 'Vue', group: 'JavaScript', icon: 'vuedotjs', file: 'RecoloredIcon.vue', usage: '<RecoloredIcon class="size-6" />',
            code: (s) => templateSafe(s)
                ? '<template>\n' + indent(clean(s), 2) + '\n</template>\n'
                : '<script setup>\nconst svg = `' + jsTemplate(clean(s)) + '`;\n<\/script>\n\n<template>\n  <span v-html="svg" />\n</template>\n' },
        { id: 'svelte', label: 'Svelte', group: 'JavaScript', icon: 'svelte', file: 'RecoloredIcon.svelte', usage: '<RecoloredIcon class="size-6" /> (Svelte 5)',
            code: (s) => templateSafe(s)
                ? '<script>\n  let props = $props();\n<\/script>\n\n' + addAttr(clean(s), '{...props}') + '\n'
                : '<script>\n  let props = $props();\n  const svg = `' + jsTemplate(clean(s)) + '`;\n<\/script>\n\n<span {...props}>{@html svg}</span>\n' },
        { id: 'angular', label: 'Angular', group: 'JavaScript', icon: 'angular', file: 'recolored-icon.component.ts', usage: '<app-recolored-icon />',
            code: (s) => (templateSafe(s) && !/@/.test(textNodes(s)))
                ? "import { Component } from '@angular/core';\n\n@Component({\n  selector: 'app-recolored-icon',\n  standalone: true,\n  template: `\n" + indent(jsTemplate(clean(s)), 4) + "\n  `,\n})\nexport class RecoloredIconComponent {}\n"
                : "import { Component, inject } from '@angular/core';\nimport { DomSanitizer } from '@angular/platform-browser';\n\n@Component({\n  selector: 'app-recolored-icon',\n  standalone: true,\n  template: '<span [innerHTML]=\"svg\"></span>',\n})\nexport class RecoloredIconComponent {\n  svg = inject(DomSanitizer).bypassSecurityTrustHtml(`" + jsTemplate(clean(s)) + "`);\n}\n" },
        { id: 'solid', label: 'Solid', group: 'JavaScript', icon: 'solid', file: 'RecoloredIcon.jsx', usage: '<RecoloredIcon class="size-6" />',
            code: (s) => templateSafe(s)
                ? 'export default function RecoloredIcon(props) {\n  return (\n' + indent(addAttr(clean(s), '{...props}'), 4) + '\n  );\n}\n'
                : 'const svg = `' + jsTemplate(clean(s)) + '`;\n\nexport default function RecoloredIcon(props) {\n  return <span {...props} innerHTML={svg} />;\n}\n' },
        { id: 'astro', label: 'Astro', group: 'JavaScript', icon: 'astro', file: 'RecoloredIcon.astro', usage: '<RecoloredIcon class="size-6" />',
            code: (s) => templateSafe(s)
                ? '---\nconst props = Astro.props;\n---\n\n' + addAttr(clean(s), '{...props}') + '\n'
                : '---\nconst svg = `' + jsTemplate(clean(s)) + '`;\n---\n\n<Fragment set:html={svg} />\n' },
        { id: 'lit', label: 'Lit', group: 'JavaScript', icon: 'lit', file: 'recolored-icon.js', usage: '<recolored-icon></recolored-icon>',
            code: (s) => "import { LitElement, html } from 'lit';\n\nclass RecoloredIcon extends LitElement {\n  render() {\n    return html`\n" + indent(jsTemplate(clean(s)), 6) + "\n    `;\n  }\n}\n\ncustomElements.define('recolored-icon', RecoloredIcon);\n" },
        { id: 'webcomponent', label: 'Web Component', group: 'JavaScript', icon: 'webcomponentsdotorg', file: 'recolored-icon.js', usage: 'No framework: <recolored-icon></recolored-icon>',
            code: (s) => 'class RecoloredIcon extends HTMLElement {\n  connectedCallback() {\n    this.innerHTML = `\n' + indent(jsTemplate(clean(s)), 6) + "\n    `;\n  }\n}\n\ncustomElements.define('recolored-icon', RecoloredIcon);\n" },

        // Python
        { id: 'python', label: 'Python', group: 'Python', icon: 'python', file: 'icon.py', usage: 'from icon import RECOLORED_ICON',
            code: (s) => 'RECOLORED_ICON = ' + pyString(clean(s)) + '\n' },
        { id: 'streamlit', label: 'Streamlit', group: 'Python', icon: 'streamlit', file: 'app.py', usage: 'streamlit run app.py',
            code: (s) => 'import base64\n\nimport streamlit as st\n\nICON = ' + pyString(clean(s)) + '\n\nb64 = base64.b64encode(ICON.encode()).decode()\nst.markdown(\n    f\'<img src="data:image/svg+xml;base64,{b64}" width="96">\',\n    unsafe_allow_html=True,\n)\n' },
        { id: 'django', label: 'Django / Jinja', group: 'Python', icon: 'django', file: 'templates/icons/recolored-icon.html', usage: '{% include "icons/recolored-icon.html" %}',
            code: (s) => clean(s) + '\n' },

        // More
        { id: 'blade', label: 'Laravel Blade', group: 'More', icon: 'laravel', file: 'resources/views/components/recolored-icon.blade.php', usage: '<x-recolored-icon class="size-6" />',
            code: (s) => bladeComponent(clean(s)) },
        { id: 'flutter', label: 'Flutter', group: 'More', icon: 'flutter', file: 'lib/recolored_icon.dart', usage: 'Needs flutter_svg. Use recoloredIcon() as a widget.',
            code: (s) => "import 'package:flutter/widgets.dart';\nimport 'package:flutter_svg/flutter_svg.dart';\n\nconst recoloredIconSvg = r'''\n" + clean(s).replace(/'''/g, "''\\'") + "\n''';\n\nWidget recoloredIcon({double size = 24}) =>\n    SvgPicture.string(recoloredIconSvg, width: size, height: size);\n" },
        { id: 'blazor', label: 'Blazor', group: 'More', icon: 'blazor', file: 'RecoloredIcon.razor', usage: '<RecoloredIcon class="size-6" />',
            code: (s) => addAttr(clean(s).replace(/@/g, '@@'), '@attributes="AdditionalAttributes"') + '\n\n@code {\n    [Parameter(CaptureUnmatchedValues = true)]\n    public Dictionary<string, object>? AdditionalAttributes { get; set; }\n}\n' },

        // Anything else: a prompt to paste into an AI agent (built in snippets.js).
        { id: 'ai', label: 'Any framework (AI prompt)', group: 'AI agents', generic: 'sparkles', prompt: true, file: 'prompt.txt',
            keywords: 'chatgpt claude copilot gemini llm other', usage: 'Paste into ChatGPT, Claude, Copilot or any AI agent.',
            code: (s) => s },
    ];
    const GROUPS = ['Basics', 'JavaScript', 'Python', 'More', 'AI agents'];

    // Blade: the SVG body goes inside @verbatim so Blade prints it exactly
    // (no echoes, directives or comments); only the root tag gets {{ $attributes }}.
    function bladeComponent(svg) {
        const root = /<svg\b[^>]*>/i.exec(svg);
        const close = svg.lastIndexOf('</svg>');
        if (!root || close < 0 || /@endverbatim/i.test(svg)) return addAttr(bladeEscape(svg), '{{ $attributes }}') + '\n';
        const start = root.index + root[0].length;
        return addAttr(bladeEscape(svg.slice(0, start)), '{{ $attributes }}')
            + '@verbatim' + svg.slice(start, close) + '@endverbatim' + svg.slice(close) + '\n';
    }
    // Fallback escaping: prefix "{{", "{!!" and directive-like "@word" with "@".
    function bladeEscape(s) {
        return s.replace(/(\{\{|\{!!)|(?<![\w@])@(?=[\w@{])/g, (m, echo) => (echo ? '@' + echo : '@@'));
    }

    function pyString(s) {
        if (!s.includes('"""') && !/\\$/.test(s)) return '"""\\\n' + s.replace(/\\/g, '\\\\') + '\n"""';
        return JSON.stringify(s);
    }

    const byId = Object.fromEntries(FORMATS.map((f) => [f.id, f]));
    global.SvgFormats = {
        list: FORMATS,
        groups: GROUPS,
        get: (id) => byId[id] || byId.svg,
        has: (id) => id in byId,
        icon: (f, size) => global.SvgIcons.render(f, size),
        convert: (id, svg) => (byId[id] || byId.svg).code(svg),
    };
})(typeof window !== 'undefined' ? window : globalThis);
