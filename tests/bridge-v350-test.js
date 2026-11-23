'use strict';
require('./_node16-fetch'); // Node 16.13 has no global fetch

/*
 * Bridge v3.5.0 test — pull origin / mock-OAuth end-to-end / new
 * v3.5.0 bridge routes (Actions, commit detail, compare, languages,
 * contributors, topics, issue/PR detail, worktrees, graph, upstream,
 * pull all remotes).
 *
 * Self-contained like bridge-v310/v311: own mock GitHub server, own
 * bridge on port 17388 (mock on 17414 — neither collides with any
 * port in tests/run-all.js), REAL local git repositories (a bare
 * "origin" + a bare "upstream" + clones A driven by the bridge and
 * B playing "someone else").
 *
 *   (a) Pull origin against REAL local git: pull origin main, pull
 *       origin feature branch, pull with autostash over a dirty
 *       tree, pull --rebase with a conflict then resolve it, pull
 *       all remotes (POST /api/git/pull/remotes), undo last pull
 *       (POST /api/git/pull/undo), GET /api/git/upstream. Every
 *       sub-case asserts on real git state (files / branches / log),
 *       not just HTTP 200.
 *   (b) Mock-OAuth end-to-end (NO real github.com, NO password):
 *       mock GitHub handles POST /login/oauth/access_token (fake
 *       token), GET /user (login nguyenvu133) and GET /user/emails
 *       (primary nguyenvu16592b@gmail.com + one secondary). Drives
 *       oauth/start -> callback -> token exchange -> /api/github/me
 *       and /api/github/user/emails. Fake client id/secret come
 *       from env vars (GITHUB_OAUTH_CLIENT_ID /
 *       GITHUB_OAUTH_CLIENT_SECRET) — the real
 *       bridge/.github-oauth.json is never read.
 *   (c) New bridge routes smoke against the mock GitHub server:
 *       Actions workflows/runs/jobs/logs/rerun/cancel, commit
 *       detail, compare, languages/contributors/topics, issue
 *       detail + comment post, PR detail + files + reviews,
 *       worktrees add/remove, graph, user/emails. Each asserts the
 *       bridge returns the MOCK data, not just ok:true.
 *
 * ROUTES NOT BUILT YET: the bridge workstream is building the v3.5.0
 * routes in parallel. A contract route that answers 404 "Unknown
 * endpoint" is reported as MISSING-ROUTE (counted as a failure, and
 * listed again in the summary at the end) — the test is NOT weakened
 * to pass without the route. Run this file again after the bridge
 * workstream lands; the MISSING-ROUTE lines should disappear.
 *
 * Usage: node tests/bridge-v350-test.js
 * Cleans up after itself (kills mock + bridge, removes temp dirs)
 * and exits non-zero on any failure. No real GitHub API is called.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_ENTRY = path.join(ROOT, 'bridge', 'bridge-server.js');
const MOCK_PORT = 17414;
const BRIDGE_PORT = 17388;
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
// Test-only dummy OAuth credentials (never real, never printed).
const FAKE_CLIENT_ID = 'Iv1.v350fakeclientid';
const FAKE_CLIENT_SECRET = 'v350-fake-secret-for-tests-only';
const FAKE_GH_TOKEN = 'gho_v350faketoken1234567890';
const MANIFEST_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;

let failures = 0;
let passes = 0;
const missingRoutes = [];
function check(name, condition, detail) {
  if (condition) { passes += 1; console.log(`  PASS  ${name}`); }
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}
function missing(name, detail) {
  // A contract route the bridge does not implement yet: 404 "Unknown
  // endpoint". Counted as a failure and listed in the final summary.
  missingRoutes.push(name);
  failures += 1;
  console.log(`  MISSING-ROUTE  ${name}${detail ? ' -> ' + detail : ''}`);
}
function isMissingRoute(r) {
  return r && r.status === 404 && /Unknown endpoint/.test(r.error || '');
}
// Assert the bridge returned the mock data: either a structured field
// matches, or the mock fragment appears somewhere in the JSON body.
function hasData(r, fragment) {
  return JSON.stringify(r || {}).includes(fragment);
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
};
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }); }
function write(dir, file, text) { fs.writeFileSync(path.join(dir, file), text); }
function read(dir, file) { return fs.readFileSync(path.join(dir, file), 'utf8'); }
function commitFile(dir, file, text, msg) { write(dir, file, text); git(dir, 'add', file); git(dir, 'commit', '-q', '-m', msg); }
function sha(dir, ref = 'HEAD') { return git(dir, 'rev-parse', ref).trim(); }
function refExists(dir, ref) {
  try { git(dir, 'show-ref', '--verify', '--quiet', ref); return true; } catch (_) { return false; }
}

/* ------------------------------------------------------------------ */
/* Mock GitHub (API + OAuth token endpoint, same server)               */
/* ------------------------------------------------------------------ */

const mockState = { tokenExchange: null, userAuth: '' };
function mockJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function mockHandler(req, res) {
  const url = new URL(req.url, MOCK_BASE);
  const p = url.pathname;
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    // --- OAuth token exchange (GITHUB_OAUTH_BASE) ---
    if (p === '/login/oauth/access_token' && req.method === 'POST') {
      const params = new URLSearchParams(body);
      mockState.tokenExchange = {
        client_id: params.get('client_id'),
        hasSecret: !!params.get('client_secret'),
        code: params.get('code'),
      };
      return mockJson(res, 200, { access_token: FAKE_GH_TOKEN, token_type: 'bearer', scope: 'repo,read:user' });
    }
    // --- /user + /user/emails (GITHUB_API_BASE) ---
    if (p === '/user' && req.method === 'GET') {
      mockState.userAuth = req.headers.authorization || '';
      if (req.headers.authorization !== `Bearer ${FAKE_GH_TOKEN}`) {
        return mockJson(res, 401, { message: 'Bad credentials' });
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-OAuth-Scopes': 'repo, read:user' });
      return res.end(JSON.stringify({ login: 'nguyenvu133', id: 133, name: 'Nguyen Vu', email: 'nguyenvu16592b@gmail.com', avatar_url: '', html_url: 'https://github.com/nguyenvu133' }));
    }
    if (p === '/user/emails' && req.method === 'GET') {
      return mockJson(res, 200, [
        { email: 'nguyenvu16592b@gmail.com', primary: true, verified: true, visibility: 'public' },
        { email: 'nguyenvu133.alt@example.com', primary: false, verified: true, visibility: null },
      ]);
    }
    // --- /repos/octocat/demo/... ---
    const m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/(.*)$/);
    if (m && m[1] === 'octocat' && m[2] === 'demo') {
      const rest = m[3];
      if (rest === 'actions/workflows' && req.method === 'GET') {
        // GitHub's real shape is an object { total_count, workflows } —
        // the bridge reads d.workflows, so the mock must too.
        return mockJson(res, 200, { total_count: 1, workflows: [{ id: 11, name: 'CI', path: '.github/workflows/ci.yml', state: 'active', created_at: '2026-01-01T00:00:00Z' }] });
      }
      if (rest === 'actions/runs' && req.method === 'GET') {
        return mockJson(res, 200, { total_count: 1, workflow_runs: [{ id: 101, name: 'CI', head_branch: 'main', status: 'completed', conclusion: 'success', html_url: 'https://github.com/octocat/demo/actions/runs/101' }] });
      }
      if (rest === 'actions/runs/101' && req.method === 'GET') {
        return mockJson(res, 200, { id: 101, name: 'CI', head_branch: 'main', status: 'completed', conclusion: 'success' });
      }
      if (rest === 'actions/runs/101/rerun' && req.method === 'POST') {
        return mockJson(res, 201, {});
      }
      if (rest === 'actions/runs/101/cancel' && req.method === 'POST') {
        return mockJson(res, 202, {});
      }
      if (rest === 'actions/runs/101/jobs' && req.method === 'GET') {
        return mockJson(res, 200, { total_count: 1, jobs: [{ id: 201, name: 'build', status: 'completed', conclusion: 'success' }] });
      }
      if (rest === 'actions/runs/101/logs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('fake-log-line-1\nfake-log-line-2\n');
      }
      if (rest === 'commits/abc123def4567890' && req.method === 'GET') {
        return mockJson(res, 200, { sha: 'abc123def4567890abcdef', commit: { message: 'v350 mock commit' }, author: { login: 'nguyenvu133' } });
      }
      const cmp = rest.match(/^compare\/(.+)\.\.\.(.+)$/);
      if (cmp && req.method === 'GET') {
        return mockJson(res, 200, {
          ahead_by: 2, behind_by: 1, total_commits: 2,
          commits: [
            { sha: 'c1', commit: { message: 'feat one' } },
            { sha: 'c2', commit: { message: 'feat two' } },
          ],
        });
      }
      if (rest === 'languages' && req.method === 'GET') {
        return mockJson(res, 200, { JavaScript: 12345, HTML: 678 });
      }
      if (rest === 'contributors' && req.method === 'GET') {
        return mockJson(res, 200, [{ login: 'nguyenvu133', contributions: 42 }]);
      }
      if (rest === 'topics' && req.method === 'GET') {
        return mockJson(res, 200, { names: ['pixijs', 'github-sync'] });
      }
      if (rest === 'issues/7' && req.method === 'GET') {
        return mockJson(res, 200, { number: 7, title: 'v350 mock issue', state: 'open', body: 'mock issue body' });
      }
      if (rest === 'issues/7/comments' && req.method === 'GET') {
        return mockJson(res, 200, [{ id: 301, body: 'first comment', user: { login: 'octocat' } }]);
      }
      if (rest === 'issues/7/comments' && req.method === 'POST') {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (_) {}
        return mockJson(res, 201, { id: 902, body: parsed.body || '', user: { login: 'nguyenvu133' } });
      }
      if (rest === 'pulls/3' && req.method === 'GET') {
        return mockJson(res, 200, { number: 3, title: 'v350 mock PR', state: 'open', merged: false });
      }
      if (rest === 'pulls/3/files' && req.method === 'GET') {
        return mockJson(res, 200, [{ filename: 'src/a.js', status: 'modified', additions: 3, deletions: 1 }]);
      }
      if (rest === 'pulls/3/reviews' && req.method === 'GET') {
        return mockJson(res, 200, [{ id: 401, state: 'APPROVED', user: { login: 'octocat' } }]);
      }
    }
    mockJson(res, 404, { message: 'Not Found' });
  });
}

/* ------------------------------------------------------------------ */
/* Test runner                                                         */
/* ------------------------------------------------------------------ */

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v350-test-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const mock = http.createServer(mockHandler);
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const origin = path.join(tmp, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const A = path.join(tmp, 'a');
  const B = path.join(tmp, 'b');
  execFileSync('git', ['clone', '-q', origin, A], { env: GIT_ENV, stdio: 'ignore' });
  git(A, 'checkout', '-q', '-b', 'main');
  commitFile(A, 'f.txt', 'line1\nline2\nline3\n', 'c1');
  git(A, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, B], { env: GIT_ENV, stdio: 'ignore' });
  git(B, 'config', 'user.name', 'Other');
  git(B, 'config', 'user.email', 'other@example.com');

  const bridge = spawn(process.execPath, [BRIDGE_ENTRY], {
    env: {
      ...GIT_ENV, BRIDGE_PORT: String(BRIDGE_PORT), BRIDGE_DATA_DIR: dataDir,
      GITHUB_API_BASE: MOCK_BASE, GITHUB_OAUTH_BASE: MOCK_BASE,
      GITHUB_OAUTH_CLIENT_ID: FAKE_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
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
      console.log('\n--- bridge log (last 30 lines, token redacted) ---');
      console.log(bridgeOut.split('\n').slice(-30).join('\n').replace(/TOKEN:\s*\S+/g, 'TOKEN: [redacted]'));
    }
    if (missingRoutes.length) {
      console.log('\n--- MISSING ROUTES (bridge workstream has not built these yet) ---');
      for (const name of missingRoutes) console.log('  - ' + name);
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nbridge-v350: ${passes} passed, ${failures} failed${missingRoutes.length ? ` (${missingRoutes.length} missing-route)` : ''}`);
    process.exit(code);
  };

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('bridge did not start: ' + bridgeOut)), 15000);
      const iv = setInterval(() => { if (bridgeOut.includes('Listening:')) { clearTimeout(t); clearInterval(iv); resolve(); } }, 100);
    });
  } catch (err) { console.log('  FAIL  bridge starts -> ' + err.message); return cleanup(1); }

  const token = fs.readFileSync(path.join(dataDir, '.bridge-token'), 'utf8').trim();
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  async function call(method, p, body) {
    const res = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }
  const j = (r) => JSON.stringify(r).slice(0, 300);

  /* ---------- 0. version / health ---------- */
  console.log('\n[0] version / health');
  check('bridge starts, version matches manifest (v' + MANIFEST_VERSION + ')',
    new RegExp('v' + MANIFEST_VERSION.replace(/\./g, '\\.')).test(bridgeOut), bridgeOut.slice(0, 200));
  {
    const h = await call('GET', '/health');
    check('health ok + manifest version', h.ok === true && h.version === MANIFEST_VERSION, j(h));
  }
  let r = await call('POST', '/api/repo/select', { path: A });
  check('select repo A', r.ok === true, j(r));

  /* ---------- 1. pull origin main ---------- */
  console.log('\n[1] pull origin main (real git)');
  commitFile(B, 'f.txt', 'LINE1-from-B\nline2\nline3\n', 'c2 from B');
  git(B, 'push', '-q');
  r = await call('POST', '/api/git/pull', { mode: 'merge' });
  check('pull origin main ok, 1 commit pulled', r.ok === true && (r.commitsPulled === 1 || r.fastForward === true), j(r));
  check('pull origin main: file content is B\'s version', read(A, 'f.txt') === 'LINE1-from-B\nline2\nline3\n', JSON.stringify(read(A, 'f.txt')));
  check('pull origin main: HEAD == B main', sha(A) === sha(B, 'main'));
  check('pull origin main: log subject is c2 from B', git(A, 'log', '-1', '--format=%s').trim() === 'c2 from B');

  /* ---------- 2. pull origin feature branch ---------- */
  console.log('\n[2] pull origin feature branch (real git)');
  git(A, 'checkout', '-q', '-b', 'feature');
  git(A, 'push', '-q', '-u', 'origin', 'feature');
  git(B, 'fetch', '-q', 'origin');
  git(B, 'checkout', '-q', '-b', 'feature', 'origin/feature');
  commitFile(B, 'feat.txt', 'feat\n', 'feature work');
  git(B, 'push', '-q');
  r = await call('POST', '/api/git/pull', { mode: 'merge' });
  check('pull origin feature ok', r.ok === true && (r.commitsPulled === 1 || r.fastForward === true), j(r));
  check('pull origin feature: feat.txt landed', read(A, 'feat.txt') === 'feat\n');
  check('pull origin feature: HEAD == B feature', sha(A) === sha(B, 'feature'));
  git(A, 'checkout', '-q', 'main');

  /* ---------- 3. autostash pull + undo ---------- */
  console.log('\n[3] pull with autostash over a dirty tree + undo (real git)');
  git(B, 'checkout', '-q', 'main');
  commitFile(B, 'f.txt', 'LINE1-v3\nline2\nline3\n', 'c3 from B');
  git(B, 'push', '-q');
  write(A, 'f.txt', 'LINE1-from-B\nline2\nLOCAL-line3\n'); // dirty edit, line 3 only
  const beforeAutostash = sha(A);
  r = await call('POST', '/api/git/pull', { mode: 'merge', autostash: true });
  check('pull with autostash succeeds', r.ok === true && r.commitsPulled === 1, j(r));
  check('autostash kept the local edit AND got the remote change',
    read(A, 'f.txt') === 'LINE1-v3\nline2\nLOCAL-line3\n', JSON.stringify(read(A, 'f.txt')));
  check('autostash pull: HEAD moved to B main', sha(A) === sha(B, 'main'));
  r = await call('GET', '/api/git/pull/last');
  check('pull/last: undo available after the autostash pull', r.undoAvailable === true, j(r));
  git(A, 'checkout', '--', 'f.txt');
  r = await call('POST', '/api/git/pull/undo', { confirm: true });
  check('undo pull restores the previous HEAD', r.ok === true && sha(A) === beforeAutostash, j(r));
  check('undo pull: file content is the pre-pull version',
    read(A, 'f.txt') === 'LINE1-from-B\nline2\nline3\n', JSON.stringify(read(A, 'f.txt')));
  r = await call('POST', '/api/git/pull/undo', { confirm: true });
  check('second undo refused (nothing to undo)', r.status === 400, j(r));
  r = await call('POST', '/api/git/pull', { mode: 'ff-only' });
  check('pull ff-only after undo re-syncs with B main',
    r.ok === true && r.fastForward === true && sha(A) === sha(B, 'main'), j(r));

  /* ---------- 4. pull --rebase with a conflict, then resolve ---------- */
  console.log('\n[4] pull --rebase conflict -> resolve -> continue (real git)');
  commitFile(B, 'f.txt', 'CONFLICT-B\nline2\nline3\n', 'B edits line1');
  git(B, 'push', '-q');
  commitFile(A, 'f.txt', 'CONFLICT-A\nline2\nline3\n', 'A edits line1');
  r = await call('POST', '/api/git/pull', { mode: 'rebase' });
  check('rebase pull conflict reported (200, ok:false, operation=rebase)',
    r.status === 200 && r.conflict === true && r.operation === 'rebase' && (r.conflicts || []).includes('f.txt'), j(r));
  r = await call('GET', '/api/git/operation');
  check('operation endpoint: rebase in progress', r.state === 'rebase', j(r));
  r = await call('POST', '/api/git/rebase/continue', {});
  check('rebase continue blocked while conflicts remain', r.status === 400 && r.code === 'UNRESOLVED_CONFLICTS', j(r));
  r = await call('POST', '/api/git/conflict/resolve', { path: 'f.txt', side: 'ours' });
  check('resolve "ours" during rebase = MY version',
    r.ok === true && r.gitSide === 'theirs' && read(A, 'f.txt').startsWith('CONFLICT-A'), j(r) + ' ' + read(A, 'f.txt'));
  r = await call('POST', '/api/git/rebase/continue', {});
  check('rebase continue finishes', r.ok === true && r.done === true, j(r));
  check('my commit now sits on top of B\'s',
    git(A, 'log', '-2', '--format=%s').trim() === 'A edits line1\nB edits line1',
    git(A, 'log', '-2', '--format=%s').trim());
  check('rebased file keeps my line1', read(A, 'f.txt').startsWith('CONFLICT-A'));
  r = await call('POST', '/api/git/push', {});
  check('push after rebase ok', r.ok === true, j(r));

  /* ---------- 5. pull all remotes + GET /api/git/upstream ---------- */
  console.log('\n[5] pull all remotes + upstream endpoint (real git)');
  const upstream = path.join(tmp, 'upstream.git');
  execFileSync('git', ['clone', '-q', '--bare', A, upstream]);
  execFileSync('git', ['--git-dir', upstream, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const C = path.join(tmp, 'c');
  execFileSync('git', ['clone', '-q', upstream, C], { env: GIT_ENV, stdio: 'ignore' });
  commitFile(C, 'up.txt', 'upstream work\n', 'up1 from upstream');
  git(C, 'push', '-q');
  git(A, 'remote', 'add', 'upstream', upstream);
  git(A, 'fetch', '-q', 'upstream');
  check('setup: upstream/main is 1 ahead of A main (precondition for pull/remotes)',
    sha(A, 'upstream/main') !== sha(A, 'main') &&
    git(A, 'log', '-1', '--format=%s', 'upstream/main').trim() === 'up1 from upstream');
  // NOTE (bridge behaviour, 2026-11-23): pull/remotes finds a remote's
  // default branch from refs/remotes/<remote>/HEAD. A plain `git fetch`
  // does NOT create that ref — only clone / `git remote set-head
  // --auto` does — so a manually-added remote reports "cannot
  // determine the default branch" until set-head runs. The first
  // call below pins that behaviour; the second call (after set-head)
  // is the real end-to-end pull.
  r = await call('POST', '/api/git/pull/remotes', {});
  if (isMissingRoute(r)) {
    missing('POST /api/git/pull/remotes', 'bridge returns 404 Unknown endpoint; upstream commit is waiting in upstream/main');
  } else {
    const upRes = (r.results || []).find((x) => x.remote === 'upstream');
    const originRes = (r.results || []).find((x) => x.remote === 'origin');
    check('pull/remotes (no remote HEAD yet): origin ok, upstream reports it cannot determine the default branch',
      r.ok === true && originRes && originRes.ok === true && upRes && upRes.ok === false && /nhánh mặc định/.test(upRes.error || ''), j(r));
    check('pull/remotes (no remote HEAD yet): nothing was merged from upstream',
      !fs.existsSync(path.join(A, 'up.txt')) && sha(A) !== sha(A, 'upstream/main'));
  }
  git(A, 'remote', 'set-head', 'upstream', '--auto');
  check('setup: refs/remotes/upstream/HEAD now points at upstream/main',
    git(A, 'symbolic-ref', '--short', 'refs/remotes/upstream/HEAD').trim() === 'upstream/main');
  r = await call('POST', '/api/git/pull/remotes', {});
  if (isMissingRoute(r)) {
    missing('POST /api/git/pull/remotes', 'bridge returns 404 Unknown endpoint; upstream commit is waiting in upstream/main');
  } else {
    const upRes = (r.results || []).find((x) => x.remote === 'upstream');
    check('pull/remotes (after set-head): ok + upstream pulled',
      r.ok === true && upRes && upRes.ok === true && upRes.pulled === true, j(r));
    check('pull/remotes: upstream commit landed in A (up.txt)',
      fs.existsSync(path.join(A, 'up.txt')) && read(A, 'up.txt') === 'upstream work\n');
    check('pull/remotes: A main == upstream/main', sha(A) === sha(A, 'upstream/main'));
  }
  r = await call('GET', '/api/git/upstream');
  if (isMissingRoute(r)) {
    missing('GET /api/git/upstream', 'bridge returns 404 Unknown endpoint');
  } else {
    check('GET /api/git/upstream: reports origin/main',
      r.ok === true && typeof r.upstream === 'string' && r.upstream === 'origin/main', j(r));
  }
  r = await call('GET', '/api/git/ahead-behind');
  check('ahead-behind (existing route): hasUpstream + upstream origin/main',
    r.hasUpstream === true && r.upstream === 'origin/main' && r.branch === 'main', j(r));

  /* ---------- 6. mock-OAuth end-to-end ---------- */
  console.log('\n[6] mock-OAuth end-to-end (no real github.com)');
  r = await call('GET', '/api/github/oauth/start');
  check('oauth/start: ok + authorize URL on the mock host',
    r.ok === true && typeof r.authorizeUrl === 'string' && r.authorizeUrl.startsWith(MOCK_BASE + '/login/oauth/authorize'),
    'authorizeUrl host wrong or missing');
  const startUrl = new URL(r.authorizeUrl || 'http://x/');
  const oauthState = startUrl.searchParams.get('state') || '';
  check('oauth/start: state minted + fake client id in the URL',
    oauthState.length >= 16 && startUrl.searchParams.get('client_id') === FAKE_CLIENT_ID,
    'state or client_id missing from authorize URL');
  // Simulate GitHub redirecting the browser back to the bridge.
  const cbRes = await fetch(`${BASE}/api/github/oauth/callback?code=fake-code-v350&state=${encodeURIComponent(oauthState)}`);
  const cbText = await cbRes.text();
  check('oauth/callback: 200 + success page names nguyenvu133',
    cbRes.status === 200 && cbText.includes('nguyenvu133'), `status ${cbRes.status}`);
  check('mock saw the token exchange with the fake client id',
    mockState.tokenExchange !== null && mockState.tokenExchange.client_id === FAKE_CLIENT_ID && mockState.tokenExchange.hasSecret === true && mockState.tokenExchange.code === 'fake-code-v350',
    'token exchange did not carry the fake client id / code');
  check('bridge validated the exchanged token via mock GET /user',
    mockState.userAuth === `Bearer ${FAKE_GH_TOKEN}`, 'bridge did not call /user with the exchanged token');
  const cbReplay = await fetch(`${BASE}/api/github/oauth/callback?code=fake-code-v350&state=${encodeURIComponent(oauthState)}`);
  check('oauth/callback replay with the same state is rejected (state is one-time)',
    cbReplay.status === 400, `status ${cbReplay.status}`);
  r = await call('GET', '/api/github/me');
  check('GET /api/github/me: authed as nguyenvu133 (oauth-web)',
    r.ok === true && r.authed === true && r.user && r.user.login === 'nguyenvu133', j(r));
  r = await call('GET', '/api/github/user/emails');
  if (isMissingRoute(r)) {
    missing('GET /api/github/user/emails', 'bridge returns 404 Unknown endpoint');
  } else {
    const emails = r.emails || r.data || [];
    check('GET /api/github/user/emails: primary is nguyenvu16592b@gmail.com + 1 secondary',
      r.ok === true && Array.isArray(emails) && emails.length === 2 &&
      emails.some((e) => e.email === 'nguyenvu16592b@gmail.com' && e.primary === true), j(r));
  }

  /* ---------- 7. new bridge routes smoke (mock GitHub data) ---------- */
  console.log('\n[7] Actions / commits / compare / repo meta (mock data, not just ok:true)');
  const O = 'owner=octocat&repo=demo';
  r = await call('GET', `/api/github/actions/workflows?${O}`);
  if (isMissingRoute(r)) missing('GET /api/github/actions/workflows?owner=&repo=');
  else check('actions workflows: returns the mock workflow (id 11, CI)',
    r.ok === true && hasData(r, '"id":11') && hasData(r, 'CI'), j(r));
  r = await call('GET', `/api/github/actions/runs?${O}`);
  if (isMissingRoute(r)) missing('GET /api/github/actions/runs?owner=&repo=');
  else check('actions runs: returns the mock run (id 101, success)',
    r.ok === true && hasData(r, '"id":101') && hasData(r, 'success'), j(r));
  r = await call('GET', `/api/github/actions/runs/101?${O}`);
  if (isMissingRoute(r)) missing('GET /api/github/actions/runs/:id?owner=&repo=');
  else check('actions run detail: id 101, conclusion success',
    r.ok === true && hasData(r, '"id":101') && hasData(r, 'success'), j(r));
  r = await call('POST', `/api/github/actions/runs/101/rerun?${O}`, {});
  if (isMissingRoute(r)) missing('POST /api/github/actions/runs/:id/rerun');
  else check('actions rerun: ok', r.ok === true, j(r));
  r = await call('POST', `/api/github/actions/runs/101/cancel?${O}`, {});
  if (isMissingRoute(r)) missing('POST /api/github/actions/runs/:id/cancel');
  else check('actions cancel: ok', r.ok === true, j(r));
  r = await call('GET', `/api/github/actions/runs/101/jobs?${O}`);
  if (isMissingRoute(r)) missing('GET /api/github/actions/runs/:id/jobs?owner=&repo=');
  else check('actions jobs: returns the mock job (id 201, build)',
    r.ok === true && hasData(r, '"id":201') && hasData(r, 'build'), j(r));
  r = await call('GET', `/api/github/actions/runs/101/logs?${O}`);
  if (isMissingRoute(r)) missing('GET /api/github/actions/runs/:id/logs?owner=&repo=');
  else check('actions logs: returns the mock log text',
    r.ok === true && (hasData(r, 'fake-log-line') || typeof r.downloadUrl === 'string' || typeof r.logUrl === 'string'), j(r));

  r = await call('GET', '/api/github/repos/octocat/demo/commits/abc123def4567890');
  if (isMissingRoute(r)) missing('GET /api/github/repos/:o/:r/commits/:sha');
  else check('commit detail: mock sha + message',
    r.ok === true && hasData(r, 'abc123def4567890') && hasData(r, 'v350 mock commit'), j(r));
  r = await call('GET', '/api/github/repos/octocat/demo/compare/main...feature');
  if (isMissingRoute(r)) missing('GET /api/github/repos/:o/:r/compare/:base...:head');
  else check('compare: ahead_by 2 + both mock commits',
    r.ok === true && hasData(r, 'feat one') && hasData(r, 'feat two'), j(r));
  r = await call('GET', '/api/github/repos/octocat/demo/languages');
  if (isMissingRoute(r)) missing('GET /api/github/repos/:o/:r/languages');
  else check('languages: mock data (JavaScript 12345)',
    r.ok === true && hasData(r, '12345'), j(r));
  r = await call('GET', '/api/github/repos/octocat/demo/contributors');
  if (isMissingRoute(r)) missing('GET /api/github/repos/:o/:r/contributors');
  else check('contributors: mock contributor nguyenvu133 x42',
    r.ok === true && hasData(r, 'nguyenvu133') && hasData(r, '42'), j(r));
  r = await call('GET', '/api/github/repos/octocat/demo/topics');
  if (isMissingRoute(r)) missing('GET /api/github/repos/:o/:r/topics');
  else check('topics: mock topic pixijs',
    r.ok === true && hasData(r, 'pixijs'), j(r));

  /* ---------- 8. issue / PR detail ---------- */
  console.log('\n[8] issue detail + comment / PR detail + files + reviews');
  r = await call('GET', '/api/github/repos/octocat/demo/issues/7');
  if (isMissingRoute(r)) missing('GET /api/github/repos/:o/:r/issues/:n');
  else check('issue detail: mock issue 7 + its comment (id 301)',
    r.ok === true && hasData(r, 'v350 mock issue') && hasData(r, '"id":301'), j(r));
  r = await call('POST', '/api/github/repos/octocat/demo/issues/7/comments', { body: 'v350 test comment' });
  if (isMissingRoute(r)) missing('POST /api/github/repos/:o/:r/issues/:n/comments');
  else check('issue comment post: mock returns the new comment (id 902, echoed body)',
    r.ok === true && hasData(r, '"id":902') && hasData(r, 'v350 test comment'), j(r));
  r = await call('GET', '/api/github/repos/octocat/demo/pulls/3');
  if (isMissingRoute(r)) missing('GET /api/github/repos/:o/:r/pulls/:n');
  else check('PR detail: mock PR 3',
    r.ok === true && hasData(r, 'v350 mock PR'), j(r));
  r = await call('GET', '/api/github/repos/octocat/demo/pulls/3/files');
  if (isMissingRoute(r)) missing('GET /api/github/repos/:o/:r/pulls/:n/files');
  else check('PR files: mock file src/a.js',
    r.ok === true && hasData(r, 'src/a.js'), j(r));
  r = await call('GET', '/api/github/repos/octocat/demo/pulls/3/reviews');
  if (isMissingRoute(r)) missing('GET /api/github/repos/:o/:r/pulls/:n/reviews');
  else check('PR reviews: mock APPROVED review',
    r.ok === true && hasData(r, 'APPROVED'), j(r));

  /* ---------- 9. worktrees + graph ---------- */
  console.log('\n[9] worktrees + graph (real git state)');
  // NOTE: the bridge's worktree/add runs `git worktree add -b <branch>`
  // — the branch must NOT exist yet. Do not pre-create feature-wt.
  const wtPath = path.join(tmp, 'wt-feature');
  r = await call('GET', '/api/git/worktrees');
  if (isMissingRoute(r)) missing('GET /api/git/worktrees');
  else check('worktrees: ok + lists the main worktree',
    r.ok === true && hasData(r, A), j(r));
  r = await call('POST', '/api/git/worktree/add', { path: wtPath, branch: 'feature-wt' });
  if (isMissingRoute(r)) {
    missing('POST /api/git/worktree/add', 'bridge returns 404 Unknown endpoint; branch feature-wt exists in A');
  } else {
    check('worktree add: ok + directory created with a .git pointer',
      r.ok === true && fs.existsSync(wtPath) && fs.existsSync(path.join(wtPath, '.git')), j(r));
    check('worktree add: the new worktree is on branch feature-wt',
      fs.existsSync(wtPath) && git(wtPath, 'branch', '--show-current').trim() === 'feature-wt');
    check('worktree add: branch feature-wt now exists in A',
      refExists(A, 'refs/heads/feature-wt'));
    r = await call('GET', '/api/git/worktrees');
    check('worktrees: lists the new worktree after add',
      r.ok === true && hasData(r, wtPath), j(r));
    r = await call('POST', '/api/git/worktree/remove', { path: wtPath });
    if (isMissingRoute(r)) missing('POST /api/git/worktree/remove');
    else check('worktree remove: ok + directory gone',
      r.ok === true && !fs.existsSync(wtPath), j(r));
  }
  r = await call('GET', '/api/git/graph');
  if (isMissingRoute(r)) missing('GET /api/git/graph');
  else check('graph: ok + contains a real commit subject from A',
    r.ok === true && (hasData(r, 'A edits line1') || hasData(r, 'c2 from B')), j(r));

  /* ---------- 9b. blame + file history (real git state, v3.5.0) ---------- */
  console.log('\n[9b] blame + file history (real git state)');
  r = await call('GET', '/api/git/blame?path=f.txt');
  if (isMissingRoute(r)) missing('GET /api/git/blame');
  else {
    check('blame: ok + 3 lines for f.txt',
      r.ok === true && Array.isArray(r.lines) && r.lines.length === 3, j(r));
    check('blame: line 1 is the rebased CONFLICT-A line with an author',
      Array.isArray(r.lines) && r.lines[0] && r.lines[0].line === 1 && String(r.lines[0].content || '').startsWith('CONFLICT-A') && !!r.lines[0].author, j(r));
  }
  r = await call('GET', '/api/git/file-history?path=f.txt');
  if (isMissingRoute(r)) missing('GET /api/git/file-history');
  else check('file-history: ok + lists the commits that touched f.txt',
    r.ok === true && Array.isArray(r.commits) && r.commits.length >= 3 && hasData(r, 'A edits line1'), j(r));

  cleanup(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
