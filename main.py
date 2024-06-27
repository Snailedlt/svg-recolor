import subprocess
import argparse

def run_svgray(input_svg, output_svg):
    # Assuming svgray is a shell script or Python script
    subprocess.run(["./submodules/svgray/svgray", input_svg, output_svg], check=True)

def run_svgshift(input_svg, output_svg, color_params):
    # Assuming svgshift is a compiled C program
    subprocess.run(["path/to/svgshift", input_svg, output_svg] + color_params, check=True)

def main():
    parser = argparse.ArgumentParser(description="Process an SVG file.")
    parser.add_argument("input_svg", help="Input SVG file path")
    parser.add_argument("output_svg", help="Output SVG file path")
    parser.add_argument("--color", nargs='+', help="Color parameters for svgshift")
    args = parser.parse_args()

    grayscale_svg = "temp_grayscale.svg"
    run_svgray(args.input_svg, grayscale_svg)
    run_svgshift(grayscale_svg, args.output_svg, args.color)

if __name__ == "__main__":
    main()
