'use strict';
require('./_node16-fetch'); // Node 16.13 has no global fetch

/*
 * tests/native-host-test.js — Native Messaging host v3.7.0
 * ("nut 1 cham mo bridge").
 *
 * CONTRACT (what bridge/native-host.js + the extension must implement;
 * this test was written against the contract while workstream 1 was
 * still building the host, so a failure prints the ACTUAL payload the
 * host returned — compare it with the shapes below):
 *
 *   Host: bridge/native-host.js, name "com.pixijs.github.bridge".
 *   Transport: stdio, one JSON message per frame, each frame =
 *   4-byte little-endian length + UTF-8 JSON. The host MUST NOT print
 *   anything else to stdout (no logs, no token) — only framed JSON.
 *   Requests:  { "action": "status" }            -> { "ok": true, "running": bool, ... }
 *              { "action": "start-bridge" }      -> { "ok": true, "token": "<bridge token>", "running": true, ... }
 *              { "action": "get-token" }         -> { "ok": true, "token": "<same bridge token>", ... }
 *              { "action": "setup-env" }         -> { "ok": true, ... } (runs the setup launcher)
 *              { "action": "<anything else>" }   -> { "ok": false, "error": "..." } (no crash)
 *   Test overrides (env, read by the host):
 *     NATIVE_HOST_LAUNCHER       path of the launcher that starts the
 *                                bridge (default: bridge/start-windows.bat
 *                                on Windows / start-mac-linux.sh elsewhere)
 *     NATIVE_HOST_SETUP_LAUNCHER path of the launcher that writes
 *                                bridge/.env (default: bridge/setup-env.*)
 *     BRIDGE_DATA_DIR            data dir holding .bridge-token / .env
 *     BRIDGE_PORT                port the bridge listens on
 *
 * What this test does (all local, all fake values, no real GitHub):
 *   - Own mock GitHub server (only GET /user, for the bridge's .env
 *     PAT auto-sign-in) + own bridge on port 17417 (mock on 17418 —
 *     neither collides with any port in tests/run-all.js).
 *   - The launcher / setup launcher are STUB scripts written into the
 *     test temp dir and pointed to via the env overrides above. The
 *     launcher stub starts the REAL bridge (detached, stdio ignored)
 *     on the test port with the test BRIDGE_DATA_DIR, waits for
 *     /health, then exits 0. The setup stub writes a .env with FAKE
 *     values only into the test BRIDGE_DATA_DIR.
 *   - Checks: framed protocol round-trip; status before/after start;
 *     start-bridge returns a token that WORKS (GET /health with
 *     Bearer <token> -> 200 ok); get-token returns the SAME token;
 *     setup-env stub wrote .env into the TEST data dir only (the real
 *     bridge/.env, if any, is untouched); unknown action -> error,
 *     host stays alive; framed invalid JSON -> error reply, host stays
 *     alive; RAW unframed garbage that corrupts the 4-byte length prefix
 *     -> the host logs 'frame too large' to stderr and exits CLEANLY
 *     with code 1 (not a crash: a length-prefixed stream with a corrupt
 *     length cannot be resynced, and Chrome relaunches the host on the
 *     next connectNative); the token NEVER appears in the host's stdout
 *     outside a framed JSON payload (nor on stderr).
 *
 * If bridge/native-host.js does not exist yet (workstream 1 has not
 * landed it), this file exits 1 with "HOST MISSING — cho workstream 1"
 * instead of faking a pass.
 *
 * Usage: node tests/native-host-test.js
 * Cleans up after itself (kills host + bridge + mock, removes temp
 * dirs) and exits non-zero on any failure. No real GitHub API is called.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST_ENTRY = path.join(ROOT, 'bridge', 'native-host.js');
const BRIDGE_ENTRY = path.join(ROOT, 'bridge', 'bridge-server.js');
const MOCK_PORT = 17418;
const BRIDGE_PORT = 17417;
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
// Test-only dummy values (never real, never printed in full).
const FAKE_SETUP_TOKEN = 'v360-fake-setup-token-for-tests-only';
const FAKE_PAT = 'ghp_v360fakepatfortestsonly0000000000';
const FAKE_USER = 'v360-fake-user';
const MAX_FRAME = 10 * 1024 * 1024;

let failures = 0;
let passes = 0;
function check(name, condition, detail) {
  if (condition) { passes += 1; console.log(`  PASS  ${name}`); }
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (v) => JSON.stringify(v).slice(0, 300);

/* ------------------------------------------------------------------ */
/* Mock GitHub (only GET /user — the bridge's .env PAT auto-sign-in)   */
/* ------------------------------------------------------------------ */

function mockHandler(req, res) {
  const url = new URL(req.url, MOCK_BASE);
  if (url.pathname === '/user' && req.method === 'GET') {
    if (req.headers.authorization === `Bearer ${FAKE_PAT}`) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-OAuth-Scopes': 'repo, read:user' });
      return res.end(JSON.stringify({ login: FAKE_USER, id: 360, name: 'V360 Fake User', email: 'v360-fake@example.com', avatar_url: '', html_url: 'https://github.com/v360-fake-user' }));
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'Bad credentials' }));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Not Found' }));
}

/* ------------------------------------------------------------------ */
/* Framed stdio client for the host                                    */
/* ------------------------------------------------------------------ */

class HostClient {
  constructor(proc) {
    this.proc = proc;
    this.buf = Buffer.alloc(0);
    this.waiters = []; // { resolve } in arrival order
    this.frames = []; // parsed frames waiting to be consumed
    this.rawOut = []; // every stdout chunk, for the token-leak check
    this.rawErr = [];
    proc.stdout.on('data', (d) => {
      this.rawOut.push(d);
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
    proc.stderr.on('data', (d) => { this.rawErr.push(d); });
  }
  drain() {
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_FRAME) {
        // Not a sane frame: treat the buffered bytes as unframed junk
        // and stop parsing here (the leak check sees them as leftover).
        return;
      }
      if (this.buf.length < 4 + len) return;
      const payload = this.buf.slice(4, 4 + len);
      this.buf = this.buf.slice(4 + len);
      let obj = null;
      try { obj = JSON.parse(payload.toString('utf8')); } catch (_) { obj = { _unparsable: payload.toString('utf8').slice(0, 200) }; }
      if (this.waiters.length) this.waiters.shift().resolve(obj);
      else this.frames.push(obj);
    }
  }
  nextFrame(timeoutMs) {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ _timeout: true }), timeoutMs);
      this.waiters.push({
        resolve: (obj) => { clearTimeout(timer); resolve(obj); },
      });
    });
  }
  send(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    this.proc.stdin.write(Buffer.concat([header, payload]));
  }
  sendRaw(buf) { this.proc.stdin.write(buf); }
  // One request -> one response. A stale error frame for an earlier
  // garbage input (invalid-json / invalid-message / missing-action)
  // may arrive first; skip up to 2 such frames to reach the real reply.
  async request(obj, timeoutMs = 30000) {
    this.send(obj);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const r = await this.nextFrame(timeoutMs);
      if (!r || r._timeout) return r;
      const staleGarbageError = r.ok === false && typeof r.error === 'string' &&
        /^(invalid-json|invalid-message|missing-action)$/.test(r.error);
      if (staleGarbageError) continue;
      return r;
    }
    return { _timeout: true };
  }
  alive() { return this.proc.exitCode === null && this.proc.signalCode === null; }
  // Bytes of stdout that are NOT inside a framed payload.
  unframedStdout() {
    const all = Buffer.concat(this.rawOut);
    const leftover = [];
    let off = 0;
    while (off + 4 <= all.length) {
      const len = all.readUInt32LE(off);
      if (len > MAX_FRAME || off + 4 + len > all.length) break;
      off += 4 + len;
    }
    if (off < all.length) leftover.push(all.slice(off));
    return Buffer.concat(leftover).toString('utf8');
  }
}

/* ------------------------------------------------------------------ */
/* Test runner                                                         */
/* ------------------------------------------------------------------ */

async function main() {
  if (!fs.existsSync(HOST_ENTRY)) {
    console.log('\nHOST MISSING — bridge/native-host.js chua co (workstream 1 chua xong).');
    console.log('Test da viet theo contract trong header file nay; chay lai sau khi host duoc tao.');
    console.log('\nnative-host-test: 0 passed, 1 failed (host missing)');
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v360-native-host-test-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const realEnvPath = path.join(ROOT, 'bridge', '.env');
  const realEnvExistedBefore = fs.existsSync(realEnvPath);
  const pidFile = path.join(tmp, 'bridge.pid');

  // --- stub launcher: starts the REAL bridge, detached, stdio ignored,
  //     waits for /health, then exits 0. Port / data dir / mock base are
  //     baked in so the test does not depend on the host passing env
  //     through to the launcher. NOTE: the host spawns a non-.sh
  //     launcher DIRECTLY (no `node` wrapper), so this file needs a
  //     shebang + the executable bit — exactly like a real launcher. ---
  const launcherPath = path.join(tmp, 'stub-launcher.js');
  fs.writeFileSync(launcherPath, `#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const PORT = ${BRIDGE_PORT};
const DATA_DIR = ${JSON.stringify(dataDir)};
const PID_FILE = ${JSON.stringify(pidFile)};
const child = spawn(process.execPath, [${JSON.stringify(BRIDGE_ENTRY)}], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, BRIDGE_PORT: String(PORT), BRIDGE_DATA_DIR: DATA_DIR,
         GITHUB_API_BASE: ${JSON.stringify(MOCK_BASE)}, GITHUB_OAUTH_BASE: ${JSON.stringify(MOCK_BASE)} },
});
fs.writeFileSync(PID_FILE, String(child.pid));
child.unref();
const deadline = Date.now() + 15000;
(function poll() {
  http.get('http://127.0.0.1:' + PORT + '/health', (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try { if (JSON.parse(body).ok === true) return process.exit(0); } catch (_) {}
      if (Date.now() > deadline) return process.exit(1);
      setTimeout(poll, 200);
    });
  }).on('error', () => {
    if (Date.now() > deadline) return process.exit(1);
    setTimeout(poll, 200);
  });
})();
`);
  fs.chmodSync(launcherPath, 0o755); // host execs a non-.sh launcher directly
  // --- stub setup launcher: writes a .env with FAKE values only into
  //     the TEST data dir (never the real bridge/.env). ---
  const setupPath = path.join(tmp, 'stub-setup.js');
  fs.writeFileSync(setupPath, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const DATA_DIR = ${JSON.stringify(dataDir)};
fs.writeFileSync(DATA_DIR + '/.env',
  'BRIDGE_TOKEN=${FAKE_SETUP_TOKEN}\\n' +
  'GITHUB_PAT=${FAKE_PAT}\\n' +
  'NATIVE_HOST_TEST_MARKER=v360-native-host-test\\n', { mode: 0o600 });
process.exit(0);
`);
  fs.chmodSync(setupPath, 0o755); // host execs a non-.sh setup launcher directly

  const mock = http.createServer(mockHandler);
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const host = spawn(process.execPath, [HOST_ENTRY], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(BRIDGE_PORT),
      BRIDGE_DATA_DIR: dataDir,
      GITHUB_API_BASE: MOCK_BASE,
      GITHUB_OAUTH_BASE: MOCK_BASE,
      NATIVE_HOST_LAUNCHER: launcherPath,
      NATIVE_HOST_SETUP_LAUNCHER: setupPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new HostClient(host);
  let hostOut = '';
  host.stderr.on('data', (d) => { hostOut += d.toString('utf8'); });

  const killBridge = () => {
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (pid) { try { process.kill(pid, 'SIGTERM'); } catch (_) {} }
    } catch (_) {}
  };
  const cleanup = (code) => {
    try { host.kill('SIGTERM'); } catch (_) {}
    killBridge();
    try { mock.close(); } catch (_) {}
    if (failures) {
      console.log('\n--- host stderr (last 20 lines, token redacted) ---');
      console.log(hostOut.split('\n').slice(-20).join('\n').replace(/TOKEN:\s*\S+/g, 'TOKEN: [redacted]'));
    }
    // Give the detached bridge a moment to die, then remove temp dirs.
    setTimeout(() => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
      console.log(`\nnative-host-test: ${passes} passed, ${failures} failed`);
      process.exit(code);
    }, 300);
  };

  // Host readiness = it answers a framed request (it prints nothing
  // unframed to stdout, so there is no banner to wait for).
  await sleep(500);
  if (!client.alive()) {
    console.log('  FAIL  host spawns and stays alive -> exited immediately' + (hostOut ? ': ' + hostOut.slice(-300) : ''));
    return cleanup(1);
  }
  check('host spawns and stays alive', true);

  const tokenOf = (r) => (r && typeof r.token === 'string' && r.token) ||
    (r && typeof r.bridgeToken === 'string' && r.bridgeToken) || '';
  const runningOf = (r) => {
    if (r && typeof r.running === 'boolean') return r.running;
    if (r && r.status === 'running') return true;
    if (r && r.status === 'stopped') return false;
    return undefined;
  };

  /* ---------- 0. status: bridge not running yet ---------- */
  console.log('\n[0] status (bridge chua chay)');
  let r = await client.request({ action: 'status' });
  check('status: framed JSON reply (not a timeout)', !(r && r._timeout), j(r));
  check('status: bridge not running', runningOf(r) === false, j(r));

  /* ---------- 1. setup-env: stub writes .env into the TEST dir ---------- */
  console.log('\n[1] setup-env (stub ghi .env gia)');
  r = await client.request({ action: 'setup-env' });
  check('setup-env: ok, no error', !(r && r._timeout) && r.ok !== false && !r.error, j(r));
  // The host only STARTS the setup launcher and returns at once, so
  // the stub may still be writing .env when the reply arrives: poll.
  const envPath = path.join(dataDir, '.env');
  for (let i = 0; i < 50 && !fs.existsSync(envPath); i += 1) await sleep(100);
  check('setup-env: .env created in the TEST data dir', fs.existsSync(envPath));
  if (fs.existsSync(envPath)) {
    const envText = fs.readFileSync(envPath, 'utf8');
    check('setup-env: .env has the stub marker', envText.includes('NATIVE_HOST_TEST_MARKER=v360-native-host-test'));
    check('setup-env: .env has the fake BRIDGE_TOKEN', envText.includes('BRIDGE_TOKEN=' + FAKE_SETUP_TOKEN));
    check('setup-env: .env has no real secret (only fake test values)',
      !/github_pat_[A-Za-z0-9]{20,}/.test(envText.replace(FAKE_PAT, '')) && !/ghp_[A-Za-z0-9]{20,}/.test(envText.replace(FAKE_PAT, '')));
  }
  check('setup-env: real bridge/.env untouched (existence unchanged)',
    fs.existsSync(realEnvPath) === realEnvExistedBefore);

  /* ---------- 2. start-bridge: token must WORK ---------- */
  console.log('\n[2] start-bridge (bridge that, token phai dung duoc)');
  r = await client.request({ action: 'start-bridge' }, 30000);
  check('start-bridge: framed JSON reply (not a timeout)', !(r && r._timeout), j(r));
  const token = tokenOf(r);
  check('start-bridge: returns a non-empty token', token.length >= 8, 'token length ' + token.length);
  check('start-bridge: token is the fake BRIDGE_TOKEN from the test .env',
    token === FAKE_SETUP_TOKEN, token ? 'token differs from the .env value (host/bridge used another token)' : j(r));
  check('start-bridge: token file in the TEST data dir matches',
    fs.existsSync(path.join(dataDir, '.bridge-token')) &&
    fs.readFileSync(path.join(dataDir, '.bridge-token'), 'utf8').trim() === token);
  let health = {};
  try {
    const res = await fetch(BASE + '/health', { headers: { Authorization: 'Bearer ' + token } });
    health = { status: res.status, ...(await res.json().catch(() => ({}))) };
  } catch (err) { health = { error: String(err && err.message || err) }; }
  check('start-bridge: GET /health with that Bearer token -> 200 ok',
    health.status === 200 && health.ok === true, j(health));

  /* ---------- 3. get-token: same token ---------- */
  console.log('\n[3] get-token (phai tra cung token)');
  r = await client.request({ action: 'get-token' });
  check('get-token: framed JSON reply (not a timeout)', !(r && r._timeout), j(r));
  check('get-token: same token as start-bridge', tokenOf(r) === token && token.length > 0, j(r));
  let health2 = {};
  try {
    const res = await fetch(BASE + '/health', { headers: { Authorization: 'Bearer ' + tokenOf(r) } });
    health2 = { status: res.status, ...(await res.json().catch(() => ({}))) };
  } catch (err) { health2 = { error: String(err && err.message || err) }; }
  check('get-token: GET /health with that token -> 200 ok',
    health2.status === 200 && health2.ok === true, j(health2));

  /* ---------- 4. status: bridge running ---------- */
  console.log('\n[4] status (bridge dang chay)');
  r = await client.request({ action: 'status' });
  check('status: bridge running', runningOf(r) === true, j(r));

  /* ---------- 5. unknown action: error, no crash ---------- */
  console.log('\n[5] action la (phai tra loi, khong crash)');
  r = await client.request({ action: 'do-something-v360-not-real' });
  check('unknown action: error reply (ok:false or error field)',
    !(r && r._timeout) && (r.ok === false || typeof r.error === 'string'), j(r));
  await sleep(300);
  check('unknown action: host still alive afterwards', client.alive());
  r = await client.request({ action: 'status' });
  check('unknown action: status still works afterwards', runningOf(r) === true, j(r));

  /* ---------- 6. token must never leak outside framed JSON ---------- */
  console.log('\n[6] host khong in token ra stdout (ngoai JSON framed)');
  const unframed = client.unframedStdout();
  check('stdout: no unframed bytes at all (only framed JSON)',
    unframed.length === 0, unframed.length ? JSON.stringify(unframed.slice(0, 200)) : '');
  check('stdout: token never appears outside framed JSON',
    token.length === 0 || !unframed.includes(token));
  const stderrText = Buffer.concat(client.rawErr).toString('utf8');
  check('stderr: token never appears there either',
    token.length === 0 || !stderrText.includes(token));

  /* ---------- 7. garbage input (LAST): no crash ---------- */
  console.log('\n[7] input hong (bytes rac / JSON sai, khong crash host)');
  {
    // Framed but invalid JSON first (clean framing, bad payload).
    const bad = Buffer.from('{not json v360', 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bad.length, 0);
    client.sendRaw(Buffer.concat([header, bad]));
    await sleep(800);
    check('invalid JSON frame: host still alive', client.alive());
    // Raw garbage bytes (no framing at all). A corrupt length prefix
    // > 1 MB CANNOT be resynced — there is no sync marker in a
    // length-prefixed stream — so the correct behaviour is a clean,
    // logged shutdown, not a crash: the host logs 'frame too large'
    // to stderr and exits with code 1 (no signal, no uncaught
    // exception), and Chrome relaunches it on the next connectNative.
    // (Framed invalid JSON, above, is different: framing is intact,
    // so the host answers an error and stays alive.)
    client.sendRaw(Buffer.from('GARBAGE-NOT-A-FRAME-v360', 'utf8'));
    await sleep(800);
    check('garbage bytes: host exits cleanly with code 1 (no signal, no crash)',
      !client.alive() && host.exitCode === 1 && host.signalCode === null,
      client.alive() ? 'host still alive' : 'exitCode=' + host.exitCode + ' signal=' + host.signalCode);
    check('garbage bytes: stderr explains frame too large',
      hostOut.includes('frame too large'), hostOut.slice(-200));
  }

  cleanup(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
