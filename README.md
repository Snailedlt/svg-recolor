# SVG Recolor

SVG Recolor is a simple CLI tool to recolor SVG files. It is written in python.

> [!NOTE]
> Submodules have their own licenses and may not be covered by the license of this project. Check the submodule's license for details.

## Example Usage

```bash
# Recolor the input SVG file to red and save it to the output file using RGB color values
./colorize_svg.sh "example-input-svgs/input.svg" tmp/output.svg --color "255,0,0"

# Recolor the input SVG file to red and save it to the output file using hex color values
./colorize_svg.sh "example-input-svgs/input.svg" tmp/output.svg --color "#FF0000"
```
