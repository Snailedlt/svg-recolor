"""The command-line tools: colorize_svg.py and the colorize_svg.sh wrapper."""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

import recolor as r

ROOT = Path(__file__).resolve().parent.parent
SNAIL = ROOT / "example-input-svgs/rainbow-snail.svg"


def cli(*args, script="colorize_svg.py"):
    cmd = [sys.executable, str(ROOT / script)] if script.endswith(".py") else ["bash", str(ROOT / script)]
    env = {"PATH": "/usr/bin:/bin", "PYTHON": sys.executable}
    return subprocess.run([*cmd, *map(str, args)], check=False, capture_output=True, text=True, env=env, timeout=60)


def test_cli_writes_the_same_svg_as_the_engine(tmp_path):
    out = tmp_path / "out.svg"
    res = cli(SNAIL, out, "--color", "seagreen", "--mode", "colorize", "--hue", "10")
    assert res.returncode == 0, res.stderr
    expected = r.recolor(SNAIL.read_text(), r.Options(mode="colorize", color="seagreen", hue=10)).svg
    assert out.read_text() == expected


def test_cli_lists_the_palette():
    res = cli(SNAIL, "--palette")
    assert res.returncode == 0, res.stderr
    assert "#fadc1e" in res.stdout


def test_cli_rejects_a_bad_color(tmp_path):
    res = cli(SNAIL, tmp_path / "out.svg", "--color", "notacolor")
    assert res.returncode != 0


@pytest.mark.skipif(not shutil.which("bash"), reason="needs bash")
@pytest.mark.parametrize("color", ["#FF0000", "255,0,0"])
def test_shell_script_keeps_the_original_interface(tmp_path, color):
    # The original script: grayscale, then add the color. That is Tint mode.
    out = tmp_path / "out.svg"
    res = cli(SNAIL, out, "--color", color, script="colorize_svg.sh")
    assert res.returncode == 0, res.stderr
    assert out.read_text() == r.recolor(SNAIL.read_text(), r.Options(mode="tint", color="#ff0000")).svg


@pytest.mark.skipif(not shutil.which("bash"), reason="needs bash")
def test_shell_script_passes_other_options_through(tmp_path):
    out = tmp_path / "out.svg"
    res = cli(SNAIL, out, "--color", "teal", "--mode", "solid", script="colorize_svg.sh")
    assert res.returncode == 0, res.stderr
    assert out.read_text() == r.recolor(SNAIL.read_text(), r.Options(mode="solid", color="teal")).svg
