# SVG Recolor

[![GitHub license](https://img.shields.io/github/license/Snailedlt/svg-recolor)](https://github.com/Snailedlt/svg-recolor/blob/main/LICENSE)
[![wakatime](https://wakatime.com/badge/github/Snailedlt/svg-recolor.svg)](https://wakatime.com/badge/github/Snailedlt/svg-recolor)
[![ko-fi](https://img.shields.io/badge/Ko--fi-support_me_on-red?logo=ko-fi)](https://ko-fi.com/snailedlt)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-donate-yellow?logo=buymeacoffee)](https://buymeacoffee.com/snailedlt)

[![CI](https://github.com/Snailedlt/svg-recolor/actions/workflows/ci.yml/badge.svg)](https://github.com/Snailedlt/svg-recolor/actions/workflows/ci.yml)

SVG Recolor is a website, HTTP API, MCP server and CLI to recolor SVG files. It is written in Python.

![The SVG Recolor editor](website_screenshot.png)

> [!NOTE]
> Submodules have their own licenses and may or may not be covered by the license of this project. Check the submodule's license for details.

> [!WARNING]
> This project is still under construction and may not be fully functional yet.

## Features

[Website](#website): Use the intuitive web interface to recolor SVG files without any setup.
[API](#api): Integrate SVG recoloring into your applications with ease.
[CLI Tool](#cli-tool): Recolor SVG files directly from your terminal with this Python script.
[Legacy Shell Script](#legacy-shell-script): Same as above, but with a shell script (not maintained).

## Usage

### Website

The website is hosted at [svg-recolor.jorgenkh.no](https://svg-recolor.jorgenkh.no) and requires no installation.

### Modes

| Mode | What it does | Powered by |
| --- | --- | --- |
| `tint` (default) | Grayscale, then add the color. Dark areas take the color, highlights stay light. | svgray + `svgshift addrgb` |
| `colorize` | Set hue and saturation to the color, keep each shade's lightness. | `svgshift sethsl H S x` |
| `hue` | Set only the hue. | `svgshift sethsl H x x` |
| `solid` | Replace every color with the target color. | `svgshift setrgb R G B` |
| `grayscale` | Convert to grayscale. | svgray |
| `adjust` | Keep the colors, only apply the fine-tuning below. | `svgshift addhsl/subhsl` |

Every mode can be fine-tuned with `hue` (rotate, -360..360 degrees), `saturation` and `lightness` (-100..100).

Before recoloring, colors are normalized so the tools can handle them: CSS color names, `rgb()`/`hsl()`
(with alpha), and 3/4-digit hex are converted to hex, and icons that rely on the default black fill
(or `currentColor`) get an explicit black so they recolor too. `url(#id)` and `href="#id"` references are left alone.

Colors can be given as `ff0066`, `#ff0066`, `f06`, `255,0,102`, `rgb(255 0 102)`, `hsl(330 100% 50%)` or a CSS name like `tomato`.

### API

The API is hosted at the same URL as the website. Interactive docs: [Swagger](https://svg-recolor.jorgenkh.no/docs) or [ReDoc](https://svg-recolor.jorgenkh.no/redoc).

| Endpoint | Description |
| --- | --- |
| `GET /api/recolor?url=…` | Recolor an SVG from a public link (GitHub file pages are converted to raw links). Cacheable, so it works as an `<img src>`. |
| `POST /api/recolor` | Recolor an SVG sent as a multipart `file` field, a multipart `url` field, or the raw request body. |
| `POST /api/recolor/batch` | Recolor up to 50 files (`files` fields) with the same settings and get a ZIP back. |
| `GET /api/palette?url=…` / `POST /api/palette` | List the colors in an SVG with their counts. |
| `GET /api/modes` | List the modes and option ranges. |
| `POST /colorize` | Original endpoint, kept for backwards compatibility. |

Query parameters for the recolor endpoints: `color`, `mode`, `hue`, `saturation`, `lightness`,
`format` (`svg` or `json`, which also returns the old→new color mapping) and `download`.

```sh
# Upload a file
curl -X POST "https://svg-recolor.jorgenkh.no/api/recolor?color=ff0066&mode=colorize" \
  -F "file=@icon.svg" -o icon-pink.svg

# Send the SVG as the request body
curl -X POST "https://svg-recolor.jorgenkh.no/api/recolor?color=tomato&mode=solid" \
  -H "Content-Type: image/svg+xml" --data-binary @icon.svg -o icon-red.svg

# Recolor from a link
curl "https://svg-recolor.jorgenkh.no/api/recolor?url=https://example.com/icon.svg&mode=hue&color=teal" -o icon.svg

# Many files at once
curl -X POST "https://svg-recolor.jorgenkh.no/api/recolor/batch?mode=grayscale" \
  -F "files=@a.svg" -F "files=@b.svg" -o recolored.zip
```

```html
<!-- Use it directly as an image -->
<img src="https://svg-recolor.jorgenkh.no/api/recolor?url=https://example.com/icon.svg&color=ff0066&mode=solid" alt="">
```

The `POST` endpoints also accept JSON, which is the easiest format for scripts and agents:

```sh
curl -X POST "https://svg-recolor.jorgenkh.no/api/recolor?format=json" \
  -H "Content-Type: application/json" \
  -d '{"svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"4\"/></svg>", "color": "tomato", "mode": "solid"}'
```

### AI agents

- **MCP server** (streamable HTTP, no auth) at `/mcp` with the tools `recolor_svg`, `list_svg_colors` and `list_recolor_modes`:

  ```sh
  claude mcp add --transport http svg-recolor https://svg-recolor.jorgenkh.no/mcp
  ```

- **[`/llms.txt`](https://svg-recolor.jorgenkh.no/llms.txt)**: a plain-text guide to the endpoints, parameters and modes.
- **[`/api`](https://svg-recolor.jorgenkh.no/api)**: a JSON index of the endpoints. The [OpenAPI spec](https://svg-recolor.jorgenkh.no/openapi.json) has stable operation IDs (`recolorSvg`, `recolorFromUrl`, ...).

### Recolor just colors

`GET /api/map-colors?colors=5a9fd4,306998&color=tomato&mode=colorize` returns `{"mapping": {"#5a9fd4": "#…"}}`.
Useful for design tokens and themes. It is also what the website uses: the browser extracts the SVG's
palette, asks this endpoint for the new colors, and applies them locally, so the SVG itself is never uploaded.

### Hosting and scaling

The service is built to stay cheap under load:

- The website sends only an SVG's palette (a few hex colors) to `GET /api/map-colors`. With `v=<engine version>`
  the response is cacheable for a year (`s-maxage`), so the CDN answers repeat palettes without running the function.
  The result is byte-for-byte the same as `POST /api/recolor`.
- Results are cached per color and setting inside each warm instance, so svgray/svgshift rarely run twice for the same color.
- The page, static files, docs and linked-SVG responses all send `s-maxage`/`stale-while-revalidate`,
  and CSS/JS URLs carry a content hash.
- Bump `ENGINE_VERSION` in `recolor.py` whenever the color math changes, so cached mappings are not reused.

### Website tips

- The page URL keeps your settings (`?mode=colorize&color=ff0066&url=...`), so you can bookmark or share a setup. Opening a link with `url=` loads that SVG.
- Everything fits on one screen: settings on the left, and Preview, Code and API tabs on the right, with Share, Copy and Download always visible.
- Settings follow the order the engine applies them: **1 Style** (each tile shows your SVG in that style), **2 Color** (only for
  styles that use one) and **3 Adjust** (hue, saturation and lightness, applied last to any style). The "Original" style keeps
  the colors so only Adjust changes them (`mode=adjust` in the API).
- The **Code** tab lists every format beside the code and turns the result into ready-to-paste code for 23 targets, and Download saves it with the right file name:
  - Basics: SVG, HTML `<img>`, CSS, Tailwind, data URI, Base64, Markdown
  - JavaScript: React, React (TS), React Native, Vue, Svelte, Angular, Solid, Astro, Lit, Web Component
  - Python: Python, Streamlit, Django / Jinja
  - More: Laravel Blade, Flutter, Blazor

- The **API** tab turns your settings into a ready-to-run request in 20 languages and clients: curl, HTTPie, PowerShell,
  a hotlink URL, HTML, fetch, Node.js, axios, Python requests and httpx, Go, Rust, Java, Kotlin, C#, PHP, Ruby, Swift,
  Dart, plus MCP setup.
- Need something else? Pick **AI prompt** in either tab (or search for your language) and type a language or framework.
  You get a prompt to paste into ChatGPT, Claude, Copilot or any AI agent: for the Code tab it includes the recolored SVG,
  for the API tab it describes the endpoint, settings, responses and errors.

  Press <kbd>F</kbd> to search formats or languages. Code formats live in [`static/formats.js`](static/formats.js) and API snippets in [`static/snippets.js`](static/snippets.js); adding one is a single entry.
  SVGs with embedded CSS or braces are inserted as a string for the template languages that would otherwise interpret them.
- Compare before and after side by side or with a slider.
- Press <kbd>?</kbd> for keyboard shortcuts: <kbd>1</kbd>-<kbd>6</kbd> pick a mode, <kbd>P</kbd>/<kbd>E</kbd>/<kbd>A</kbd> switch tabs, <kbd>Ctrl</kbd>+<kbd>S</kbd> downloads, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> copies.

### CLI Tool

Clone the repository (with submodules) and run `colorize_svg.py` with Python.

```sh
python colorize_svg.py path/to/input.svg path/to/output.svg --color "255,0,0"
python colorize_svg.py input.svg output.svg --color seagreen --mode colorize
python colorize_svg.py input.svg output.svg --mode adjust --hue 45 --lightness -10
python colorize_svg.py input.svg --palette
```

### Legacy Shell Script

Download `colorize_svg.sh` and run it in your terminal.

Example Usage:

```bash
# Recolor the input SVG file to red and save it to the output file using RGB color values
./colorize_svg.sh "example-input-svgs/input.svg" tmp/output.svg --color "255,0,0"

# Recolor the input SVG file to red and save it to the output file using hex color values
./colorize_svg.sh "example-input-svgs/input.svg" tmp/output.svg --color "#FF0000"
```

## Contributing

See any bugs or missing features? Feel free to open an issue or submit a pull request, I'm open to anything!
Check out [Local Development](#local-development) for more information on how to set up the project locally.

Other ways to contribute:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/H2H0GY0OU)
<!--markdownlint-disable-next-line MD033 -->
<a href="https://www.buymeacoffee.com/snailedlt" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## Local Development

### Requirements

- Python 3.10 or higher
- [Pipenv](https://pipenv.pypa.io/en/latest/)

### Installation

Clone the repository (with submodules) and install the dependencies using pipenv.

```sh
git clone --recurse-submodules https://github.com/Snailedlt/svg-recolor.git
cd svg-recolor
pipenv install
```

Compile svgshift (a submodule) by running the following command
Replace `<your-environment>` with your environment (e.g. windows, linux).

```sh
gcc submodules/svgshift/svgshift.c -o svgshift-<your-environment>.exe
```

### Running the API

To run the API, use the following command:

```sh
pipenv run dev
```

### Running the CLI Tool

If you wish to run the CLI without downloading the required dependencies to a separate virtual env, you can use the following command:

```sh
pipenv run colorize path/to/input.svg path/to/output.svg --color "255,0,0"
```

### Project layout

| Path | What it is |
| --- | --- |
| `recolor.py` | The engine: color normalization, palette, modes, svgray/svgshift wrappers, per-color cache |
| `main.py` | FastAPI app: website, recolor/palette/map-colors endpoints, cache headers |
| `server/` | `common.py` (shared helpers, cache policy), `fetching.py` (safe link downloads), `agents.py` (`/llms.txt`, `/mcp`) |
| `main.html`, `static/` | The editor: `engine.js` (browser twin of the engine), `formats.js` (code formats), `snippets.js` (API examples), `icons.js`, `app.js`, `app.css` |
| `colorize_svg.py` | CLI |
| `tests/` | pytest suite, plus `tests/js` for the browser scripts |
| `showcase/` | Builds a standalone demo page of the editor |

### Tests

```sh
pip install pytest          # once
pytest -q                   # engine, API, MCP, and browser/server engine parity (needs Node.js)
```

```sh
cd tests/js && npm ci && npm test   # code formats compile with their real toolchains; API snippets
```

CI runs both on every push and pull request (`.github/workflows/ci.yml`), using the versions in `Pipfile.lock`.
`tests/test_parity.py` keeps `static/engine.js` and `recolor.py` byte-for-byte identical; if you change one, change the other.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SENTRY_DSN` | the project DSN | Set to an empty string to disable Sentry |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.05` | Share of requests traced |
| `SENTRY_PROFILING` | off | `1` enables continuous profiling |
| `SVG_RECOLOR_DEV` | off | `1` re-reads `main.html` on every request (handy while editing) |

### Deploying (Vercel)

- `vercel.json` routes everything to `main.py`; the CDN caches responses that send `s-maxage`
  (the page, static files, docs, linked SVGs and `/api/map-colors?v=...`). After a deploy, a repeated
  `/api/map-colors` request should answer with `x-vercel-cache: HIT`.
- Submodules must be checked out: `submodules/svgray/.svgray.py` is imported at runtime.
- `svgshift-linux.exe` is committed as executable. If a platform drops the bit, the engine copies it to a
  temp folder and marks it executable, or compiles it from `submodules/svgshift` when gcc is available.
- Rate limiting is best done at the edge (for example a Vercel Firewall rate-limit rule on `/api/*` and `/mcp`).

### Showcase page

`python showcase/build.py` (needs Pillow) writes a single self-contained HTML file of the editor to
`showcase/dist/`. It inlines everything and runs the color math in the browser, so it works without the server.

## Credits

Framework and language icons are from [Simple Icons](https://simpleicons.org) (CC0).
