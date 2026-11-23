'use strict';
/**
 * tests/run-all.js — Run the FULL v3.0 test suite in one command.
 *
 *   node tests/run-all.js
 *
 * Starts a real bridge on BRIDGE_PORT (default 17321) — needed by
 * tests/extension-test.js, which reads bridge/.bridge-token — then runs
 * all 6 suites in order and stops the bridge. Exit code 0 = all pass.
 *
 * No real GitHub API is called: bridge-v2-test.js, bridge-v21-test.js
 * and bridge-v3-test.js use their own mock GitHub servers and their
 * own bridges on ports 17399, 17398 and 17397.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BRIDGE_PORT = process.env.BRIDGE_PORT || '17321';

function runNode(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function main() {
  console.log(`\n=== PixiJS GitHub Desktop Sync v3.0 — full test suite ===\n`);
  console.log(`Starting a real bridge on 127.0.0.1:${BRIDGE_PORT} ...`);

  const bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'bridge-server.js')], {
    env: { ...process.env, BRIDGE_PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let started = false;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bridge did not start within 15 s')), 15000);
      bridge.stdout.on('data', (d) => {
        if (d.toString().includes('Listening:')) {
          clearTimeout(timer);
          started = true;
          resolve();
        }
      });
      bridge.stderr.on('data', () => {});
      bridge.on('exit', () => {
        clearTimeout(timer);
        if (!started) reject(new Error('bridge exited before listening'));
      });
    });
  } catch (err) {
    console.error('run-all: ' + err.message);
    try { bridge.kill('SIGTERM'); } catch (_) {}
    process.exit(1);
  }
  console.log('Bridge is up.\n');

  const suites = [
    ['validate-manifest.js', 'Manifest (root + extension/)'],
    ['load-from-root-test.js', 'Load unpacked from repo root or extension/'],
    ['bridge-v2-test.js', 'Bridge v2 (mock GitHub API + dashboard in vm)'],
    ['bridge-v21-test.js', 'Bridge v2.1 (push/pull expansion + OAuth Web Flow + auto-sync)'],
    ['bridge-v3-test.js', 'Bridge v3.0 (login diagnostics + PAT guard + zip + GitHub API v3 + cherry-pick/revert/reset/tags)'],
    ['extension-test.js', 'Extension functional (local Git against the live bridge)'],
  ];
  let failed = 0;
  for (const [file, label] of suites) {
    console.log(`\n### ${label} — ${file}`);
    const ok = await runNode(file);
    if (!ok) {
      failed++;
      console.error(`!! ${file} FAILED`);
    }
  }

  try { bridge.kill('SIGTERM'); } catch (_) {}
  if (failed === 0) {
    console.log('\nrun-all: ALL SUITES PASSED\n');
    process.exit(0);
  }
  console.log(`\nrun-all: ${failed} suite(s) FAILED\n`);
  process.exit(1);
}

main();
