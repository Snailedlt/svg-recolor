"""Type-checks generated code with online compilers (needs internet):

- Swift snippet: swiftc (Compiler Explorer, godbolt.org), -typecheck on Linux
- Dart snippet and Flutter format: DartPad's analyzer (Flutter + http + flutter_svg)

Each service is first calibrated with deliberately broken code, so a check
can't pass just because the service ignored the input. Exit code 1 on failure.
Run from the repository root: python tests/online/check.py
"""

import json
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

GODBOLT = "https://godbolt.org/api/compiler/swift641/compile"
DARTPAD = "https://stable.api.dartpad.dev/api/v3/analyze"
# DartPad runs in the browser and rejects dart:io; this stand-in has the same signatures.
FILE_STUB = """
class File {
  File(String path);
  Future<String> readAsString() async => '';
  Future<File> writeAsString(String contents) async => this;
}
"""


def post(url: str, payload: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read())


def swift_errors(code: str) -> list[str]:
    res = post(GODBOLT, {"source": code, "options": {"userArguments": "-typecheck", "filters": {}}})
    errors = [line["text"] for line in res.get("stderr", []) if "error:" in line["text"] and not line["text"].lstrip().startswith("|")]
    return errors or ([f"exit code {res.get('code')}"] if res.get("code") else [])


def dart_errors(code: str) -> list[str]:
    res = post(DARTPAD, {"source": code})
    return [f"{i['kind']}: {i['message']}" for i in res.get("issues", []) if i["kind"] in ("error", "warning")]


def outputs() -> dict:
    script = Path(__file__).resolve().parent.parent / "js" / "emit-for-syntax.mjs"
    return json.loads(subprocess.run([shutil.which("node"), str(script)], capture_output=True, text=True, check=True).stdout)


def main() -> int:
    out = outputs()
    dart_snippet = out["dart snippet"][1].replace("import 'dart:io';\n", "") + FILE_STUB
    checks = [
        ("calibration: broken Swift is rejected", lambda: not swift_errors('let x: Int = "no"'), True),
        ("calibration: broken Dart is rejected", lambda: not dart_errors("void main() { int x = 'no'; }"), True),
        ("Swift snippet type-checks", lambda: swift_errors(out["swift snippet"][1]), False),
        ("Dart snippet analyzes cleanly", lambda: dart_errors(dart_snippet), False),
        ("Flutter format analyzes cleanly", lambda: dart_errors(out["flutter format"][1] + "\nvoid main() {}\n"), False),
        ("Flutter format, tricky SVG", lambda: dart_errors(out["flutter format, tricky SVG"][1] + "\nvoid main() {}\n"), False),
    ]
    failed = 0
    for name, run, is_calibration in checks:
        result = run()
        ok = not result
        print(("ok    " if ok else "FAIL  ") + name + ("" if ok or is_calibration else f": {result[:3]}"))
        failed += not ok
    print(f"failures: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
