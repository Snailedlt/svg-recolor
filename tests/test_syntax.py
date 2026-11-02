"""Syntax checks for output in languages whose compilers aren't available in CI
(Swift, Dart/Flutter, PowerShell), using tree-sitter grammars.

This checks syntax only, not types. The calibration test makes sure the parser
really flags broken code, and that Java/Kotlin output (which tests/live compiles
and runs) parses cleanly.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ts = pytest.importorskip("tree_sitter_language_pack", reason="pip install tree-sitter-language-pack")
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="Node.js is not installed")


def problems(source: str, language: str) -> list[str]:
    try:
        parser = ts.get_parser(language)
    except ts.Error as e:  # grammars are downloaded on first use
        pytest.skip(f"tree-sitter grammar for {language} unavailable: {e}")
    tree = parser.parse(source.encode())
    found = []

    def walk(node):
        if node.type == "ERROR" or node.is_missing:
            found.append(f"{'missing ' if node.is_missing else ''}{node.type} at {node.start_point}")
        for child in node.children:
            walk(child)

    walk(tree.root_node)
    return found


@pytest.mark.parametrize(
    ("language", "broken"),
    [
        ("swift", "let x = (1 + "),
        ("dart", 'void main() { print("x" }'),
        ("powershell", 'Invoke-WebRequest -Uri "x" -InFile ('),
        ("kotlin", "fun main() { val x = }"),
        ("java", "class A { void f( { } }"),
    ],
)
def test_parser_flags_broken_code(language, broken):
    assert problems(broken, language)


def _outputs():
    script = Path(__file__).parent / "js" / "emit-for-syntax.mjs"
    return json.loads(subprocess.run([NODE, str(script)], capture_output=True, text=True, check=True).stdout)


@pytest.mark.parametrize("name", ["swift snippet", "dart snippet", "powershell snippet", "kotlin snippet", "java snippet", "flutter format", "flutter format, tricky SVG"])
def test_generated_code_parses(name):
    language, code = _outputs()[name]
    assert problems(code, language) == []
