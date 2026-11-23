'use strict';

/*
 * Bridge v2.1 functional test harness.
 *
 * Starts the REAL bridge (bridge/bridge-server.js) as a child process on
 * a test port, pointed at a FAKE GitHub (a local HTTP server in this
 * file — no call to api.github.com or github.com is ever made), then
 * drives the v2.1 features against REAL local git repositories:
 *
 *   - push/pull expansion: pull merge / rebase / ff-only, push upstream /
 *     --all / tags / --force-with-lease (confirm gate), one-click sync,
 *     ahead/behind, branch create/rename/delete (local + remote),
 *     merge + conflict resolve (ours/theirs) + abort, stash create/list/
 *     apply/pop/drop, commit --amend + --all, paginated log, diff
 *     summary, remotes add/remove/set-url, clone from URL
 *   - OAuth Web Flow with a real GitHub account (simulated by the fake
 *     GitHub): authorize URL shape, state validation (wrong / replayed),
 *     code exchange, token/secret never leak, 3 sign-in methods + logout
 *   - auto-sync: the bridge pulls the local repo when the auto-update
 *     tick sees a new commit on its GitHub remote (the fake GitHub URL
 *     is redirected to a local bare repo with git url.insteadOf, so no
 *     real network is involved)
 *
 * Usage:
 *   node tests/bridge-v21-test.js
 *
 * The bridge under test writes its token/config into a temp directory
 * (BRIDGE_DATA_DIR), so nothing in bridge/ is touched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_ENTRY = path.join(ROOT, 'bridge', 'bridge-server.js');
const MOCK_PORT = 17402;
const BRIDGE_PORT = 17398;
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

const GOOD_TOKEN = 'ghp_testtoken1234567890';
const TEST_CLIENT_ID = 'Iv1.testclientid123456';
const TEST_CLIENT_SECRET = 'testclientsecret1234567890abcdef';
const USER = {
  login: 'octocat',
  id: 1,
  name: 'The Octocat',
  avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
  html_url: 'https://github.com/octocat',
  type: 'User',
  public_repos: 1,
  followers: 10,
  following: 2,
  created_at: '2011-01-25T18:44:36Z',
};

let failures = 0;
let passes = 0;
function check(name, condition, detail) {
  if (condition) {
    passes += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Fake GitHub: API + OAuth (web flow + device flow)                   */
/* ------------------------------------------------------------------ */

const mockRepos = [
  {
    id: 101, name: 'alpha', full_name: 'octocat/alpha', owner: { login: 'octocat', avatar_url: USER.avatar_url },
    description: 'Alpha repo for tests', language: 'JavaScript', stargazers_count: 42, forks_count: 3,
    open_issues_count: 1, watchers_count: 42, private: false, fork: false, archived: false,
    default_branch: 'main', pushed_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z',
    created_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/octocat/alpha',
    clone_url: 'https://github.com/octocat/alpha.git', ssh_url: 'git@github.com:octocat/alpha.git',
    size: 120, license: { spdx_id: 'MIT', name: 'MIT License' }, topics: ['test', 'alpha'], visibility: 'public',
  },
];

// Mutable latest commit SHA for octocat/alpha: the auto-sync test flips it.
let alphaLatestSha = 'aaaa1111111111111111111111111111111111';
let alphaLatestMessage = 'mock commit one';
const devicePollCounts = new Map();

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}));
  res.end(body);
}

function readFormBody(req) {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (d) => { text += d.toString('utf8'); });
    req.on('end', () => resolve(new URLSearchParams(text)));
  });
}

function mockAuth(req) {
  return req.headers.authorization === `Bearer ${GOOD_TOKEN}`;
}

async function mockHandler(req, res) {
  const url = new URL(req.url, MOCK_BASE);
  const route = url.pathname;

  // --- OAuth Device Flow start (no token needed) ---
  if (route === '/login/device/code' && req.method === 'POST') {
    return sendJson(res, 200, {
      device_code: 'dev-code-1', user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-1234',
      expires_in: 900, interval: 1,
    });
  }

  // --- OAuth token exchange: device_code (Device Flow) or code (Web Flow) ---
  if (route === '/login/oauth/access_token' && req.method === 'POST') {
    const form = await readFormBody(req);
    if (form.get('device_code')) {
      const n = (devicePollCounts.get(form.get('device_code')) || 0) + 1;
      devicePollCounts.set(form.get('device_code'), n);
      if (n < 3) return sendJson(res, 200, { error: 'authorization_pending' });
      return sendJson(res, 200, { access_token: GOOD_TOKEN, token_type: 'bearer', scope: 'repo read:user' });
    }
    // Web Flow: the bridge must send the right client id + secret + code.
    if (form.get('code') === 'web-code-1' &&
        form.get('client_id') === TEST_CLIENT_ID &&
        form.get('client_secret') === TEST_CLIENT_SECRET &&
        form.get('redirect_uri') === `http://127.0.0.1:${BRIDGE_PORT}/api/github/oauth/callback`) {
      return sendJson(res, 200, { access_token: GOOD_TOKEN, token_type: 'bearer', scope: 'repo read:user' });
    }
    return sendJson(res, 400, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
  }

  // --- everything else needs the fake PAT ---
  if (!mockAuth(req)) {
    return sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
  }

  if (route === '/user' && req.method === 'GET') {
    return sendJson(res, 200, USER, { 'x-oauth-scopes': 'repo, read:user' });
  }

  if (route === '/user/repos' && req.method === 'GET') {
    return sendJson(res, 200, mockRepos);
  }

  const commitsMatch = route.match(/^\/repos\/([^/]+)\/([^/]+)\/commits$/);
  if (commitsMatch && req.method === 'GET') {
    // Deliberately NO ETag here: the auto-sync test flips the SHA and
    // the bridge must see the new value on the next tick, not a 304.
    return sendJson(res, 200, [{
      sha: alphaLatestSha,
      commit: { message: alphaLatestMessage, author: { name: 'octocat', date: new Date().toISOString() } },
      author: { login: 'octocat', avatar_url: USER.avatar_url },
      html_url: 'https://github.com/octocat/alpha/commit/' + alphaLatestSha,
    }]);
  }

  return sendJson(res, 404, { message: 'Not Found' });
}

/* ------------------------------------------------------------------ */
/* Real local git repositories (bare remote + two clones)              */
/* ------------------------------------------------------------------ */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

function gitQuiet(cwd, ...args) {
  try { return git(cwd, ...args); } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}

/* ------------------------------------------------------------------ */
/* Test runner                                                         */
/* ------------------------------------------------------------------ */

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v21-test-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Fake GitHub.
  const mock = http.createServer(mockHandler);
  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

  // Real git layout: bare remote + clone A (driven through the bridge)
  // + clone B (the "other person" pushing from elsewhere).
  const remote = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  const repoA = path.join(tmp, 'a');
  execFileSync('git', ['clone', remote, repoA], { encoding: 'utf8', env: GIT_ENV });
  git(repoA, 'checkout', '-b', 'main');
  git(repoA, 'config', 'user.name', 'Test User');
  git(repoA, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repoA, 'f.txt'), 'one\n');
  git(repoA, 'add', '.');
  git(repoA, 'commit', '-m', 'c1');
  git(repoA, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { encoding: 'utf8' });
  const repoB = path.join(tmp, 'b');
  execFileSync('git', ['clone', remote, repoB], { encoding: 'utf8', env: GIT_ENV });
  git(repoB, 'config', 'user.name', 'Test User');
  git(repoB, 'config', 'user.email', 'test@example.com');

  // The bridge under test. NO GITHUB_OAUTH_* env vars: the OAuth App
  // config must come from the dashboard-saved file, like a real user.
  const bridge = spawn(process.execPath, [BRIDGE_ENTRY], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(BRIDGE_PORT),
      BRIDGE_DATA_DIR: dataDir,
      GITHUB_API_BASE: MOCK_BASE,
      GITHUB_OAUTH_BASE: MOCK_BASE,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bridgeOut = '';
  bridge.stdout.on('data', (d) => { bridgeOut += d.toString('utf8'); });
  bridge.stderr.on('data', (d) => { bridgeOut += d.toString('utf8'); });

  const cleanup = (code) => {
    try { bridge.kill('SIGTERM'); } catch (_) {}
    try { mock.close(); } catch (_) {}
    if (failures > 0) {
      console.log('\n--- bridge log (last 40 lines) ---');
      console.log(bridgeOut.split('\n').slice(-40).join('\n'));
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nbridge-v21: ${passes} passed, ${failures} failed`);
    process.exit(code);
  };

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bridge did not start: ' + bridgeOut)), 15000);
      const iv = setInterval(() => {
        if (bridgeOut.includes('Listening:')) { clearTimeout(timer); clearInterval(iv); resolve(); }
      }, 100);
    });
  } catch (err) {
    console.log('  FAIL  bridge starts -> ' + err.message);
    cleanup(1);
    return;
  }
  check('bridge starts', true);

  const token = fs.readFileSync(path.join(dataDir, '.bridge-token'), 'utf8').trim();
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  async function call(method, p, body) {
    const res = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }
  async function callText(method, p) {
    const res = await fetch(BASE + p, { method, headers: H });
    return { status: res.status, text: await res.text() };
  }

  /* ==================== 1. LOCAL REPO: PULL / PUSH ==================== */

  console.log('\n[1] pull / push / sync / ahead-behind');
  let r = await call('POST', '/api/repo/select', { path: repoA });
  check('select repo A', r.ok === true, JSON.stringify(r).slice(0, 160));
  r = await call('GET', '/api/git/ahead-behind');
  check('ahead-behind 0/0 on clean repo', r.ahead === 0 && r.behind === 0 && r.hasUpstream === true, JSON.stringify(r));

  // B pushes c2; A pulls it with merge mode (fast-forward).
  git(repoB, 'config', 'user.name', 'Test User');
  fs.writeFileSync(path.join(repoB, 'f.txt'), 'one\ntwo\n');
  git(repoB, 'add', '.');
  git(repoB, 'commit', '-m', 'c2');
  git(repoB, 'push');
  r = await call('POST', '/api/git/pull', { mode: 'merge' });
  check('pull merge fast-forwards', r.ok === true && r.commitsPulled === 1 && r.fastForward === true, JSON.stringify(r).slice(0, 220));
  check('pull reports changed files', Array.isArray(r.changedFiles) && r.changedFiles.includes('f.txt'), JSON.stringify(r.changedFiles));
  check('pull reports ahead/behind', r.ahead === 0 && r.behind === 0, JSON.stringify(r).slice(0, 160));

  // A commits + pushes; ahead/behind follows.
  fs.writeFileSync(path.join(repoA, 'g.txt'), 'g\n');
  r = await call('POST', '/api/git/commit', { summary: 'c3', all: true });
  check('commit --all', r.ok === true, JSON.stringify(r).slice(0, 140));
  r = await call('GET', '/api/git/ahead-behind');
  check('ahead=1 before push', r.ahead === 1 && r.behind === 0, JSON.stringify(r));
  r = await call('POST', '/api/git/push', {});
  check('push current branch', r.ok === true && r.pushed === true, JSON.stringify(r).slice(0, 160));
  r = await call('GET', '/api/git/ahead-behind');
  check('ahead=0 after push', r.ahead === 0, JSON.stringify(r));

  // Push a brand-new branch with --set-upstream.
  r = await call('POST', '/api/git/branch/create', { name: 'feature-1', checkout: true });
  check('branch create + checkout', r.ok === true && r.current === 'feature-1', JSON.stringify(r).slice(0, 160));
  fs.writeFileSync(path.join(repoA, 'feat.txt'), 'feat\n');
  await call('POST', '/api/git/commit', { summary: 'feat commit', all: true });
  r = await call('POST', '/api/git/push', { setUpstream: true });
  check('push --set-upstream new branch', r.ok === true, JSON.stringify(r).slice(0, 160));
  const lsRemote1 = git(repoA, 'ls-remote', '--heads', 'origin');
  check('new branch exists on remote', /feature-1/.test(lsRemote1), lsRemote1.slice(0, 120));
  r = await call('POST', '/api/git/checkout', { branch: 'main' });
  check('checkout main', r.ok === true, JSON.stringify(r).slice(0, 120));

  // Push --all: create a second branch locally and push everything.
  await call('POST', '/api/git/branch/create', { name: 'feature-2' });
  r = await call('POST', '/api/git/push', { pushAll: true });
  check('push --all branches', r.ok === true, JSON.stringify(r).slice(0, 160));
  const lsRemote2 = git(repoA, 'ls-remote', '--heads', 'origin');
  check('feature-2 exists on remote after --all', /feature-2/.test(lsRemote2), lsRemote2.slice(0, 120));

  // Push tags.
  git(repoA, 'tag', 'v0.1-test');
  r = await call('POST', '/api/git/push', { tags: true });
  check('push tags', r.ok === true, JSON.stringify(r).slice(0, 160));
  const lsTags = git(repoA, 'ls-remote', '--tags', 'origin');
  check('tag exists on remote', /v0\.1-test/.test(lsTags), lsTags.slice(0, 120));

  // Force push: A resets back and rewrites history; plain push must fail,
  // force without confirm must fail, force WITH confirm must succeed.
  git(repoA, 'reset', '--hard', 'HEAD~1'); // drop the c3 commit locally
  fs.writeFileSync(path.join(repoA, 'g.txt'), 'g-rewritten\n');
  await call('POST', '/api/git/commit', { summary: 'c3-rewritten', all: true });
  r = await call('POST', '/api/git/push', {});
  check('non-fast-forward push rejected', r.status === 400, JSON.stringify(r).slice(0, 160));
  r = await call('POST', '/api/git/push', { force: true });
  check('force push WITHOUT confirm rejected', r.status === 400 && /confirmation/i.test(r.error || ''), JSON.stringify(r).slice(0, 160));
  r = await call('POST', '/api/git/push', { force: true, confirm: true });
  check('force-with-lease WITH confirm succeeds', r.ok === true, JSON.stringify(r).slice(0, 160));
  // Restore c3 state for the rest of the suite: B pulls the rewritten history.
  git(repoB, 'fetch', 'origin');
  git(repoB, 'reset', '--hard', 'origin/main');

  // Pull --ff-only fails on divergent branches; --rebase succeeds.
  git(repoB, 'pull');
  fs.writeFileSync(path.join(repoB, 'f.txt'), 'one\ntwo\nB-ff\n');
  git(repoB, 'add', '.');
  git(repoB, 'commit', '-m', 'c4-b');
  git(repoB, 'push');
  fs.writeFileSync(path.join(repoA, 'h.txt'), 'h\n');
  await call('POST', '/api/git/commit', { summary: 'c4-a', all: true });
  r = await call('POST', '/api/git/pull', { mode: 'ff-only' });
  check('pull --ff-only fails on divergent branches', r.status === 400 && /fast-forward/i.test(r.error || ''), JSON.stringify(r).slice(0, 200));
  r = await call('POST', '/api/git/pull', { mode: 'rebase' });
  check('pull --rebase succeeds on divergent branches', r.ok === true && r.commitsPulled === 1 && r.fastForward === true, JSON.stringify(r).slice(0, 220));
  r = await call('GET', '/api/git/ahead-behind');
  check('ahead=1 behind=0 after rebase (local commit on top)', r.ahead === 1 && r.behind === 0, JSON.stringify(r));

  // One-click sync: fetch + pull (up to date) + push.
  r = await call('POST', '/api/git/sync', { mode: 'merge' });
  check('sync succeeds', r.ok === true && Array.isArray(r.steps) && r.steps.length === 3 && r.steps.every((s) => s.ok), JSON.stringify(r).slice(0, 260));
  check('sync reports step names', r.steps.map((s) => s.step).join(',') === 'fetch,pull,push', JSON.stringify(r.steps));
  r = await call('GET', '/api/git/ahead-behind');
  check('ahead=0 behind=0 after sync', r.ahead === 0 && r.behind === 0, JSON.stringify(r));

  /* ==================== 2. BRANCHES / MERGE / STASH / COMMIT ========= */

  console.log('\n[2] branches / merge / conflicts / stash / commit / log / remotes / clone');

  // Branch rename + remote delete.
  r = await call('POST', '/api/git/branch/rename', { old: 'feature-2', new: 'feature-2-renamed' });
  check('branch rename', r.ok === true && r.new === 'feature-2-renamed', JSON.stringify(r).slice(0, 140));
  r = await call('POST', '/api/git/branch/delete', { name: 'feature-1', deleteRemote: true });
  check('branch delete local + remote', r.ok === true && r.localDeleted === true && r.remoteDeleted === true, JSON.stringify(r).slice(0, 160));
  const lsRemote3 = git(repoA, 'ls-remote', '--heads', 'origin');
  check('feature-1 gone from remote', !/feature-1/.test(lsRemote3), lsRemote3.slice(0, 120));
  r = await call('POST', '/api/git/branch/delete', { name: 'main' });
  check('deleting current branch refused', r.status === 400 && /current branch/i.test(r.error || ''), JSON.stringify(r).slice(0, 160));
  r = await call('POST', '/api/git/branch/create', { name: 'bad name!' });
  check('invalid branch name refused', r.status === 400, JSON.stringify(r).slice(0, 140));
  r = await call('GET', '/api/git/branches');
  check('branches list has local + remote', Array.isArray(r.branches) && Array.isArray(r.remoteBranches) && r.remoteBranches.some((b) => b === 'origin/main'), JSON.stringify(r).slice(0, 200));

  // Merge route (clean merge, no conflict).
  await call('POST', '/api/git/branch/create', { name: 'merge-me', checkout: true });
  fs.writeFileSync(path.join(repoA, 'm.txt'), 'merge me\n');
  await call('POST', '/api/git/commit', { summary: 'merge-me commit', all: true });
  await call('POST', '/api/git/checkout', { branch: 'main' });
  r = await call('POST', '/api/git/merge', { branch: 'merge-me' });
  check('merge clean branch', r.ok === true && r.conflict === false, JSON.stringify(r).slice(0, 200));
  check('merged file present', fs.existsSync(path.join(repoA, 'm.txt')), '');

  // Merge conflict via the merge route, then abort.
  await call('POST', '/api/git/branch/create', { name: 'conflict-branch', checkout: true });
  fs.writeFileSync(path.join(repoA, 'f.txt'), 'one\ntwo\nBRANCH-SIDE\n');
  await call('POST', '/api/git/commit', { summary: 'branch side', all: true });
  await call('POST', '/api/git/checkout', { branch: 'main' });
  fs.writeFileSync(path.join(repoA, 'f.txt'), 'one\ntwo\nMAIN-SIDE\n');
  await call('POST', '/api/git/commit', { summary: 'main side', all: true });
  r = await call('POST', '/api/git/merge', { branch: 'conflict-branch' });
  check('merge reports conflict (HTTP 200, ok:false)', r.status === 200 && r.ok === false && r.conflict === true && (r.conflicts || []).includes('f.txt'), JSON.stringify(r).slice(0, 220));
  r = await call('GET', '/api/git/conflicts');
  check('conflicts list while merging', r.merging === true && (r.conflicts || []).includes('f.txt'), JSON.stringify(r));
  r = await call('POST', '/api/git/merge/abort', {});
  check('merge abort', r.ok === true, JSON.stringify(r).slice(0, 120));
  r = await call('GET', '/api/git/conflicts');
  check('no conflicts after abort', r.merging === false && r.conflicts.length === 0, JSON.stringify(r));
  check('working tree clean after abort', git(repoA, 'status', '--porcelain').trim() === '', git(repoA, 'status', '--porcelain'));

  // Merge conflict via PULL, resolve with theirs, commit the merge.
  await call('POST', '/api/git/checkout', { branch: 'main' });
  git(repoB, 'pull');
  fs.writeFileSync(path.join(repoB, 'f.txt'), 'one\ntwo\nB-SIDE\n');
  git(repoB, 'add', '.');
  git(repoB, 'commit', '-m', 'c5-b');
  git(repoB, 'push');
  fs.writeFileSync(path.join(repoA, 'f.txt'), 'one\ntwo\nA-SIDE\n');
  await call('POST', '/api/git/commit', { summary: 'c6-a', all: true });
  r = await call('POST', '/api/git/pull', { mode: 'merge' });
  check('pull reports real merge conflict', r.ok === false && r.conflict === true && (r.conflicts || []).includes('f.txt'), JSON.stringify(r).slice(0, 220));
  r = await call('POST', '/api/git/conflict/resolve', { path: 'f.txt', side: 'theirs' });
  check('resolve conflict with theirs', r.ok === true && r.allResolved === true && r.side === 'theirs', JSON.stringify(r).slice(0, 160));
  check('file now has theirs content', fs.readFileSync(path.join(repoA, 'f.txt'), 'utf8').includes('B-SIDE'), '');
  r = await call('POST', '/api/git/commit', { summary: 'merge resolved theirs' });
  check('commit merge resolution', r.ok === true, JSON.stringify(r).slice(0, 140));
  r = await call('POST', '/api/git/push', {});
  check('push after merge resolution', r.ok === true, JSON.stringify(r).slice(0, 140));

  // Stash: create / list / apply (keeps) / drop.
  fs.writeFileSync(path.join(repoA, 'f.txt'), 'one\ntwo\nB-SIDE\nstash-me\n');
  r = await call('POST', '/api/git/stash/create', { message: 'wip-1' });
  check('stash create', r.ok === true && r.stashes.length === 1, JSON.stringify(r).slice(0, 160));
  r = await call('GET', '/api/git/stash/list');
  check('stash list', r.stashes && r.stashes.length === 1 && r.stashes[0].message.includes('wip-1'), JSON.stringify(r.stashes));
  r = await call('POST', '/api/git/stash/apply', { index: 0, pop: false });
  check('stash apply (keeps stash)', r.ok === true && r.stashes.length === 1, JSON.stringify(r).slice(0, 160));
  check('stashed change back in tree', fs.readFileSync(path.join(repoA, 'f.txt'), 'utf8').includes('stash-me'), '');
  git(repoA, 'checkout', '--', 'f.txt'); // drop the re-applied change
  r = await call('POST', '/api/git/stash/drop', { index: 0 });
  check('stash drop', r.ok === true && r.stashes.length === 0, JSON.stringify(r).slice(0, 140));
  r = await call('POST', '/api/git/stash/create', {});
  check('stash with clean tree refused', r.status === 400 && /nothing to stash/i.test(r.error || ''), JSON.stringify(r).slice(0, 160));

  // Commit --amend rewrites the last message without a new commit.
  const countBefore = git(repoA, 'rev-list', '--count', 'HEAD').trim();
  fs.writeFileSync(path.join(repoA, 'amend.txt'), 'amend\n');
  await call('POST', '/api/git/commit', { summary: 'to amend', all: true });
  const countAfterCommit = git(repoA, 'rev-list', '--count', 'HEAD').trim();
  check('commit before amend adds one', countAfterCommit === String(Number(countBefore) + 1), `${countBefore} -> ${countAfterCommit}`);
  r = await call('POST', '/api/git/commit', { summary: 'amended message', amend: true });
  check('commit --amend', r.ok === true && r.amended === true, JSON.stringify(r).slice(0, 160));
  const logAfter = await call('GET', '/api/git/log?per_page=1');
  check('amend changed message, not count', logAfter.commits[0].subject === 'amended message' && git(repoA, 'rev-list', '--count', 'HEAD').trim() === countAfterCommit, JSON.stringify(logAfter.commits[0]));

  // Paginated log + diff summary.
  r = await call('GET', '/api/git/log?page=1&per_page=2');
  check('log paginated page 1', r.commits.length === 2 && r.has_next === true && r.page === 1, JSON.stringify(r).slice(0, 160));
  r = await call('GET', '/api/git/log?page=2&per_page=2');
  check('log paginated page 2 differs', r.commits.length > 0 && r.page === 2, JSON.stringify(r).slice(0, 160));
  fs.writeFileSync(path.join(repoA, 'f.txt'), 'one\ntwo\nB-SIDE\nmore\nlines\n');
  r = await call('GET', '/api/git/diff/summary');
  check('diff summary lists worktree change', r.ok === true && r.worktree.some((f) => f.path === 'f.txt' && f.insertions === 2), JSON.stringify(r.worktree));
  git(repoA, 'checkout', '--', 'f.txt');

  // Remotes: add / set-url / remove, invalid URL refused.
  r = await call('POST', '/api/git/remote/add', { name: 'upstream', url: remote });
  check('remote add', r.ok === true, JSON.stringify(r).slice(0, 120));
  r = await call('GET', '/api/git/remotes');
  check('remotes list includes upstream', r.remotes.some((x) => x.name === 'upstream'), JSON.stringify(r.remotes));
  r = await call('POST', '/api/git/remote/set-url', { name: 'upstream', url: 'https://example.com/x/y.git' });
  check('remote set-url', r.ok === true, JSON.stringify(r).slice(0, 120));
  r = await call('GET', '/api/git/remotes');
  check('remote URL updated', r.remotes.find((x) => x.name === 'upstream').fetchUrl === 'https://example.com/x/y.git', JSON.stringify(r.remotes));
  r = await call('POST', '/api/git/remote/remove', { name: 'upstream' });
  check('remote remove', r.ok === true, JSON.stringify(r).slice(0, 120));
  r = await call('POST', '/api/git/remote/add', { name: 'bad', url: 'not a url; rm -rf' });
  check('invalid remote URL refused', r.status === 400, JSON.stringify(r).slice(0, 140));

  // Clone from URL (local path) + auto-select.
  const cloneTarget = path.join(tmp, 'cloned');
  r = await call('POST', '/api/git/clone', { url: remote, path: cloneTarget });
  check('clone from URL', r.ok === true && r.repository && r.repository.path === cloneTarget, JSON.stringify(r).slice(0, 180));
  r = await call('POST', '/api/git/clone', { url: remote, path: cloneTarget });
  check('clone into non-empty dir refused', r.status === 400 && /not empty/i.test(r.error || ''), JSON.stringify(r).slice(0, 160));
  // Switch back to repo A for the OAuth + auto-sync sections.
  r = await call('POST', '/api/repo/select', { path: repoA });
  check('re-select repo A', r.ok === true, JSON.stringify(r).slice(0, 120));

  /* ==================== 3. OAUTH WEB FLOW (real account) ============= */

  console.log('\n[3] OAuth Web Flow + 3 sign-in methods + logout');

  r = await call('GET', '/api/github/oauth/status');
  check('oauth status: not configured at first', r.configured === false && r.clientIdConfigured === false && r.clientSecretConfigured === false, JSON.stringify(r));
  check('oauth status leaks no secret', !JSON.stringify(r).includes(TEST_CLIENT_SECRET), JSON.stringify(r));
  r = await call('GET', '/api/github/oauth/start');
  check('oauth start refused when unconfigured', r.status === 400 && r.code === 'OAUTH_APP_NOT_CONFIGURED', JSON.stringify(r).slice(0, 180));

  r = await call('POST', '/api/github/oauth/config', { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET });
  check('oauth app config saved', r.ok === true && r.configured === true, JSON.stringify(r));
  check('oauth config response leaks no secret', !JSON.stringify(r).includes(TEST_CLIENT_SECRET), JSON.stringify(r));
  check('oauth config file is mode 0600', (fs.statSync(path.join(dataDir, '.github-oauth.json')).mode & 0o777) === 0o600, '');
  check('oauth config file holds the secret on disk only', fs.readFileSync(path.join(dataDir, '.github-oauth.json'), 'utf8').includes(TEST_CLIENT_SECRET), '');
  r = await call('GET', '/api/github/oauth/status');
  check('oauth status: configured after save', r.configured === true && r.clientIdConfigured === true && r.clientSecretConfigured === true, JSON.stringify(r));
  check('oauth status still leaks no secret', !JSON.stringify(r).includes(TEST_CLIENT_SECRET), JSON.stringify(r));

  // Start the flow: the authorize URL must be exactly the GitHub shape.
  r = await call('GET', '/api/github/oauth/start');
  const startUrl = r.authorizeUrl || '';
  const startParsed = new URL(startUrl);
  check('oauth start returns authorize URL', r.ok === true && startParsed.origin === MOCK_BASE && startParsed.pathname === '/login/oauth/authorize', startUrl.slice(0, 180));
  check('authorize URL has client_id', startParsed.searchParams.get('client_id') === TEST_CLIENT_ID, startUrl.slice(0, 180));
  check('authorize URL has localhost callback', startParsed.searchParams.get('redirect_uri') === `http://127.0.0.1:${BRIDGE_PORT}/api/github/oauth/callback`, startParsed.searchParams.get('redirect_uri'));
  check('authorize URL has repo scope', (startParsed.searchParams.get('scope') || '').split(' ').includes('repo'), startParsed.searchParams.get('scope'));
  const goodState = startParsed.searchParams.get('state');
  check('authorize URL has random state', typeof goodState === 'string' && /^[a-f0-9]{48}$/.test(goodState), goodState);

  // Callback with a wrong state is refused (CSRF protection).
  let cb = await callText('GET', '/api/github/oauth/callback?code=web-code-1&state=deadbeef');
  check('callback with wrong state rejected', cb.status === 400 && /state/i.test(cb.text), 'status ' + cb.status);
  check('callback error page leaks no token', !cb.text.includes(GOOD_TOKEN) && !cb.text.includes(TEST_CLIENT_SECRET), cb.text.slice(0, 120));

  // Callback with the right state but a wrong code is refused by GitHub.
  cb = await callText('GET', `/api/github/oauth/callback?code=wrong-code&state=${goodState}`);
  check('callback with wrong code rejected', cb.status === 400, 'status ' + cb.status + ' ' + cb.text.slice(0, 120));
  // Note: that consumed the state, so mint a fresh one for the success path.
  r = await call('GET', '/api/github/oauth/start');
  const freshState = new URL(r.authorizeUrl).searchParams.get('state');
  cb = await callText('GET', `/api/github/oauth/callback?code=web-code-1&state=${freshState}`);
  check('callback with good code+state succeeds', cb.status === 200 && /octocat/.test(cb.text), 'status ' + cb.status + ' ' + cb.text.slice(0, 140));
  check('callback success page leaks no token/secret', !cb.text.includes(GOOD_TOKEN) && !cb.text.includes(TEST_CLIENT_SECRET), cb.text.slice(0, 120));
  r = await call('GET', '/api/github/user');
  check('signed in via oauth-web', r.authed === true && r.user && r.user.login === 'octocat' && r.authMethod === 'oauth-web', JSON.stringify(r).slice(0, 220));
  check('user profile carries scopes', r.scopes === 'repo, read:user', JSON.stringify(r.scopes));
  check('user endpoint leaks no token', !JSON.stringify(r).includes(GOOD_TOKEN), JSON.stringify(r).slice(0, 120));

  // A state is one-time: replaying it is refused.
  cb = await callText('GET', `/api/github/oauth/callback?code=web-code-1&state=${freshState}`);
  check('replayed state rejected', cb.status === 400, 'status ' + cb.status);

  // Logout, then PAT, then Device Flow — all three methods, same profile.
  r = await call('POST', '/api/github/logout', {});
  check('logout', r.ok === true && r.authed === false, JSON.stringify(r));
  r = await call('GET', '/api/github/user');
  check('logged out state', r.authed === false && r.user === null, JSON.stringify(r));
  r = await call('POST', '/api/github/auth', { token: GOOD_TOKEN });
  check('PAT sign-in', r.ok === true && r.user.login === 'octocat', JSON.stringify(r).slice(0, 140));
  r = await call('GET', '/api/github/user');
  check('PAT authMethod recorded', r.authMethod === 'pat', JSON.stringify(r.authMethod));
  await call('POST', '/api/github/logout', {});
  r = await call('POST', '/api/github/auth/device/start', {});
  check('device flow start', r.ok === true && r.user_code === 'ABCD-1234', JSON.stringify(r).slice(0, 160));
  r = await call('POST', '/api/github/auth/device/poll', { device_code: 'dev-code-1' });
  check('device poll pending', r.status === 'pending', JSON.stringify(r));
  await call('POST', '/api/github/auth/device/poll', { device_code: 'dev-code-1' });
  r = await call('POST', '/api/github/auth/device/poll', { device_code: 'dev-code-1' });
  check('device poll authorized', r.status === 'authorized' && r.user.login === 'octocat', JSON.stringify(r).slice(0, 160));
  r = await call('GET', '/api/github/user');
  check('device authMethod recorded', r.authMethod === 'device', JSON.stringify(r.authMethod));

  /* ==================== 4. AUTO-SYNC ================================ */

  console.log('\n[4] auto-update + auto-sync');
  // Point repo A's origin at the FAKE GitHub repo URL, but redirect the
  // actual git traffic to the local bare repo with url.insteadOf, so
  // the pull never touches the real network.
  git(repoA, 'remote', 'set-url', 'origin', 'https://github.com/octocat/alpha.git');
  git(repoA, 'config', `url.${remote}.insteadOf`, 'https://github.com/octocat/alpha.git');
  r = await call('GET', '/api/git/remotes');
  check('origin now points at fake GitHub URL', r.remotes.find((x) => x.name === 'origin').fetchUrl === 'https://github.com/octocat/alpha.git', JSON.stringify(r.remotes));

  // Enable auto-update WITH auto-sync; wait for the first (baseline) tick.
  r = await call('POST', '/api/github/auto-update', { enabled: true, intervalSeconds: 15, autoSync: true });
  check('auto-update enabled with autoSync', r.ok === true && r.enabled === true && r.autoSync === true, JSON.stringify(r).slice(0, 200));
  let auStatus = null;
  for (let i = 0; i < 25; i += 1) {
    await sleep(200);
    auStatus = await call('GET', '/api/github/auto-update');
    if (auStatus.lastRunAt) break;
  }
  check('baseline auto-update tick ran', !!auStatus.lastRunAt, JSON.stringify(auStatus).slice(0, 160));
  // The tick sets lastRunAt at start; give it a beat to finish recording
  // the baseline SHA before we flip the mock to a new commit.
  await sleep(800);

  // B pushes a new commit to the remote; the fake GitHub "sees" a new SHA.
  git(repoB, 'pull');
  fs.writeFileSync(path.join(repoB, 'sync.txt'), 'synced\n');
  git(repoB, 'add', '.');
  git(repoB, 'commit', '-m', 'c7-sync');
  git(repoB, 'push');
  const newHeadSha = git(repoB, 'rev-parse', 'HEAD').trim();
  alphaLatestSha = 'dddd4444444444444444444444444444444444';
  alphaLatestMessage = 'c7-sync (remote)';
  r = await call('POST', '/api/github/refresh', {});
  check('manual refresh detects the new commit', r.ok === true && Array.isArray(r.updated) && r.updated.some((u) => u.repo === 'octocat/alpha'), JSON.stringify(r).slice(0, 260));
  auStatus = await call('GET', '/api/github/auto-update');
  check('auto-sync pulled the commit', auStatus.lastAutoSync && auStatus.lastAutoSync.commitsPulled >= 1 && auStatus.lastAutoSync.skipped !== true, JSON.stringify(auStatus.lastAutoSync));
  check('local repo has the synced file', fs.existsSync(path.join(repoA, 'sync.txt')), '');
  // The local HEAD is a MERGE commit (the amended local commit diverged
  // from the remote), so it cannot equal B's HEAD — but B's commit must
  // be an ancestor of it.
  let isAncestor = false;
  try { git(repoA, 'merge-base', '--is-ancestor', newHeadSha, 'HEAD'); isAncestor = true; } catch (_) { isAncestor = false; }
  check('local HEAD contains the pushed commit', isAncestor, git(repoA, 'rev-parse', 'HEAD').trim() + ' vs ' + newHeadSha);

  // Auto-sync must SKIP (not crash, not merge) when the tree is dirty.
  fs.writeFileSync(path.join(repoA, 'dirty.txt'), 'dirty\n');
  alphaLatestSha = 'eeee5555555555555555555555555555555555';
  alphaLatestMessage = 'c8-remote';
  r = await call('POST', '/api/github/refresh', {});
  auStatus = await call('GET', '/api/github/auto-update');
  check('auto-sync skips dirty tree', auStatus.lastAutoSync && auStatus.lastAutoSync.skipped === true && /dirty|uncommitted/i.test(auStatus.lastAutoSync.reason || ''), JSON.stringify(auStatus.lastAutoSync));
  check('dirty file untouched by auto-sync', fs.existsSync(path.join(repoA, 'dirty.txt')), '');
  fs.unlinkSync(path.join(repoA, 'dirty.txt'));

  // Turn auto-update off again so no background tick fires after the test.
  r = await call('POST', '/api/github/auto-update', { enabled: false });
  check('auto-update disabled', r.ok === true && r.enabled === false, JSON.stringify(r).slice(0, 120));

  cleanup(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('bridge-v21 test crashed:', err);
  process.exit(1);
});
