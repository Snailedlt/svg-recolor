#!/usr/bin/env bash
# Copies the geometry libraries used by "Cut out" (static/geometry.js) from
# tests/js/node_modules into static/vendor. Versions are pinned in
# tests/js/package.json (Dependabot updates them); tests/js/geometry.test.mjs
# fails when the copies drift. Run after updating them:
#   cd tests/js && npm ci && cd ../.. && bash scripts/vendor-geometry.sh
set -euo pipefail
cd "$(dirname "$0")/.."
src=tests/js/node_modules
cp "$src/paper/dist/paper-core.min.js" static/vendor/paper-core.min.js
cp "$src/paperjs-offset/dist/paperjs-offset.min.js" static/vendor/paperjs-offset.min.js
echo "paper $(node -p "require('./$src/paper/package.json').version"), paperjs-offset $(node -p "require('./$src/paperjs-offset/package.json').version")"
