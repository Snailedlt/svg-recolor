from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
import subprocess
import tempfile
import os
import re
from pathlib import Path
from starlette.staticfiles import StaticFiles
import sentry_sdk
import sys
from colorize_svg import colorize_svg

sentry_sdk.init(
    dsn="https://98b39a4523a365e1bbc2639fbb075633@o4508424099856384.ingest.de.sentry.io/4508424101363792",
    # Set traces_sample_rate to 1.0 to capture 100%
    # of transactions for tracing.
    traces_sample_rate=1.0,
    _experiments={
        # Set continuous_profiling_auto_start to True
        # to automatically start the profiler on when
        # possible.
        "continuous_profiling_auto_start": True,
    },
)

app = FastAPI()
app.mount("/static", StaticFiles(directory="static", html=True), name="static")


# Create a front page with a simple form for uploading an SVG file and selecting a color to apply to the icon
@app.get("/")
async def landing_page():
    with open("main.html", "r", encoding="utf-8") as file:
        html_content = file.read()
    return HTMLResponse(content=html_content)


@app.post("/colorize")
async def colorize(icon: UploadFile = File(...), color: str = "#FF0066"):
    validate_icon(icon, color)

    # Create temporary files for the input and output SVGs
    with tempfile.NamedTemporaryFile(
        delete=False, suffix=".svg"
    ) as input_svg_temp, tempfile.NamedTemporaryFile(
        delete=False, suffix=".svg"
    ) as output_svg_temp:
        try:
            # Save the uploaded icon to the temporary input file
            with open(input_svg_temp.name, "wb") as buffer:
                buffer.write(icon.file.read())

            # Run the colorize_svg function to colorize the SVG
            try:
                colorize_svg(input_svg_temp.name, output_svg_temp.name, color)
            except Exception as e:
                # Log the error output
                print(f"Error processing the SVG file. Error: {str(e)}")
                raise RuntimeError(f"Error processing the SVG file. Error: {str(e)}")

            # Return the colorized SVG from the temporary output file
            return FileResponse(
                path=output_svg_temp.name,
                media_type="image/svg+xml",
                filename=Path(icon.filename).stem + "_recolored_" + color + ".svg",
            )
        except subprocess.CalledProcessError as e:
            raise HTTPException(
                status_code=500,
                detail="Error processing the SVG file.\nError: " + str(e),
            )
        finally:
            # Clean up temporary files
            try:
                os.remove(input_svg_temp.name)
                os.remove(output_svg_temp.name)
            except PermissionError:
                pass


def validate_icon(icon, color):
    # Validate file extension
    if (
        not icon.filename.lower().endswith(".svg")
        or not icon.content_type == "image/svg+xml"
    ):
        raise HTTPException(
            status_code=415,
            detail="Only SVG files are supported. Make sure the file has a .svg file extension and is of type image/svg+xml.",
        )
    # Validate file size
    if icon.size > 2048 * 2048:
        raise HTTPException(
            status_code=413,
            detail="File size must be less than 2 MB. Make sure the SVG file is optimized before uploading.",
        )
    # Validate color format. For example, #FF0066 or 255,0,102
    # TODO: add support for 3 digit hex colors: re.search(r"^#(?:[0-9a-fA-F]{3}){1,2}$", color)
    ## is six digit hex color
    is_hex_color = re.search(r"#[a-fA-F0-9]{6}$", color)  # TODO: Move to utils.py
    is_rgb_color = re.search(
        r"^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9]),(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9]),(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$",
        color,
    )  # TODO: Move to utils.py
    if not is_hex_color and not is_rgb_color:
        raise HTTPException(
            status_code=400,
            detail="Invalid color format. Please provide a color in comma-separated RGB value (e.g., 255,0,102) or a hex color code (e.g., #FF0066, #F06).",
        )


def save_uploaded_file(upload_file: UploadFile, destination_path: str):
    with open(destination_path, "wb") as buffer:
        buffer.write(upload_file.file.read())


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
