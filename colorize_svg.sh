#!/bin/bash

# Usage function
usage() {
    echo "Usage: $0 <input_svg> <red> <green> <blue> <output_svg>"
    echo "Example: $0 input.svg 255 0 0 output.svg"
    exit 1
}

# Check if we have the correct number of arguments
if [ "$#" -ne 5 ]; then
    usage
fi

input_svg="$1"
red="$2"
green="$3"
blue="$4"
output_svg="$5"

# print all arguments
echo "Input SVG: $input_svg"
echo "Red: $red"
echo "Green: $green"
echo "Blue: $blue"
echo "Output SVG: $output_svg"

temp_grayscale_svg=$(mktemp)

# Check if input file exists
if [ ! -f "$input_svg" ]; then
    echo "Error: Input file '$input_svg' does not exist."
    exit 1
fi

# Convert to grayscale
echo "Converting to grayscale..."
./submodules/svgray/svgray -o "$temp_grayscale_svg" "$input_svg"

# Add color using svgshift
echo "Adding color..."
./submodules/svgshift/svgshift.exe addrgb "$red" "$green" "$blue" "$temp_grayscale_svg" >"$output_svg"

echo "Colorized SVG saved as $output_svg"
