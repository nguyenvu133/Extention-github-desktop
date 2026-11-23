'use strict';
/**
 * tests/run-all.js — Run the FULL v3.5.1 test suite in one command.
 *
 *   node tests/run-all.js
 *
 * Starts a real bridge on BRIDGE_PORT (default 17321) — needed by
 * tests/extension-test.js, which reads bridge/.bridge-token — then runs
 * all 13 suites in order and stops the bridge. Exit code 0 = all pass.
 *
 * No real GitHub API is called: bridge-v2-test.js, bridge-v21-test.js,
 * bridge-v3-test.js, bridge-v301-test.js, bridge-v302-test.js, bridge-v310-test.js,
 * bridge-v311-test.js, bridge-v350-test.js and env-test.js use their own mock GitHub
 * servers and their own bridges on ports 17399, 17398, 17397, 17395,
 * 17394, 17386, 17387, 17388 and 17391-17393 (mocks on 17412, 17413, 17414 and 17415).
 * bat-test.js checks the launcher/doctor scripts by bytes + structure
 * (.bat files are never executed — no cmd.exe on Linux) and runs the
 * .sh launchers for real against its own bridges on ports 17389/17390.
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
  console.log(`\n=== PixiJS GitHub Desktop Sync v3.5.1 — full test suite ===\n`);
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
    ['bat-test.js', 'Launcher/doctor scripts (bytes + batch parser + .sh real runs)'],
    ['bridge-v2-test.js', 'Bridge v2 (mock GitHub API + dashboard in vm)'],
    ['bridge-v21-test.js', 'Bridge v2.1 (push/pull expansion + OAuth Web Flow + auto-sync)'],
    ['bridge-v3-test.js', 'Bridge v3.0 (login diagnostics + PAT guard + zip + GitHub API v3 + cherry-pick/revert/reset/tags)'],
    ['bridge-v301-test.js', 'Bridge v3.0.1 (Failed to fetch fix: bridge-client, CORS, connection-test, login gate, start scripts)'],
    ['bridge-v302-test.js', 'Bridge v3.0.2 (start-windows.bat CRLF/ASCII fix + .ps1 + doctor + launcher waits for /health)'],
    ['bridge-v310-test.js', 'Bridge v3.1.0 (extended pull/push: preview, autostash, undo, rebase flow, all branches, refspecs, multi-remote, history, GitHub token, Node 16.13)'],
    ['bridge-v311-test.js', 'Bridge v3.1.1 (toolbar routes: recent/find repo, per-remote fetch + GitHub token, clone into ~/GitHub, publish branch)'],
    ['bridge-v350-test.js', 'Bridge v3.5.0 (pull origin incl. autostash/rebase/undo/pull-remotes/upstream, mock-OAuth end-to-end, Actions/commit/compare/languages/contributors/topics/issue+PR detail, worktrees, graph)'],
    ['env-test.js', 'Bridge v3.5.1 (.env auto-config: parser, PAT auto sign-in, OAuth auto-config, DEFAULT_REPO_PATH, precedence, setup scripts)'],
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
