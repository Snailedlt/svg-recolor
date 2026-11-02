#!/usr/bin/env bash
# Runs the API snippets in their real languages against a local server and checks
# that each one writes exactly what the API returns. Languages whose toolchain
# isn't installed are skipped (CI installs them). Exit code 1 on any failure.
#   bash tests/live/run.sh            (from the repository root)
set -uo pipefail
cd "$(dirname "$0")"
PORT=${PORT:-8899}
SITE="http://127.0.0.1:$PORT"
ROOT=$(cd ../.. && pwd)
PY=${PYTHON:-python3}

SENTRY_DSN= RATE_LIMIT_WORK=0 "$PY" -m uvicorn main:app --app-dir "$ROOT" --port "$PORT" --log-level warning &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
for _ in $(seq 50); do curl -sf "$SITE/api/modes" >/dev/null && break; sleep 0.2; done

rm -rf build && node generate.mjs "$SITE" || exit 1
curl -sf -X POST "$SITE/api/recolor?color=3ecf8e&mode=colorize&hue=20" -H "Content-Type: image/svg+xml" \
  --data-binary @../fixtures/python.svg -o build/expected.svg || { echo "server not reachable"; exit 1; }

pass=0; fail=0; skip=0
check() { # name, needed tool, command (runs in build/<name>)
  local name=$1 tool=$2; shift 2
  if ! command -v "$tool" >/dev/null 2>&1; then echo "skip  $name ($tool not installed)"; skip=$((skip+1)); return; fi
  ( cd "build/$name" && timeout 600 bash -c "$*" ) >"build/$name.log" 2>&1
  if cmp -s "build/$name/out.svg" build/expected.svg; then echo "ok    $name"; pass=$((pass+1));
  else echo "FAIL  $name (see tests/live/build/$name.log)"; tail -5 "build/$name.log"; fail=$((fail+1)); fi
}

check curl     curl    'bash run.sh'
check httpie   http    'bash run.sh'
check node     node    'node run.mjs'
check axios    npm     'npm init -y >/dev/null && npm install --silent axios@1.7.9 >/dev/null && node run.mjs'
check requests "$PY"   "\"$PY\" -c 'import requests' && \"$PY\" run.py"
check httpx    "$PY"   "\"$PY\" run.py"
check go       go      'go run main.go'
check rust     cargo   'cargo init -q --name recolor . && cargo add -q reqwest@0.12 --no-default-features --features blocking && cargo run -q'
check java     java    'java Recolor.java'
check kotlin   kotlinc 'kotlinc -jvm-target 1.8 Recolor.kt -include-runtime -d r.jar && java -jar r.jar'
check csharp   dotnet  'dotnet new console --force -o . >/dev/null && cp Snippet.cs.txt Program.cs && dotnet run'
check php      php     'php run.php'
check ruby     ruby    'ruby run.rb'

# Blazor: compile the generated .razor with the real Razor compiler and render it.
if command -v dotnet >/dev/null 2>&1; then
  ( cd build/blazor && cat > bz.csproj <<'XML'
<Project Sdk="Microsoft.NET.Sdk.Razor">
  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
  <ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App" /></ItemGroup>
</Project>
XML
    cat > Program.cs <<'CS'
using bz;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
var services = new ServiceCollection().AddLogging().BuildServiceProvider();
await using var renderer = new HtmlRenderer(services, services.GetRequiredService<ILoggerFactory>());
var html = await renderer.Dispatcher.InvokeAsync(async () => (await renderer.RenderComponentAsync<RecoloredIcon>(
    ParameterView.FromDictionary(new Dictionary<string, object?> { ["class"] = "size-6" }))).ToHtmlString());
File.WriteAllText("out.html", html);
CS
    timeout 600 dotnet run ) >build/blazor.log 2>&1
  if "$PY" -c "import sys; from xml.etree.ElementTree import canonicalize as c; sys.exit(c(open('build/blazor/out.html').read(), strip_text=True) != c(open('build/blazor/expected.svg').read(), strip_text=True))" 2>>build/blazor.log; then
    echo "ok    blazor (rendered SVG is equivalent)"; pass=$((pass+1))
  else echo "FAIL  blazor (see tests/live/build/blazor.log)"; fail=$((fail+1)); fi
else echo "skip  blazor (dotnet not installed)"; skip=$((skip+1)); fi

echo "passed: $pass, failed: $fail, skipped: $skip"
[ "$fail" -eq 0 ]
