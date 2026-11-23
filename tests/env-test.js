/**
 * tests/env-test.js — .env auto-config (v3.5.1).
 *
 * The bridge reads bridge/.env (or BRIDGE_DATA_DIR/.env) on startup and
 * fills in missing process.env keys: BRIDGE_TOKEN, GITHUB_PAT,
 * GITHUB_OAUTH_CLIENT_ID/SECRET, DEFAULT_REPO_PATH. A real environment
 * variable always wins over .env. Only fake test values are used here
 * (never real credentials), and GitHub is a local mock server.
 *
 * Run:  node tests/env-test.js   (or: npm --prefix bridge run test:v351)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_ENTRY = path.join(ROOT, 'bridge', 'bridge-server.js');
const MOCK_PORT = 17415;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
// Test-only dummy values (never real, never printed in full).
const GOOD_PAT = 'gho_envtesttoken1234567890';
const BAD_PAT = 'gho_envtestbadtoken0000000';
const ENV_BRIDGE_TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8';
const FAKE_CLIENT_ID = 'Iv1.envtestclientid';
const FAKE_CLIENT_SECRET = 'envtest-fake-secret-only';
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

/* Mock GitHub: /user validates the Bearer token, /user/emails is open. */
function mockHandler(req, res) {
  const url = new URL(req.url, MOCK_BASE);
  const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/user' && req.method === 'GET') {
    if (req.headers.authorization !== `Bearer ${GOOD_PAT}`) return json(401, { message: 'Bad credentials' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-OAuth-Scopes': 'repo, read:user' });
    return res.end(JSON.stringify({ login: 'nguyenvu133', id: 133, name: 'Nguyen Vu', email: 'nguyenvu16592b@gmail.com' }));
  }
  if (url.pathname === '/user/emails' && req.method === 'GET') {
    return json(200, [{ email: 'nguyenvu16592b@gmail.com', primary: true, verified: true, visibility: 'public' }]);
  }
  return json(404, { message: 'Not Found' });
}

async function waitForListening(bridgeOut, getOut) {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('bridge did not start: ' + getOut())), 15000);
    const iv = setInterval(() => { if (getOut().includes('Listening:')) { clearTimeout(t); clearInterval(iv); resolve(); } }, 100);
  });
}

function startBridge(port, dataDir, extraEnv) {
  const bridge = spawn(process.execPath, [BRIDGE_ENTRY], {
    env: {
      ...GIT_ENV, BRIDGE_PORT: String(port), BRIDGE_DATA_DIR: dataDir,
      GITHUB_API_BASE: MOCK_BASE, GITHUB_OAUTH_BASE: MOCK_BASE,
      ...(extraEnv || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  bridge.stdout.on('data', (d) => { out += d; });
  bridge.stderr.on('data', (d) => { out += d; });
  return { bridge, getOut: () => out };
}

async function call(port, token, method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ...data };
}
const j = (r) => JSON.stringify(r).slice(0, 300);

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
  const mock = http.createServer(mockHandler);
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  // A real local git repo for DEFAULT_REPO_PATH.
  const repoDir = path.join(tmp, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir, env: GIT_ENV });
  fs.writeFileSync(path.join(repoDir, 'f.txt'), 'hello\n');
  execFileSync('git', ['add', 'f.txt'], { cwd: repoDir, env: GIT_ENV });
  execFileSync('git', ['commit', '-q', '-m', 'c1'], { cwd: repoDir, env: GIT_ENV });

  const cleanup = (code) => {
    try { mock.close(); } catch (_) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nenv-test: ${passes} passed, ${failures} failed`);
    process.exit(code);
  };

  /* ---------- 0. .env.example + .gitignore + setup scripts ---------- */
  console.log('\n[0] .env template, gitignore, setup scripts');
  const example = fs.readFileSync(path.join(ROOT, 'bridge', '.env.example'), 'utf8');
  check('.env.example exists and holds no live secret',
    !/github_pat_[A-Za-z0-9]{20,}/.test(example) && !/ghp_[A-Za-z0-9]{20,}/.test(example) && !/Ov23[A-Za-z0-9]{10,}/.test(example),
    'example must be a template, not real credentials');
  check('.env.example documents all supported keys',
    ['BRIDGE_TOKEN=', 'BRIDGE_PORT=', 'GITHUB_PAT=', 'GITHUB_OAUTH_CLIENT_ID=', 'GITHUB_OAUTH_CLIENT_SECRET=', 'DEFAULT_REPO_PATH=']
      .every((k) => example.includes(k)));
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  check('.gitignore blocks .env (real file) but not .env.example',
    /(^|\n)\.env\s*$/m.test(gitignore) && /(^|\n)bridge\/\.env\s*$/m.test(gitignore)
    && gitignore.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).every((l) => !l.includes('.env.example')));
  const batBuf = fs.readFileSync(path.join(ROOT, 'bridge', 'setup-env.bat'));
  const batText = batBuf.toString('utf8');
  check('setup-env.bat: CRLF on every line, 100% ASCII, no BOM',
    !batBuf.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && batText.split('\r\n').every((l) => /^[\x00-\x7F]*$/.test(l)) && !/\n(?!\r)/.test(batText.replace(/\r\n/g, '')) && batText.includes('endlocal'));
  check('setup-env.bat: writes .env with BRIDGE_TOKEN + GITHUB_PAT + OAuth',
    /GITHUB_PAT=/.test(batText) && /BRIDGE_TOKEN=/.test(batText) && /GITHUB_OAUTH_CLIENT_ID=/.test(batText) && /\.env/.test(batText));
  const shText = fs.readFileSync(path.join(ROOT, 'bridge', 'setup-env.sh'), 'utf8');
  check('setup-env.sh: LF only, ASCII, chmod 600, writes .env',
    !/\r/.test(shText) && /^[\x00-\x7F]*$/.test(shText) && /chmod 600/.test(shText) && /GITHUB_PAT=/.test(shText));
  try { fs.accessSync(path.join(ROOT, 'bridge', 'setup-env.sh'), fs.constants.X_OK); check('setup-env.sh is executable', true); }
  catch (_) { check('setup-env.sh is executable', false); }

  /* ---------- 1. .env auto-config (good PAT, quotes/comments/export) ---------- */
  console.log('\n[1] .env auto-config: quotes, comments, export, spaces');
  const dataDir1 = path.join(tmp, 'data1');
  fs.mkdirSync(dataDir1, { recursive: true });
  fs.writeFileSync(path.join(dataDir1, '.env'), [
    '# comment line — ignored',
    '',
    `export BRIDGE_TOKEN="${ENV_BRIDGE_TOKEN}"`,
    `GITHUB_PAT = '${GOOD_PAT}'`,
    `GITHUB_OAUTH_CLIENT_ID=${FAKE_CLIENT_ID}`,
    `GITHUB_OAUTH_CLIENT_SECRET="${FAKE_CLIENT_SECRET}"`,
    `DEFAULT_REPO_PATH=${repoDir}`,
    'UNKNOWN_KEY=ignored-but-harmless',
    '',
  ].join('\n'));
  const b1 = startBridge(17391, dataDir1);
  try { await waitForListening(b1.bridge, b1.getOut); } catch (err) { console.log('  FAIL  bridge 1 starts -> ' + err.message); return cleanup(1); }
  // The bridge prints "TOKEN: <bridge token>" on startup by design
  // (the user needs it once for the extension), so strip that line
  // before asserting no secret values leak into the log.
  const logNoTokenLine = b1.getOut().replace(/TOKEN:\s*\S+/g, 'TOKEN: [redacted]');
  check('bridge 1: .env keys logged by name only (no secret values in log)',
    b1.getOut().includes('.env loaded') && !logNoTokenLine.includes(GOOD_PAT) && !logNoTokenLine.includes(FAKE_CLIENT_SECRET) && !logNoTokenLine.includes(ENV_BRIDGE_TOKEN));
  check('bridge 1: BRIDGE_TOKEN from .env mirrored into .bridge-token',
    fs.readFileSync(path.join(dataDir1, '.bridge-token'), 'utf8').trim() === ENV_BRIDGE_TOKEN);
  check('bridge 1: .env file chmod 600 after load',
    (fs.statSync(path.join(dataDir1, '.env')).mode & 0o777) === 0o600);
  {
    const h = await call(17391, ENV_BRIDGE_TOKEN, 'GET', '/health');
    check('bridge 1: /health ok, version ' + MANIFEST_VERSION, h.ok === true && h.version === MANIFEST_VERSION, j(h));
    const me = await call(17391, ENV_BRIDGE_TOKEN, 'GET', '/api/github/me');
    check('bridge 1: auto sign-in from .env PAT (nguyenvu133)', me.ok === true && me.authed === true && me.user && me.user.login === 'nguyenvu133', j(me));
    const st = await call(17391, ENV_BRIDGE_TOKEN, 'GET', '/api/github/oauth/status');
    check('bridge 1: OAuth App auto-configured from .env', st.configured === true || (st.clientIdConfigured === true && st.clientSecretConfigured === true), j(st));
    const cur = await call(17391, ENV_BRIDGE_TOKEN, 'GET', '/api/repo/current');
    check('bridge 1: DEFAULT_REPO_PATH auto-selected', cur.ok === true && JSON.stringify(cur).includes(repoDir), j(cur));
    check('bridge 1: PAT saved to .github-config.json (0600)',
      fs.existsSync(path.join(dataDir1, '.github-config.json')) && (fs.statSync(path.join(dataDir1, '.github-config.json')).mode & 0o777) === 0o600);
    const emails = await call(17391, ENV_BRIDGE_TOKEN, 'GET', '/api/github/user/emails');
    check('bridge 1: real-login email check sees nguyenvu16592b@gmail.com',
      Array.isArray(emails.emails) && emails.emails.some((e) => e.email === 'nguyenvu16592b@gmail.com' && e.primary === true), j(emails));
  }
  b1.bridge.kill('SIGTERM');

  /* ---------- 2. real env wins over .env ---------- */
  console.log('\n[2] precedence: real environment variable beats .env');
  const dataDir2 = path.join(tmp, 'data2');
  fs.mkdirSync(dataDir2, { recursive: true });
  fs.writeFileSync(path.join(dataDir2, '.env'), `GITHUB_PAT=${GOOD_PAT}\n`);
  const b2 = startBridge(17392, dataDir2, { GITHUB_PAT: BAD_PAT });
  try { await waitForListening(b2.bridge, b2.getOut); } catch (err) { console.log('  FAIL  bridge 2 starts -> ' + err.message); return cleanup(1); }
  {
    const token2 = fs.readFileSync(path.join(dataDir2, '.bridge-token'), 'utf8').trim();
    const me = await call(17392, token2, 'GET', '/api/github/me');
    check('bridge 2: real-env BAD_PAT wins, so not authed (mock rejects it)', me.authed === false, j(me));
    const h = await call(17392, token2, 'GET', '/health');
    check('bridge 2: bridge still starts and answers with bad PAT', h.ok === true, j(h));
  }
  b2.bridge.kill('SIGTERM');

  /* ---------- 3. invalid PAT in .env: bridge still starts ---------- */
  console.log('\n[3] invalid PAT in .env: warning only, bridge stays up');
  const dataDir3 = path.join(tmp, 'data3');
  fs.mkdirSync(dataDir3, { recursive: true });
  fs.writeFileSync(path.join(dataDir3, '.env'), `GITHUB_PAT=${BAD_PAT}\nGITHUB_OAUTH_CLIENT_ID=${FAKE_CLIENT_ID}\nGITHUB_OAUTH_CLIENT_SECRET=${FAKE_CLIENT_SECRET}\nDEFAULT_REPO_PATH=/does/not/exist\n`);
  const b3 = startBridge(17393, dataDir3);
  try { await waitForListening(b3.bridge, b3.getOut); } catch (err) { console.log('  FAIL  bridge 3 starts -> ' + err.message); return cleanup(1); }
  {
    const token3 = fs.readFileSync(path.join(dataDir3, '.bridge-token'), 'utf8').trim();
    const me = await call(17393, token3, 'GET', '/api/github/me');
    check('bridge 3: invalid PAT does not sign in', me.authed === false, j(me));
    const st = await call(17393, token3, 'GET', '/api/github/oauth/status');
    check('bridge 3: OAuth still configured from .env', st.configured === true || st.clientIdConfigured === true, j(st));
    check('bridge 3: bad DEFAULT_REPO_PATH only logs a warning, no crash',
      b3.getOut().includes('DEFAULT_REPO_PATH') && b3.getOut().includes('Listening:'));
    check('bridge 3: no secret value in the startup log',
      !b3.getOut().includes(BAD_PAT) && !b3.getOut().includes(FAKE_CLIENT_SECRET));
  }
  b3.bridge.kill('SIGTERM');

  return cleanup(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
