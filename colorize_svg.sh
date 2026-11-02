#!/usr/bin/env bash
# Recolor an SVG from the shell. Same interface as the original shell script:
#
#   ./colorize_svg.sh input.svg output.svg --color "#FF0000"
#   ./colorize_svg.sh input.svg output.svg --color "255,0,0"
#
# It runs the Python CLI (colorize_svg.py) in "tint" mode, which is what the
# original script did: grayscale with svgray, then add the color with svgshift.
# Any other option of the Python CLI works too, e.g. --mode colorize --hue 30.
set -euo pipefail
cd "$(dirname "$0")" >/dev/null
here=$(pwd)
cd - >/dev/null

if [ $# -lt 2 ]; then
    echo "usage: $0 input.svg output.svg --color <#hex|r,g,b> [--mode tint|colorize|hue|solid|grayscale|adjust] [...]" >&2
    exit 2
fi

mode_given=false
for arg in "$@"; do [ "$arg" = "--mode" ] && mode_given=true; done
extra=()
$mode_given || extra=(--mode tint)

python=${PYTHON:-python3}
command -v "$python" >/dev/null || python=python
exec "$python" "$here/colorize_svg.py" "$@" "${extra[@]}"
