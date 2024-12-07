import argparse
import subprocess
import tempfile
import os
import sys


# TODO: add support for 3 digit hex colors
# TODO: Move to utils.py
def is_hex_color(color):
    return bool(
        color.startswith("#")
        and len(color) == 7
        and all(c in "0123456789ABCDEFabcdef" for c in color[1:])
    )


# TODO: add support for 3 digit hex colors
# TODO: Move to utils.py
def hex_to_rgb(hexcolor):
    hexcolor = hexcolor.lstrip("#")
    return tuple(int(hexcolor[i : i + 2], 16) for i in (0, 2, 4))


def colorize_svg(input_svg, output_svg, color):
    print(f"Input SVG: {input_svg}")
    print(f"Color: {color}")
    print(f"Output SVG: {output_svg}")

    if is_hex_color(color):
        red, green, blue = hex_to_rgb(color)
    else:
        red, green, blue = map(int, color.split(","))

    print(f"Red: {red}, Green: {green}, Blue: {blue}")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".svg") as temp_grayscale_svg:
        temp_grayscale_svg_path = temp_grayscale_svg.name

    try:
        # Check if input file exists
        if not os.path.isfile(input_svg):
            print(f"Error: Input file '{input_svg}' does not exist.")
            sys.exit(1)

        # TODO: Convert SVG styles to attributes with SVGO (or similar)

        # Convert to grayscale using svgray
        print("Converting to grayscale...")

        with open(temp_grayscale_svg_path, "w") as f:
            subprocess.run(
                [
                    sys.executable,
                    os.path.abspath("./submodules/svgray/.svgray.py"),
                    input_svg,
                ],
                check=True,
                stdout=f,
            )

        # Add color using svgshift
        print("Adding color...")
        with open(output_svg, "w") as f:
            subprocess.run(
                [
                    os.path.abspath("./submodules/svgshift/svgshift.exe"),
                    "addrgb",
                    str(red),
                    str(green),
                    str(blue),
                    temp_grayscale_svg_path,
                ],
                stdout=f,
                check=True,
            )

        print(f"Colorized SVG saved as {output_svg}")

    finally:
        print("Cleaning up...")
        os.remove(temp_grayscale_svg_path)


def main(args=None):
    parser = argparse.ArgumentParser(description="Colorize SVG script")
    parser.add_argument("input_svg", help="Input SVG file")
    parser.add_argument("output_svg", help="Output SVG file")
    parser.add_argument(
        "--color",
        required=True,
        help="Color in hex (e.g., #FF5733) or RGB (e.g., 255,125,0) format",
    )
    args = parser.parse_args(args)
    colorize_svg(args.input_svg, args.output_svg, args.color)


if __name__ == "__main__":
    main()
