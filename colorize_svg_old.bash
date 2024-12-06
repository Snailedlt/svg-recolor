#!/usr/bin/env bash

ARGPARSE_DESCRIPTION="Colorize SVG script"
source $(dirname $0)/submodules/argparse-bash/argparse.bash || exit 1
argparse "$@" <<EOF || exit 1
parser.add_argument('input_svg', help='Input SVG file')
parser.add_argument('output_svg', help='Output SVG file')
parser.add_argument('--color', required=True, help='Color in hex (e.g., #FF5733) or RGB (e.g., 255,125,0) format')
EOF

echo "Input SVG: $INPUT_SVG"
echo "Color: $COLOR"
echo "Output SVG: $OUTPUT_SVG"

# Function to check if color is in hex format
is_hex_color() {
    if [[ $1 =~ ^#?[0-9A-Fa-f]{6}$ ]]; then
        return 0 # true
    else
        return 1 # false
    fi
}

# Function to convert hex to RGB
hex_to_rgb() {
    local hexcolor="$1"
    hexcolor="${hexcolor#\#}" # Remove '#' if present
    local r=$((16#${hexcolor:0:2}))
    local g=$((16#${hexcolor:2:2}))
    local b=$((16#${hexcolor:4:2}))
    echo "$r" "$g" "$b"
}

# Determine if color is hex or RGB and convert if necessary
if is_hex_color "$COLOR"; then
    read RED GREEN BLUE <<<$(hex_to_rgb "$COLOR")
else
    IFS=',' read -r RED GREEN BLUE <<<"$COLOR"
fi

echo "Red: $RED, Green: $GREEN, Blue: $BLUE"

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
