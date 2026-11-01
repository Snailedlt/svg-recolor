# SVG Recolor

[![GitHub license](https://img.shields.io/github/license/Snailedlt/svg-recolor)](https://github.com/Snailedlt/svg-recolor/blob/main/LICENSE)
[![wakatime](https://wakatime.com/badge/github/Snailedlt/svg-recolor.svg)](https://wakatime.com/badge/github/Snailedlt/svg-recolor)
[![ko-fi](https://img.shields.io/badge/Ko--fi-support_me_on-red?logo=ko-fi)](https://ko-fi.com/snailedlt)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-donate-yellow?logo=buymeacoffee)](https://buymeacoffee.com/snailedlt)

SVG Recolor is a simple CLI tool, API and website to recolor SVG files. It is written in python.

<!-- ![website](website_screenshot.png) -->

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

Clone the repository and install the dependencies using pipenv.

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
# Update the dependencies if you haven't already
pipenv update
pipenv run colorize path/to/input.svg path/to/output.svg --color "255,0,0"
```
