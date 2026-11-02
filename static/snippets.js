/* SVG Recolor — API snippets and AI prompts.
 *
 * Each snippet turns the current settings into runnable code for calling the API.
 * `code(c)` receives a context:
 *   c.site     base URL                        c.query   "color=ff0066&mode=tint"
 *   c.params   { color, mode, hue?, ... }      c.getUrl  GET link for a linked SVG
 *   c.input    input file name                 c.output  output file name
 * Most languages send the SVG as the raw request body (Content-Type: image/svg+xml),
 * which needs no JSON or multipart library.
 */
(function (global) {
    'use strict';

    const json = (o) => JSON.stringify(o);
    const recolorUrl = (c) => c.site + '/api/recolor?' + c.query;

    const SNIPPETS = [
        // Quick
        { id: 'curl', lang: 'sh', label: 'curl', group: 'Command line', icon: 'curl',
            code: (c) => '# Upload a file\ncurl -X POST "' + recolorUrl(c) + '" \\\n  -F "file=@' + c.input + '" \\\n  -o ' + c.output
                + '\n\n# Or send JSON and get the color mapping back too\ncurl -X POST "' + c.site + '/api/recolor?format=json" \\\n  -H "Content-Type: application/json" \\\n  -d \'' + json(Object.assign({ svg: '<svg …>' }, c.params)) + '\'' },
        { id: 'httpie', lang: 'sh', label: 'HTTPie', group: 'Command line', icon: 'httpie',
            code: (c) => 'http --ignore-stdin --form POST ' + c.site + '/api/recolor ' + Object.entries(c.params).map(([k, v]) => k + '==' + v).join(' ') + ' file@' + c.input + ' > ' + c.output },
        { id: 'powershell', lang: 'ps', label: 'PowerShell', group: 'Command line', generic: 'terminal',
            code: (c) => 'Invoke-WebRequest -Method Post `\n  -Uri "' + recolorUrl(c) + '" `\n  -ContentType "image/svg+xml" `\n  -InFile "' + c.input + '" `\n  -OutFile "' + c.output + '"' },
        { id: 'link', lang: 'text', label: 'Link', group: 'Command line', generic: 'link',
            code: (c) => '# Recolor a linked SVG (cached, safe to hotlink)\n' + c.getUrl },
        { id: 'html', lang: 'markup', label: 'HTML <img>', group: 'Command line', icon: 'html5',
            code: (c) => '<\!-- Use the API directly as an image -->\n<img src="' + c.getUrl + '" alt="">' },

        // JavaScript
        { id: 'fetch', lang: 'js', label: 'fetch (browser)', group: 'JavaScript', icon: 'javascript',
            code: (c) => "// file: a File from <input type=\"file\"> or a Blob\nconst form = new FormData();\nform.append('file', file);\n\nconst res = await fetch('" + recolorUrl(c) + "', {\n  method: 'POST',\n  body: form,\n});\nif (!res.ok) throw new Error((await res.json()).detail);\nconst svg = await res.text();" },
        { id: 'node', lang: 'js', label: 'Node.js', group: 'JavaScript', icon: 'nodedotjs',
            code: (c) => "// Node 18+, no dependencies\nimport { readFile, writeFile } from 'node:fs/promises';\n\nconst res = await fetch('" + recolorUrl(c) + "', {\n  method: 'POST',\n  headers: { 'Content-Type': 'image/svg+xml' },\n  body: await readFile('" + c.input + "'),\n});\nif (!res.ok) throw new Error((await res.json()).detail);\nawait writeFile('" + c.output + "', await res.text());" },
        { id: 'axios', lang: 'js', label: 'axios', group: 'JavaScript', icon: 'axios',
            code: (c) => "import axios from 'axios';\nimport { readFile, writeFile } from 'node:fs/promises';\n\nconst { data } = await axios.post(\n  '" + c.site + "/api/recolor',\n  { svg: await readFile('" + c.input + "', 'utf8'), " + Object.entries(c.params).map(([k, v]) => k + ': ' + json(v)).join(', ') + " },\n  { responseType: 'text' },\n);\nawait writeFile('" + c.output + "', data);" },

        // Python
        { id: 'requests', lang: 'py', label: 'requests', group: 'Python', icon: 'python',
            code: (c) => 'import requests\n\nwith open("' + c.input + '", "rb") as f:\n    res = requests.post(\n        "' + c.site + '/api/recolor",\n        params=' + pyDict(c.params) + ',\n        files={"file": f},\n    )\nres.raise_for_status()\n\nwith open("' + c.output + '", "wb") as f:\n    f.write(res.content)' },
        { id: 'httpx', lang: 'py', label: 'httpx (async)', group: 'Python', icon: 'python',
            code: (c) => 'import asyncio\nfrom pathlib import Path\n\nimport httpx\n\n\nasync def main() -> None:\n    async with httpx.AsyncClient() as client:\n        res = await client.post(\n            "' + c.site + '/api/recolor",\n            json={"svg": Path("' + c.input + '").read_text(), **' + pyDict(c.params) + '},\n        )\n        res.raise_for_status()\n        Path("' + c.output + '").write_text(res.text)\n\n\nasyncio.run(main())' },

        // More languages
        { id: 'go', lang: 'go', label: 'Go', group: 'More languages', icon: 'go',
            code: (c) => 'package main\n\nimport (\n\t"io"\n\t"log"\n\t"net/http"\n\t"os"\n)\n\nfunc main() {\n\tsvg, err := os.Open("' + c.input + '")\n\tif err != nil {\n\t\tlog.Fatal(err)\n\t}\n\tdefer svg.Close()\n\n\tres, err := http.Post("' + recolorUrl(c) + '", "image/svg+xml", svg)\n\tif err != nil {\n\t\tlog.Fatal(err)\n\t}\n\tdefer res.Body.Close()\n\n\tbody, err := io.ReadAll(res.Body)\n\tif err != nil {\n\t\tlog.Fatal(err)\n\t}\n\tif res.StatusCode != http.StatusOK {\n\t\tlog.Fatalf("recolor failed: %s", body)\n\t}\n\tif err := os.WriteFile("' + c.output + '", body, 0o644); err != nil {\n\t\tlog.Fatal(err)\n\t}\n}' },
        { id: 'rust', lang: 'rust', label: 'Rust', group: 'More languages', icon: 'rust',
            code: (c) => '// Cargo.toml: reqwest = { version = "0.12", features = ["blocking"] }\nuse std::fs;\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let svg = fs::read_to_string("' + c.input + '")?;\n    let res = reqwest::blocking::Client::new()\n        .post("' + recolorUrl(c) + '")\n        .header("Content-Type", "image/svg+xml")\n        .body(svg)\n        .send()?;\n    if !res.status().is_success() {\n        return Err(res.text()?.into());\n    }\n    fs::write("' + c.output + '", res.text()?)?;\n    Ok(())\n}' },
        { id: 'java', lang: 'java', label: 'Java', group: 'More languages', icon: 'openjdk',
            code: (c) => 'import java.net.URI;\nimport java.net.http.HttpClient;\nimport java.net.http.HttpRequest;\nimport java.net.http.HttpResponse;\nimport java.nio.file.Files;\nimport java.nio.file.Path;\n\npublic class Recolor {\n    public static void main(String[] args) throws Exception {\n        HttpRequest request = HttpRequest.newBuilder(URI.create("' + recolorUrl(c) + '"))\n            .header("Content-Type", "image/svg+xml")\n            .POST(HttpRequest.BodyPublishers.ofFile(Path.of("' + c.input + '")))\n            .build();\n        HttpResponse<String> response = HttpClient.newBuilder()\n            .version(HttpClient.Version.HTTP_1_1) // plain-HTTP servers may reject HTTP/2 upgrades\n            .build()\n            .send(request, HttpResponse.BodyHandlers.ofString());\n        if (response.statusCode() != 200) {\n            throw new RuntimeException(response.body());\n        }\n        Files.writeString(Path.of("' + c.output + '"), response.body());\n    }\n}' },
        { id: 'kotlin', lang: 'kotlin', label: 'Kotlin', group: 'More languages', icon: 'kotlin',
            code: (c) => 'import java.net.URI\nimport java.net.http.HttpClient\nimport java.net.http.HttpRequest\nimport java.net.http.HttpResponse\nimport java.nio.file.Files\nimport java.nio.file.Path\n\nfun main() {\n    val request = HttpRequest.newBuilder(URI.create("' + recolorUrl(c).replace(/\$/g, '\\$') + '"))\n        .header("Content-Type", "image/svg+xml")\n        .POST(HttpRequest.BodyPublishers.ofFile(Path.of("' + c.input + '")))\n        .build()\n    val response = HttpClient.newBuilder()\n        .version(HttpClient.Version.HTTP_1_1) // plain-HTTP servers may reject HTTP/2 upgrades\n        .build()\n        .send(request, HttpResponse.BodyHandlers.ofString())\n    check(response.statusCode() == 200) { response.body() }\n    Files.writeString(Path.of("' + c.output + '"), response.body())\n}' },
        { id: 'csharp', lang: 'cs', label: 'C#', group: 'More languages', icon: 'dotnet',
            code: (c) => '// .NET 6+ (top-level statements)\nusing System.Net.Http.Headers;\n\nusing var http = new HttpClient();\nusing var content = new StreamContent(File.OpenRead("' + c.input + '"));\ncontent.Headers.ContentType = new MediaTypeHeaderValue("image/svg+xml");\n\nvar res = await http.PostAsync("' + recolorUrl(c) + '", content);\nvar body = await res.Content.ReadAsStringAsync();\nif (!res.IsSuccessStatusCode) throw new Exception(body);\nawait File.WriteAllTextAsync("' + c.output + '", body);' },
        { id: 'php', lang: 'php', label: 'PHP', group: 'More languages', icon: 'php',
            code: (c) => "<?php\n$ch = curl_init('" + recolorUrl(c) + "');\ncurl_setopt_array($ch, [\n    CURLOPT_POST => true,\n    CURLOPT_HTTPHEADER => ['Content-Type: image/svg+xml'],\n    CURLOPT_POSTFIELDS => file_get_contents('" + c.input + "'),\n    CURLOPT_RETURNTRANSFER => true,\n]);\n$svg = curl_exec($ch);\nif (curl_getinfo($ch, CURLINFO_RESPONSE_CODE) !== 200) {\n    throw new RuntimeException($svg);\n}\nfile_put_contents('" + c.output + "', $svg);" },
        { id: 'ruby', lang: 'ruby', label: 'Ruby', group: 'More languages', icon: 'ruby',
            code: (c) => 'require "net/http"\n\nuri = URI("' + recolorUrl(c) + '")\nres = Net::HTTP.post(uri, File.read("' + c.input + '"), "Content-Type" => "image/svg+xml")\nraise res.body unless res.is_a?(Net::HTTPSuccess)\n\nFile.write("' + c.output + '", res.body)' },
        { id: 'swift', lang: 'swift', label: 'Swift', group: 'More languages', icon: 'swift',
            code: (c) => 'import Foundation\n#if canImport(FoundationNetworking)\nimport FoundationNetworking // Linux\n#endif\n\nvar request = URLRequest(url: URL(string: "' + recolorUrl(c) + '")!)\nrequest.httpMethod = "POST"\nrequest.setValue("image/svg+xml", forHTTPHeaderField: "Content-Type")\n\nlet (data, response) = try await URLSession.shared.upload(\n    for: request, fromFile: URL(fileURLWithPath: "' + c.input + '"))\nguard (response as? HTTPURLResponse)?.statusCode == 200 else {\n    fatalError(String(decoding: data, as: UTF8.self))\n}\ntry data.write(to: URL(fileURLWithPath: "' + c.output + '"))' },
        { id: 'dart', lang: 'dart', label: 'Dart', group: 'More languages', icon: 'dart',
            code: (c) => "// pubspec.yaml: http: ^1.2.0\nimport 'dart:io';\n\nimport 'package:http/http.dart' as http;\n\nFuture<void> main() async {\n  final res = await http.post(\n    Uri.parse('" + recolorUrl(c).replace(/\$/g, '\\$') + "'),\n    headers: {'Content-Type': 'image/svg+xml'},\n    body: await File('" + c.input + "').readAsString(),\n  );\n  if (res.statusCode != 200) throw Exception(res.body);\n  await File('" + c.output + "').writeAsString(res.body);\n}" },

        // AI
        { id: 'mcp', lang: 'sh', label: 'MCP server', group: 'AI agents', generic: 'plug',
            code: (c) => '# Claude Code\nclaude mcp add --transport http svg-recolor ' + c.site + '/mcp\n\n# Other MCP clients (JSON config)\n{\n  "mcpServers": {\n    "svg-recolor": { "type": "http", "url": "' + c.site + '/mcp" }\n  }\n}\n\n# Then ask your agent, for example:\n# "Recolor ' + c.input + ' with svg-recolor: ' + Object.entries(c.params).map(([k, v]) => k + ' ' + v).join(', ') + '"' },
        { id: 'ai', lang: 'text', label: 'Any language (AI prompt)', group: 'AI agents', generic: 'sparkles', prompt: true, keywords: 'chatgpt claude copilot gemini llm other',
            code: (c) => apiPrompt(c) },
    ];
    const GROUPS = ['Command line', 'JavaScript', 'Python', 'More languages', 'AI agents'];

    function pyDict(o) {
        return '{' + Object.entries(o).map(([k, v]) => JSON.stringify(k) + ': ' + JSON.stringify(v)).join(', ') + '}';
    }

    // Prompt for an AI agent to write API client code in any language.
    function apiPrompt(c) {
        const lang = (c.target || '').trim() || '[your language or framework]';
        const settings = Object.entries(c.params).map(([k, v]) => k + '=' + v).join(', ');
        return 'Write ' + lang + ' code that recolors an SVG file with the SVG Recolor HTTP API.\n\n'
            + 'About the API (free, no API key):\n'
            + '- Request: POST ' + recolorUrl(c) + '\n'
            + '  Send the SVG as the raw request body with "Content-Type: image/svg+xml".\n'
            + '  A multipart form field "file", or JSON {"svg": "<svg …>", "color": …, "mode": …}, also work.\n'
            + '- Response: the recolored SVG as text (image/svg+xml). Adding format=json returns\n'
            + '  {"svg": "…", "palette": [{"from": "#…", "to": "#…", "count": 1}]} instead.\n'
            + '- Errors: JSON {"detail": "message"} with status 400 (bad input), 413 (over 2 MB),\n'
            + '  415 (not an SVG) or 422 (invalid parameter).\n'
            + '- Settings to use: ' + settings + '.\n'
            + '- Full reference: ' + c.site + '/llms.txt and ' + c.site + '/openapi.json\n\n'
            + 'Requirements:\n'
            + '- Read the input file (default "' + c.input + '") and write the result to "' + c.output + '".\n'
            + '- Use the standard or most popular HTTP client for ' + lang + ', and list any packages to install.\n'
            + '- Check the status code and show the "detail" message when a request fails.\n'
            + '- Keep it short and idiomatic, and include how to run it.';
    }

    // Prompt for an AI agent to turn the recolored SVG into a component.
    function codePrompt(target, svg, fileName) {
        const t = (target || '').trim() || '[your framework or language]';
        const big = svg.length > 30000;
        return 'Turn the SVG below into a reusable icon for ' + t + ' (a component, or the idiomatic equivalent).\n\n'
            + 'Requirements:\n'
            + '- Keep every color, path and attribute that affects rendering exactly as it is.\n'
            + '- Let callers set the size and class/style, and pass through other attributes where ' + t + ' supports it.\n'
            + '- Make it accessible: decorative by default (aria-hidden), with an optional title for screen readers.\n'
            + '- Tell me what to name the file and show a short usage example.\n\n'
            + (big
                ? 'The SVG is large (' + Math.round(svg.length / 1024) + ' KB), so I attached it as "' + fileName + '".\n'
                : 'SVG:\n```svg\n' + svg.trim() + '\n```\n');
    }

    const byId = Object.fromEntries(SNIPPETS.map((s) => [s.id, s]));
    global.SvgSnippets = {
        list: SNIPPETS,
        groups: GROUPS,
        get: (id) => byId[id] || byId.curl,
        has: (id) => id in byId,
        icon: (s, size) => global.SvgIcons.render(s, size),
        build: (id, ctx) => (byId[id] || byId.curl).code(ctx),
        codePrompt,
    };
})(typeof window !== 'undefined' ? window : globalThis);
