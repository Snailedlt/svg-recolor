"""Command-line interface for SVG Recolor.

Examples:
    python colorize_svg.py icon.svg icon-pink.svg --color "#ff0066"
    python colorize_svg.py icon.svg icon-green.svg --color seagreen --mode colorize
    python colorize_svg.py logo.svg logo-shifted.svg --mode adjust --hue 45 --lightness -10
    python colorize_svg.py icon.svg --palette
"""

import argparse
import sys

import recolor as engine


def colorize_svg(input_svg, output_svg, color, mode=engine.DEFAULT_MODE, hue=0, saturation=0, lightness=0):
    """Recolor ``input_svg`` and write the result to ``output_svg``. Returns the engine result."""
    with open(input_svg, "rb") as f:
        svg = engine.decode_svg(f.read())
    result = engine.recolor(
        svg,
        engine.Options(mode=mode, color=color, hue=hue, saturation=saturation, lightness=lightness),
    )
    with open(output_svg, "w", encoding="utf-8") as f:
        f.write(result.svg)
    return result


def main(args=None):
    parser = argparse.ArgumentParser(description="Recolor SVG files with svgray and svgshift.")
    parser.add_argument("input_svg", help="Input SVG file")
    parser.add_argument("output_svg", nargs="?", help="Output SVG file")
    parser.add_argument(
        "--color",
        default="#FF0066",
        help="Target color: hex (#FF5733, F53), RGB (255,125,0), rgb()/hsl() or a CSS name",
    )
    parser.add_argument("--mode", default=engine.DEFAULT_MODE, choices=list(engine.MODES))
    parser.add_argument("--hue", type=int, default=0, help="Rotate hue by degrees (-360..360)")
    parser.add_argument("--saturation", type=int, default=0, help="Shift saturation (-100..100)")
    parser.add_argument("--lightness", type=int, default=0, help="Shift lightness (-100..100)")
    parser.add_argument("--palette", action="store_true", help="Only list the colors in the input SVG")
    args = parser.parse_args(args)

    try:
        if args.palette:
            with open(args.input_svg, "rb") as f:
                for entry in engine.palette(engine.decode_svg(f.read())):
                    print(f"{entry['color']}  x{entry['count']}")
            return
        if not args.output_svg:
            parser.error("output_svg is required unless --palette is used")
        result = colorize_svg(
            args.input_svg, args.output_svg, args.color, args.mode, args.hue, args.saturation, args.lightness
        )
    except (engine.RecolorError, OSError) as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    for entry in result.palette():
        print(f"{entry['from']} -> {entry['to']}")
    print(f"Saved {args.output_svg}")


if __name__ == "__main__":
    main()
