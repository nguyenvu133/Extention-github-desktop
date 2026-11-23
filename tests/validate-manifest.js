'use strict';

/*
 * Validates every manifest.json in this repo (repo root + extension/).
 * Chrome's "Manifest file is missing or unreadable" means it looked in
 * the folder you picked in Load unpacked and found no readable
 * manifest.json there, so both folders must be loadable and every
 * file a manifest points at must exist relative to that manifest.
 *
 * Usage: node tests/validate-manifest.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFESTS = [
  path.join(ROOT, 'manifest.json'),
  path.join(ROOT, 'extension', 'manifest.json'),
];

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' -> ' + detail}`);
  if (!ok) failures += 1;
}

const parsed = [];
for (const file of MANIFESTS) {
  const rel = path.relative(ROOT, file);
  const dir = path.dirname(file);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    check(`${rel} parses as JSON`, false, err.message);
    continue;
  }
  check(`${rel} parses as JSON`, true);
  parsed.push({ rel, manifest, dir });
  check(`${rel} manifest_version is 3`, manifest.manifest_version === 3, String(manifest.manifest_version));
  check(`${rel} has a name`, typeof manifest.name === 'string' && manifest.name.length > 0, '');
  check(`${rel} version looks like x.y.z`, /^\d+\.\d+\.\d+$/.test(manifest.version || ''), String(manifest.version));

  const refs = [];
  if (manifest.action && manifest.action.default_popup) refs.push(['action.default_popup', manifest.action.default_popup]);
  if (manifest.background && manifest.background.service_worker) refs.push(['background.service_worker', manifest.background.service_worker]);
  if (manifest.options_ui && manifest.options_ui.page) refs.push(['options_ui.page', manifest.options_ui.page]);
  if (manifest.options_page) refs.push(['options_page', manifest.options_page]);
  check(`${rel} references at least a popup, service worker and options page`, refs.length >= 3, refs.map((r) => r[0]).join(', '));
  for (const [key, ref] of refs) {
    const target = path.join(dir, ref);
    check(`${rel} ${key} -> ${ref} exists`, fs.existsSync(target) && fs.statSync(target).isFile(), target);
  }
}

if (parsed.length === 2) {
  const [a, b] = parsed;
  check('both manifests share the same name', a.manifest.name === b.manifest.name, `${a.manifest.name} vs ${b.manifest.name}`);
  check('both manifests share the same version', a.manifest.version === b.manifest.version, `${a.manifest.version} vs ${b.manifest.version}`);
}

if (failures > 0) {
  console.error(`\nvalidate-manifest: ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\nvalidate-manifest: all checks passed\n');
