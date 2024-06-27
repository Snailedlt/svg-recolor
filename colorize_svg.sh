#!/usr/bin/env bash

ARGPARSE_DESCRIPTION="Colorize SVG script"
source $(dirname $0)/submodules/argparse-bash/argparse.bash || exit 1
argparse "$@" <<EOF || exit 1
parser.add_argument('input_svg', help='Input SVG file')
parser.add_argument('red', help='Red component (0-255)', type=int)
parser.add_argument('green', help='Green component (0-255)', type=int)
parser.add_argument('blue', help='Blue component (0-255)', type=int)
parser.add_argument('output_svg', help='Output SVG file')
EOF

echo "Input SVG: $INPUT_SVG"
echo "Red: $RED"
echo "Green: $GREEN"
echo "Blue: $BLUE"
echo "Output SVG: $OUTPUT_SVG"

temp_grayscale_svg=$(mktemp)

# Check if input file exists
if [ ! -f "$INPUT_SVG" ]; then
    echo "Error: Input file '$INPUT_SVG' does not exist."
    exit 1
fi

# Convert to grayscale
echo "Converting to grayscale..."
./submodules/svgray/svgray -o "$temp_grayscale_svg" "$INPUT_SVG"

# Add color using svgshift
echo "Adding color..."
./submodules/svgshift/svgshift.exe addrgb "$RED" "$GREEN" "$BLUE" "$temp_grayscale_svg" >"$OUTPUT_SVG"

echo "Colorized SVG saved as $OUTPUT_SVG"
