'use strict';
require('./_node16-fetch'); // Node 16.13 has no global fetch
/*
 * Bridge v3.1.1 test — routes behind the always-visible toolbar
 * (Repository / Branch / Fetch origin / Pull origin / Push origin):
 *   - /api/repo/recent and /api/repo/find (is owner/repo cloned here?)
 *   - /api/git/fetch per remote (token only for https github.com
 *     remotes), NO_REMOTE error, lastFetchAt
 *   - /api/git/clone creates a missing parent folder, remembers the repo
 *   - publish a new branch (push --set-upstream) and ahead/behind
 *
 * Usage: node tests/bridge-v311-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const BRIDGE_ENTRY = path.join(__dirname, '..', 'bridge', 'bridge-server.js');
const MOCK_PORT = 17413;
const BRIDGE_PORT = 17387;
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
const GOOD_TOKEN = 'ghp_v311testtoken1234567890';
let passes = 0;
let failures = 0;
function check(name, cond, detail) {
  if (cond) { passes += 1; console.log('  PASS  ' + name); } else { failures += 1; console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')); }
}
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com' };
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }); }
function commitFile(dir, file, text, msg) { fs.writeFileSync(path.join(dir, file), text); git(dir, 'add', file); git(dir, 'commit', '-q', '-m', msg); }

function mockHandler(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/user' && req.headers.authorization === `Bearer ${GOOD_TOKEN}`) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-OAuth-Scopes': 'repo, read:user' });
    return res.end(JSON.stringify({ login: 'octocat', id: 1, avatar_url: '' }));
  }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Bad credentials' }));
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v311-test-'));
  const home = path.join(tmp, 'home');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(home); fs.mkdirSync(dataDir);
  const mock = http.createServer(mockHandler);
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const remote = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const A = path.join(tmp, 'a');
  const B = path.join(tmp, 'b');
  const NR = path.join(tmp, 'noremote');
  execFileSync('git', ['clone', '-q', remote, A], { env: GIT_ENV, stdio: 'ignore' });
  git(A, 'checkout', '-q', '-b', 'main');
  commitFile(A, 'f.txt', '1\n', 'c1');
  git(A, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remote, B], { env: GIT_ENV, stdio: 'ignore' });
  fs.mkdirSync(NR); git(NR, 'init', '-q'); commitFile(NR, 'x.txt', 'x\n', 'x');

  const bridge = spawn(process.execPath, [BRIDGE_ENTRY], {
    env: { ...GIT_ENV, HOME: home, USERPROFILE: home, BRIDGE_PORT: String(BRIDGE_PORT), BRIDGE_DATA_DIR: dataDir, GITHUB_API_BASE: `http://127.0.0.1:${MOCK_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  bridge.stdout.on('data', (d) => { out += d; });
  bridge.stderr.on('data', (d) => { out += d; });
  const cleanup = (code) => {
    try { bridge.kill('SIGTERM'); } catch (_) {}
    try { mock.close(); } catch (_) {}
    if (failures) console.log('\n--- bridge log ---\n' + out.split('\n').slice(-30).join('\n'));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nbridge-v311: ${passes} passed, ${failures} failed`);
    process.exit(code);
  };
  for (let i = 0; i < 150 && !out.includes('Listening:'); i += 1) await new Promise((r) => setTimeout(r, 100));
  check('bridge v3.1.1 starts on Node ' + process.version, /v3\.1\.1/.test(out), out.slice(0, 200));
  const token = fs.readFileSync(path.join(dataDir, '.bridge-token'), 'utf8').trim();
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  async function call(method, p, body) {
    const res = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }
  const j = (r) => JSON.stringify(r).slice(0, 300);

  let r = await call('GET', '/api/repo/recent');
  check('recent: empty at start + defaultCloneDir under home', r.ok && r.repos.length === 0 && r.defaultCloneDir === path.join(home, 'GitHub'), j(r));

  /* fetch without any remote */
  r = await call('POST', '/api/repo/select', { path: NR });
  r = await call('POST', '/api/git/fetch', {});
  check('fetch with no remote -> NO_REMOTE + Vietnamese hint', r.status >= 400 && r.code === 'NO_REMOTE' && /remote/.test(r.error || ''), j(r));

  /* select A, fetch */
  r = await call('POST', '/api/repo/select', { path: A });
  check('select A', r.ok === true, j(r));
  r = await call('GET', '/api/repo/recent');
  check('recent lists A (current) and the no-remote repo', r.repos.length === 2 && r.repos[0].path === A && r.repos[0].current === true, j(r));
  commitFile(B, 'g.txt', 'g\n', 'from B');
  git(B, 'push', '-q');
  r = await call('POST', '/api/git/fetch', {});
  check('fetch ok, per-remote results', r.ok === true && Array.isArray(r.results) && r.results[0].remote === 'origin' && r.results[0].ok === true, j(r));
  check('fetch returns behind=1 + lastFetchAt', r.behind === 1 && r.ahead === 0 && typeof r.lastFetchAt === 'string', j(r));
  check('fetch: no token used for a local (non-github) remote', r.results[0].usedGithubAuth === false, j(r));
  r = await call('GET', '/api/git/ahead-behind');
  check('ahead-behind carries lastFetchAt', typeof r.lastFetchAt === 'string' && r.behind === 1, j(r));
  r = await call('POST', '/api/git/fetch', { remote: 'nope' });
  check('fetch unknown remote -> error', r.status >= 400 && /No such remote/.test(r.error || ''), j(r));
  r = await call('POST', '/api/git/fetch', { remote: 'bad name;rm' });
  check('fetch invalid remote name rejected', r.status >= 400, j(r));

  /* history recorded */
  r = await call('GET', '/api/git/sync-history?limit=5');
  check('fetch recorded in sync history', Array.isArray(r.history || r.entries) && (r.history || r.entries).some((e) => e.op === 'fetch'), j(r));

  /* github remote -> token offered (signed in) */
  r = await call('POST', '/api/github/auth', { token: GOOD_TOKEN });
  check('sign in (mock)', r.ok === true || r.status === 200, j(r));
  git(A, 'remote', 'add', 'gh', 'https://github.com/octocat-nonexistent-zz9/none.git');
  r = await call('POST', '/api/git/fetch', {});
  const ghRes = (r.results || []).find((x) => x.remote === 'gh');
  const originRes = (r.results || []).find((x) => x.remote === 'origin');
  check('fetch all: origin ok even if gh fails (200, partial)', r.status === 200 && originRes && originRes.ok === true, j(r));
  check('fetch all: GitHub token offered only to the github.com remote', ghRes && ghRes.usedGithubAuth === true && originRes.usedGithubAuth === false, j(r));
  check('token never written to .git/config', !/BRIDGE_GIT_TOKEN|ghp_/.test(fs.readFileSync(path.join(A, '.git', 'config'), 'utf8')));
  git(A, 'remote', 'remove', 'gh');

  /* find */
  r = await call('GET', '/api/repo/find?fullName=octocat/demo');
  check('find: not cloned yet + suggestedPath ~/GitHub/demo', r.ok && r.found === false && r.suggestedPath === path.join(home, 'GitHub', 'demo'), j(r));
  r = await call('GET', '/api/repo/find?fullName=bad');
  check('find: invalid fullName rejected', r.status >= 400, j(r));

  /* clone into a missing parent (~/GitHub does not exist yet) */
  const dest = path.join(home, 'GitHub', 'demo');
  r = await call('POST', '/api/git/clone', { url: remote, path: dest });
  check('clone creates missing parent folder', r.ok === true && fs.existsSync(path.join(dest, '.git')), j(r));
  check('clone selects the new repo', r.repository && r.repository.path === dest, j(r));
  git(dest, 'remote', 'set-url', 'origin', 'https://github.com/octocat/demo.git');
  await call('POST', '/api/repo/select', { path: dest });
  r = await call('GET', '/api/repo/find?fullName=OctoCat/Demo');
  check('find: matches github remote (case-insensitive)', r.found === true && r.path === dest, j(r));
  r = await call('GET', '/api/repo/recent');
  check('recent: fullName parsed from github remote', r.repos.some((x) => x.path === dest && x.fullName === 'octocat/demo'), j(r));
  r = await call('POST', '/api/git/clone', { url: remote, path: dest });
  check('clone into non-empty folder refused', r.status >= 400 && /not empty/.test(r.error || ''), j(r));

  /* publish a new branch from A */
  await call('POST', '/api/repo/select', { path: A });
  await call('POST', '/api/git/pull', { mode: 'merge' });
  git(A, 'checkout', '-q', '-b', 'feature/toolbar');
  commitFile(A, 't.txt', 't\n', 'toolbar');
  r = await call('GET', '/api/git/ahead-behind');
  check('new branch: hasUpstream false (toolbar shows Publish branch)', r.hasUpstream === false && r.branch === 'feature/toolbar', j(r));
  r = await call('POST', '/api/git/push', { remote: 'origin', setUpstream: true });
  check('publish branch (push -u) ok', r.ok === true, j(r));
  r = await call('GET', '/api/git/ahead-behind');
  check('after publish: upstream set, ahead 0', r.hasUpstream === true && r.ahead === 0, j(r));

  /* state survives restart */
  const state = JSON.parse(fs.readFileSync(fs.readdirSync(dataDir).map((f) => path.join(dataDir, f)).find((f) => /state/i.test(f) && f.endsWith('.json')), 'utf8'));
  check('recentRepos persisted in state file', Array.isArray(state.recentRepos) && state.recentRepos.length >= 3, JSON.stringify(state).slice(0, 200));

  cleanup(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
