#!/usr/bin/env bash
# Copies the libraries loaded on demand (geometry for Cut out, gaps, lines and Fit; SVGO for
# Optimize) from
# tests/js/node_modules into static/vendor. Versions are pinned in
# tests/js/package.json (Dependabot updates them); tests/js/geometry.test.mjs
# fails when the copies drift. Run after updating them:
#   cd tests/js && npm ci && cd ../.. && bash scripts/vendor-geometry.sh
set -euo pipefail
cd "$(dirname "$0")/.."
src=tests/js/node_modules
cp "$src/paper/dist/paper-core.min.js" static/vendor/paper-core.min.js
cp "$src/paperjs-offset/dist/paperjs-offset.min.js" static/vendor/paperjs-offset.min.js
cp "$src/svgo/dist/svgo.browser.js" static/vendor/svgo.browser.js
echo "paper $(node -p "require('./$src/paper/package.json').version"), paperjs-offset $(node -p "require('./$src/paperjs-offset/package.json').version"), svgo $(node -p "require('./$src/svgo/package.json').version")"
