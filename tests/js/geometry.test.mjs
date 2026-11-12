// The vendored geometry libraries (static/vendor) must be exactly the versions pinned
// in package.json; scripts/vendor-geometry.sh copies them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const same = (vendored, pkg) => assert.ok(
    readFileSync(new URL('static/vendor/' + vendored, root)).equals(readFileSync(new URL('tests/js/node_modules/' + pkg, root))),
    `static/vendor/${vendored} differs from ${pkg}: run scripts/vendor-geometry.sh`);

test('vendored paper.js matches the pinned version', () => same('paper-core.min.js', 'paper/dist/paper-core.min.js'));
test('vendored paperjs-offset matches the pinned version', () => same('paperjs-offset.min.js', 'paperjs-offset/dist/paperjs-offset.min.js'));
test('vendored SVGO matches the pinned version', () => same('svgo.browser.js', 'svgo/dist/svgo.browser.js'));
