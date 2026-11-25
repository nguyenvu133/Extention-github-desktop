/**
 * tests/node12-test.js — Bridge runs on Node 12 (v3.7.1).
 *
 * v3.7.1 lowered the minimum Node from 16.13 to 12.0.0: the bridge
 * avoids every post-12 syntax/API (no ?. / ?? / replaceAll / .at /
 * AbortController / structuredClone). This suite boots the REAL bridge
 * under a Node 12 runtime and exercises the exact lines that used to
 * be Node 14+ syntax:
 *   - normalizeRepo(): `r.id ?? null`  (GET /api/github/repos, mock)
 *   - auto-update tick: `setTimeout(...).unref?.()` (POST auto-update)
 *   - rate-limit fallback: `core.limit ?? ...` (GET /api/github/rate-limit)
 *
 * The bridge binary is `process.env.BRIDGE_NODE || process.execPath`:
 *   BRIDGE_NODE=/path/to/node12 node tests/node12-test.js
 * Run it that way to prove Node 12 for real. Under run-all it uses
 * the ambient Node (on a Node 12 machine that IS Node 12).
 *
 * Run:  node tests/node12-test.js   (or: npm --prefix bridge run test:v361)
 */
'use strict';
require('./_node16-fetch'); // Node 12/16 have no global fetch
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_ENTRY = path.join(ROOT, 'bridge', 'bridge-server.js');
const BRIDGE_NODE = process.env.BRIDGE_NODE || process.execPath;
const MOCK_PORT = 17416;
const BRIDGE_PORT = 17396;
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
// Test-only dummy values (never real, never printed in full).
const GOOD_PAT = 'gho_node12testtoken1234567';
const MANIFEST_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;

let failures = 0;
let passes = 0;
function check(name, condition, detail) {
  if (condition) { passes += 1; console.log(`  PASS  ${name}`); }
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
};
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }); }

/* Mock GitHub: /user + /user/repos + /rate_limit. */
function mockHandler(req, res) {
  const url = new URL(req.url, MOCK_BASE);
  const json = (status, obj, extraHeaders) => {
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}));
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === '/user' && req.method === 'GET') {
    if (req.headers.authorization !== `Bearer ${GOOD_PAT}`) return json(401, { message: 'Bad credentials' });
    return json(200, { login: 'nguyenvu133', id: 133, name: 'Nguyen Vu', email: 'nguyenvu16592b@gmail.com' });
  }
  if (url.pathname === '/user/repos' && req.method === 'GET') {
    if (req.headers.authorization !== `Bearer ${GOOD_PAT}`) return json(401, { message: 'Bad credentials' });
    return json(200, [
      { id: 42, name: 'demo', full_name: 'octocat/demo', owner: { login: 'octocat', avatar_url: '' } },
      { id: null, name: 'noname', full_name: 'octocat/noname', owner: { login: 'octocat', avatar_url: '' } },
    ]);
  }
  if (url.pathname === '/rate_limit' && req.method === 'GET') {
    return json(200, { resources: { core: { limit: 60, remaining: 59, reset: 1799999999, used: 1 } }, rate: { limit: 60, remaining: 59, reset: 1799999999, used: 1 } });
  }
  return json(404, { message: 'Not Found' });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Which Node is actually running the bridge in this run?
  let nodeVersion = '';
  try { nodeVersion = execFileSync(BRIDGE_NODE, ['--version'], { encoding: 'utf8' }).trim(); }
  catch (_) { nodeVersion = '(cannot run BRIDGE_NODE)'; }
  console.log(`\nnode12-test: bridge runtime = ${BRIDGE_NODE} (${nodeVersion})`);
  if (process.env.BRIDGE_NODE) {
    check('BRIDGE_NODE is really Node 12 (v12.x)', /^v12\./.test(nodeVersion), nodeVersion);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node12-test-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // .env auto sign-in (v3.5.1) must also work under Node 12.
  fs.writeFileSync(path.join(dataDir, '.env'), `GITHUB_PAT=${GOOD_PAT}\n`);
  const mock = http.createServer(mockHandler);
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const repoDir = path.join(tmp, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir, env: GIT_ENV });
  fs.writeFileSync(path.join(repoDir, 'f.txt'), 'hello\n');
  execFileSync('git', ['add', 'f.txt'], { cwd: repoDir, env: GIT_ENV });
  execFileSync('git', ['commit', '-q', '-m', 'c1'], { cwd: repoDir, env: GIT_ENV });

  const bridge = spawn(BRIDGE_NODE, [BRIDGE_ENTRY], {
    env: {
      ...GIT_ENV, BRIDGE_PORT: String(BRIDGE_PORT), BRIDGE_DATA_DIR: dataDir,
      GITHUB_API_BASE: MOCK_BASE, GITHUB_OAUTH_BASE: MOCK_BASE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bridgeOut = '';
  bridge.stdout.on('data', (d) => { bridgeOut += d; });
  bridge.stderr.on('data', (d) => { bridgeOut += d; });
  const cleanup = (code) => {
    try { bridge.kill('SIGTERM'); } catch (_) {}
    try { mock.close(); } catch (_) {}
    if (failures) {
      console.log('\n--- bridge log (last 25 lines, token redacted) ---');
      console.log(bridgeOut.split('\n').slice(-25).join('\n').replace(/TOKEN:\s*\S+/g, 'TOKEN: [redacted]'));
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nnode12-test: ${passes} passed, ${failures} failed`);
    process.exit(code);
  };

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('bridge did not start: ' + bridgeOut)), 20000);
      const iv = setInterval(() => { if (bridgeOut.includes('Listening:')) { clearTimeout(t); clearInterval(iv); resolve(); } }, 100);
    });
  } catch (err) { console.log('  FAIL  bridge starts under Node 12 -> ' + err.message); return cleanup(1); }

  const token = fs.readFileSync(path.join(dataDir, '.bridge-token'), 'utf8').trim();
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  async function call(method, p, body) {
    const res = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }
  const j = (r) => JSON.stringify(r).slice(0, 300);

  console.log('\n[0] boot + health (no SyntaxError, old Node accepted)');
  check('bridge starts, no SyntaxError in log', !/SyntaxError/.test(bridgeOut), bridgeOut.slice(0, 300));
  check('bridge log shows version ' + MANIFEST_VERSION,
    new RegExp('v' + MANIFEST_VERSION.replace(/\./g, '\\.')).test(bridgeOut), bridgeOut.slice(0, 200));
  {
    const h = await call('GET', '/health');
    check('health ok + manifest version', h.ok === true && h.version === MANIFEST_VERSION, j(h));
  }
  {
    const me = await call('GET', '/api/github/me');
    check('auto sign-in from .env PAT works on Node 12', me.ok === true && me.authed === true && me.user && me.user.login === 'nguyenvu133', j(me));
  }

  console.log('\n[1] normalizeRepo ex-?? line (GET /api/github/repos)');
  {
    const r = await call('GET', '/api/github/repos?per_page=100');
    const repos = r.repos || r.items || [];
    check('repos list ok', r.ok === true && Array.isArray(repos) && repos.length === 2, j(r));
    check('normalizeRepo keeps a numeric id (42)', repos[0] && repos[0].id === 42, j(repos[0]));
    check('normalizeRepo maps a null id to null (was `?? null`)', repos[1] && repos[1].id === null, j(repos[1]));
  }

  console.log('\n[2] rate-limit ex-?? lines (GET /api/github/rate-limit)');
  {
    const r = await call('GET', '/api/github/rate-limit');
    check('rate-limit returns mock core values', r.ok === true && r.limit === 60 && r.remaining === 59, j(r));
  }

  console.log('\n[3] local git works on Node 12');
  {
    const r = await call('POST', '/api/repo/select', { path: repoDir });
    check('select repo', r.ok === true, j(r));
    const st = await call('GET', '/api/git/status');
    check('git status ok (clean tree)', st.status === 200 && st.branch === 'main' && Array.isArray(st.files) && st.files.length === 0, j(st));
  }

  console.log('\n[4] auto-update tick ex-?.() line (POST /api/github/auto-update)');
  {
    const r = await call('POST', '/api/github/auto-update', { enabled: true, intervalSeconds: 15, autoSync: false });
    check('auto-update enabled', r.ok === true, j(r));
    await sleep(1500); // the 500 ms immediate tick (setTimeout().unref fix) fires here
    const h = await call('GET', '/health');
    check('bridge still alive after the immediate auto-update tick', h.ok === true && h.version === MANIFEST_VERSION, j(h));
    const off = await call('POST', '/api/github/auto-update', { enabled: false });
    check('auto-update disabled again', off.ok === true, j(off));
  }

  return cleanup(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
