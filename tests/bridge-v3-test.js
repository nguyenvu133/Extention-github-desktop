'use strict';
require('./_node16-fetch'); // v3.1.0: Node 16.13 has no global fetch

/*
 * Bridge v3.0 functional test harness.
 *
 * Starts the REAL bridge (bridge/bridge-server.js) as a child process on
 * a test port, pointed at a FAKE GitHub (a local HTTP server in this
 * file — no call to api.github.com, github.com or codeload.github.com
 * is ever made), then drives the v3.0 features against REAL local git
 * repositories:
 *
 *   - login: diagnostics (all 6 checks, incl. bad token 401, no token,
 *     unreachable github.com via a second bridge on a dead port),
 *     OAuth start when the OAuth App is not configured
 *     (OAUTH_APP_NOT_CONFIGURED), PAT format guard (email / password /
 *     random string rejected with INVALID_TOKEN_FORMAT), Device Flow
 *     full cycle, publicUser now carries email
 *   - .zip download (mock codeload stream, Content-Disposition, 404)
 *     + local `git archive` zip (real 'PK' bytes, committed file inside)
 *   - GitHub API v3: repo create / edit / delete (confirm gate) /
 *     fork / star / unstar, issues create / read + comments / close,
 *     PRs create / merge / close, releases list / create / asset
 *     download, file upload via contentBase64 + file delete, code
 *     search, notifications list + mark read, full profile
 *   - local git: cherry-pick (success + conflict), revert (success +
 *     conflict), reset soft / mixed / hard (+ hard confirm gate,
 *     invalid mode/ref), tags create / list / delete / push
 *
 * Usage:
 *   node tests/bridge-v3-test.js
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
const MOCK_PORT = 17403;
const BRIDGE_PORT = 17397;
const BRIDGE2_PORT = 17396;
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
const BASE2 = `http://127.0.0.1:${BRIDGE2_PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

const GOOD_TOKEN = 'ghp_testtoken1234567890';
const BAD_TOKEN = 'ghp_badtoken1234567890';
const TEST_CLIENT_ID = 'Iv1.testclientid123456';
const TEST_CLIENT_SECRET = 'testclientsecret1234567890abcdef';
const USER = {
  login: 'octocat',
  id: 1,
  name: 'The Octocat',
  email: 'octocat@github.com',
  bio: 'Test octocat',
  company: 'GitHub',
  blog: 'https://github.blog',
  location: 'San Francisco',
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
/* Fake GitHub: API + OAuth (device flow) + codeload (.zip)            */
/* ------------------------------------------------------------------ */

const ZIP_BYTES = Buffer.from('PK\x03\x04FAKEZIPDATA-octocat-alpha-main', 'utf8');
const ASSET_BYTES = Buffer.from('PK\x03\x04FAKE-ASSET-app.zip', 'utf8');

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
const createdRepos = new Map(); // name -> repo object
const issuesStore = new Map(); // number -> issue object
const commentsStore = new Map(); // number -> [comment]
const pullsStore = new Map(); // number -> pull object
const releasesStore = [
  {
    id: 11, tag_name: 'v1.0.0', name: 'Release 1', body: 'First release notes',
    draft: false, prerelease: false, html_url: 'https://github.com/octocat/alpha/releases/v1.0.0',
    created_at: '2026-11-01T00:00:00Z',
    assets: [{ id: 21, name: 'app.zip', size: 123, download_count: 2, browser_download_url: 'https://github.com/octocat/alpha/releases/download/v1.0.0/app.zip' }],
  },
];
let issueSeq = 6;
let releaseSeq = 11;
const devicePollCounts = new Map();
let lastContentsPut = null;
let lastContentsDelete = null;

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}));
  res.end(body);
}

function sendBuffer(res, status, buf, contentType) {
  res.writeHead(status, { 'Content-Type': contentType || 'application/octet-stream' });
  res.end(buf);
}

function readBodyText(req) {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (d) => { text += d.toString('utf8'); });
    req.on('end', () => resolve(text));
  });
}

function mockAuth(req) {
  return req.headers.authorization === `Bearer ${GOOD_TOKEN}`;
}

function findRepo(owner, repo) {
  if (owner !== 'octocat') return null;
  if (repo === 'alpha') return mockRepos[0];
  return createdRepos.get(repo) || null;
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
    const form = new URLSearchParams(await readBodyText(req));
    if (form.get('device_code')) {
      const n = (devicePollCounts.get(form.get('device_code')) || 0) + 1;
      devicePollCounts.set(form.get('device_code'), n);
      if (n < 3) return sendJson(res, 200, { error: 'authorization_pending' });
      return sendJson(res, 200, { access_token: GOOD_TOKEN, token_type: 'bearer', scope: 'repo read:user' });
    }
    if (form.get('code') === 'web-code-1' &&
        form.get('client_id') === TEST_CLIENT_ID &&
        form.get('client_secret') === TEST_CLIENT_SECRET &&
        form.get('redirect_uri') === `http://127.0.0.1:${BRIDGE_PORT}/api/github/oauth/callback`) {
      return sendJson(res, 200, { access_token: GOOD_TOKEN, token_type: 'bearer', scope: 'repo read:user' });
    }
    return sendJson(res, 400, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
  }

  // --- Codeload .zip download (needs the fake PAT, like the real thing) ---
  const zipMatch = route.match(/^\/([^/]+)\/([^/]+)\/zip\/(.+)$/);
  if (zipMatch && req.method === 'GET') {
    if (!mockAuth(req)) return sendJson(res, 401, { message: 'Bad credentials' });
    const [, owner, repo, refPart] = zipMatch;
    if (owner !== 'octocat' || repo !== 'alpha') return sendJson(res, 404, { message: 'Not Found' });
    if (refPart === 'refs/heads/main' || /^[0-9a-f]{40}$/i.test(refPart)) return sendBuffer(res, 200, ZIP_BYTES, 'application/zip');
    return sendJson(res, 404, { message: 'Not Found' });
  }

  // --- everything else needs the fake PAT ---
  if (!mockAuth(req)) {
    return sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
  }

  if (route === '/user' && req.method === 'GET') {
    return sendJson(res, 200, USER, { 'x-oauth-scopes': 'repo, read:user' });
  }

  if (route === '/user/repos' && req.method === 'GET') {
    return sendJson(res, 200, [...mockRepos, ...createdRepos.values()]);
  }

  if (route === '/user/repos' && req.method === 'POST') {
    const body = JSON.parse(await readBodyText(req) || '{}');
    const repo = {
      id: 201 + createdRepos.size, name: body.name, full_name: `octocat/${body.name}`,
      owner: { login: 'octocat', avatar_url: USER.avatar_url },
      description: body.description || '', language: null, stargazers_count: 0, forks_count: 0,
      open_issues_count: 0, watchers_count: 0, private: !!body.private, fork: false, archived: false,
      default_branch: 'main', pushed_at: null, updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(), html_url: `https://github.com/octocat/${body.name}`,
      clone_url: `https://github.com/octocat/${body.name}.git`, ssh_url: `git@github.com:octocat/${body.name}.git`,
      size: 0, license: null, topics: [], visibility: body.private ? 'private' : 'public',
    };
    createdRepos.set(body.name, repo);
    return sendJson(res, 201, repo);
  }

  const starredMatch = route.match(/^\/user\/starred\/([^/]+)\/([^/]+)$/);
  if (starredMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    res.writeHead(204);
    return res.end();
  }

  if (route === '/search/code' && req.method === 'GET') {
    return sendJson(res, 200, {
      total_count: 1, incomplete_results: false,
      items: [{ name: 'f.txt', path: 'src/f.txt', repository: { full_name: 'octocat/alpha' }, html_url: 'https://github.com/octocat/alpha/blob/main/src/f.txt', sha: 'aaa1111111111111111111111111111111111' }],
    });
  }

  if (route === '/notifications' && req.method === 'GET') {
    return sendJson(res, 200, [{
      id: '1001',
      subject: { title: 'Issue #7 needs review', type: 'Issue', url: 'https://api.github.com/repos/octocat/alpha/issues/7' },
      repository: { full_name: 'octocat/alpha' },
      reason: 'mention', unread: true, updated_at: '2026-11-23T10:00:00Z',
    }]);
  }

  if (route === '/notifications' && req.method === 'PUT') {
    return sendJson(res, 202, {});
  }

  // --- repo-scoped routes ---
  const repoMatch = route.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (repoMatch) {
    const owner = repoMatch[1];
    const repo = repoMatch[2];
    const rest = repoMatch[3] || '';
    const stored = findRepo(owner, repo);
    if (!stored && !(rest === 'forks')) return sendJson(res, 404, { message: 'Not Found' });

    if (rest === '' && req.method === 'GET') return sendJson(res, 200, stored);
    if (rest === '' && req.method === 'PATCH') {
      const body = JSON.parse(await readBodyText(req) || '{}');
      if (body.description !== undefined) stored.description = body.description;
      if (body.private !== undefined) stored.private = !!body.private;
      if (body.name !== undefined) { stored.name = body.name; stored.full_name = `${owner}/${body.name}`; }
      return sendJson(res, 200, stored);
    }
    if (rest === '' && req.method === 'DELETE') {
      createdRepos.delete(repo);
      res.writeHead(204);
      return res.end();
    }
    if (rest === 'forks' && req.method === 'POST') {
      return sendJson(res, 202, { ...stored, fork: true, full_name: stored.full_name });
    }
    if (rest === 'issues' && req.method === 'POST') {
      const body = JSON.parse(await readBodyText(req) || '{}');
      issueSeq += 1;
      const issue = {
        number: issueSeq, title: body.title, body: body.body || '', state: 'open',
        html_url: `https://github.com/${owner}/${repo}/issues/${issueSeq}`,
        user: { login: 'octocat' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        comments: 0, labels: (body.labels || []).map((l) => ({ name: l })),
      };
      issuesStore.set(issueSeq, issue);
      commentsStore.set(issueSeq, []);
      return sendJson(res, 201, issue);
    }
    const issueMatch = rest.match(/^issues\/(\d+)$/);
    if (issueMatch && req.method === 'GET') {
      const issue = issuesStore.get(Number(issueMatch[1]));
      if (!issue) return sendJson(res, 404, { message: 'Not Found' });
      return sendJson(res, 200, issue);
    }
    if (issueMatch && req.method === 'PATCH') {
      const issue = issuesStore.get(Number(issueMatch[1]));
      if (!issue) return sendJson(res, 404, { message: 'Not Found' });
      const body = JSON.parse(await readBodyText(req) || '{}');
      if (body.state) issue.state = body.state;
      return sendJson(res, 200, issue);
    }
    const issueCommentsMatch = rest.match(/^issues\/(\d+)\/comments$/);
    if (issueCommentsMatch && req.method === 'GET') {
      return sendJson(res, 200, commentsStore.get(Number(issueCommentsMatch[1])) || []);
    }
    if (issueCommentsMatch && req.method === 'POST') {
      const body = JSON.parse(await readBodyText(req) || '{}');
      const comment = { id: 501, user: { login: 'octocat' }, body: body.body, created_at: new Date().toISOString(), html_url: `https://github.com/${owner}/${repo}/issues/${issueCommentsMatch[1]}#issuecomment-501` };
      const list = commentsStore.get(Number(issueCommentsMatch[1])) || [];
      list.push(comment);
      commentsStore.set(Number(issueCommentsMatch[1]), list);
      return sendJson(res, 201, comment);
    }
    if (rest === 'pulls' && req.method === 'POST') {
      const body = JSON.parse(await readBodyText(req) || '{}');
      const pull = {
        number: 3, title: body.title, body: body.body || '', state: 'open',
        html_url: `https://github.com/${owner}/${repo}/pull/3`,
        user: { login: 'octocat' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        head: { ref: body.head }, base: { ref: body.base }, draft: false, merged: false, merged_at: null,
      };
      pullsStore.set(3, pull);
      return sendJson(res, 201, pull);
    }
    const pullMergeMatch = rest.match(/^pulls\/(\d+)\/merge$/);
    if (pullMergeMatch && req.method === 'PUT') {
      const pull = pullsStore.get(Number(pullMergeMatch[1]));
      if (!pull) return sendJson(res, 404, { message: 'Not Found' });
      pull.merged = true;
      pull.merged_at = new Date().toISOString();
      pull.state = 'closed';
      return sendJson(res, 200, { merged: true, message: 'Pull request successfully merged', sha: 'bbbb2222222222222222222222222222222222' });
    }
    const pullMatch = rest.match(/^pulls\/(\d+)$/);
    if (pullMatch && req.method === 'PATCH') {
      const pull = pullsStore.get(Number(pullMatch[1]));
      if (!pull) return sendJson(res, 404, { message: 'Not Found' });
      const body = JSON.parse(await readBodyText(req) || '{}');
      if (body.state) pull.state = body.state;
      return sendJson(res, 200, pull);
    }
    if (rest === 'releases' && req.method === 'GET') {
      return sendJson(res, 200, releasesStore);
    }
    if (rest === 'releases' && req.method === 'POST') {
      const body = JSON.parse(await readBodyText(req) || '{}');
      releaseSeq += 1;
      const rel = {
        id: releaseSeq, tag_name: body.tag_name, name: body.name || '', body: body.body || '',
        draft: !!body.draft, prerelease: !!body.prerelease,
        html_url: `https://github.com/${owner}/${repo}/releases/${body.tag_name}`,
        created_at: new Date().toISOString(), assets: [],
      };
      releasesStore.push(rel);
      return sendJson(res, 201, rel);
    }
    const assetMatch = rest.match(/^releases\/assets\/(\d+)$/);
    if (assetMatch && req.method === 'GET') {
      if (Number(assetMatch[1]) === 21) return sendBuffer(res, 200, ASSET_BYTES, 'application/octet-stream');
      return sendJson(res, 404, { message: 'Not Found' });
    }
    const contentsMatch = rest.match(/^contents\/(.+)$/);
    if (contentsMatch && req.method === 'PUT') {
      const body = JSON.parse(await readBodyText(req) || '{}');
      lastContentsPut = body;
      return sendJson(res, 200, {
        commit: { sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', message: body.message, html_url: `https://github.com/${owner}/${repo}/commit/deadbeef` },
        content: { name: contentsMatch[1].split('/').pop(), path: contentsMatch[1], sha: 'abc123' },
      });
    }
    if (contentsMatch && req.method === 'DELETE') {
      const body = JSON.parse(await readBodyText(req) || '{}');
      lastContentsDelete = body;
      return sendJson(res, 200, {
        commit: { sha: 'feedfacefeedfacefeedfacefeedfacefeedface', message: body.message, html_url: `https://github.com/${owner}/${repo}/commit/feedface` },
      });
    }
  }

  return sendJson(res, 404, { message: 'Not Found' });
}

/* ------------------------------------------------------------------ */
/* Real local git repositories (bare remote + one clone)               */
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

/* ------------------------------------------------------------------ */
/* Bridge spawner (main bridge + the dead-OAuth bridge)                */
/* ------------------------------------------------------------------ */

function startBridge(port, dataDir, extraEnv) {
  const proc = spawn(process.execPath, [BRIDGE_ENTRY], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_DATA_DIR: dataDir,
      GITHUB_API_BASE: MOCK_BASE,
      GITHUB_OAUTH_BASE: extraEnv && extraEnv.GITHUB_OAUTH_BASE ? extraEnv.GITHUB_OAUTH_BASE : MOCK_BASE,
      GITHUB_CODELOAD_BASE: MOCK_BASE,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const box = { proc, out: '' };
  proc.stdout.on('data', (d) => { box.out += d.toString('utf8'); });
  proc.stderr.on('data', (d) => { box.out += d.toString('utf8'); });
  return box;
}

async function waitListening(box, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (box.out.includes('Listening:')) return true;
    if (box.proc.exitCode !== null) return false;
    await sleep(100);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Test runner                                                         */
/* ------------------------------------------------------------------ */

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-test-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Fake GitHub.
  const mock = http.createServer(mockHandler);
  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

  // Real git layout: bare remote + clone A (driven through the bridge).
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

  // Seed a BROKEN token before the first start, so diagnostics can be
  // tested against a 401 token (a bad token can never be stored through
  // the PAT endpoint itself, because sign-in rejects it).
  fs.writeFileSync(path.join(dataDir, '.github-config.json'), JSON.stringify({
    token: BAD_TOKEN,
    user: USER,
    authedAt: new Date().toISOString(),
    authMethod: 'pat',
    scopes: 'repo, read:user',
    autoUpdate: { enabled: false, intervalSeconds: 60, autoSync: false },
  }), { mode: 0o600 });

  const bridge = startBridge(BRIDGE_PORT, dataDir, {});
  let bridgeOut = '';
  const cleanup = (code) => {
    try { bridge.proc.kill('SIGTERM'); } catch (_) {}
    try { mock.close(); } catch (_) {}
    if (failures > 0) {
      console.log('\n--- bridge log (last 40 lines) ---');
      console.log(bridge.out.split('\n').slice(-40).join('\n'));
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nbridge-v3: ${passes} passed, ${failures} failed`);
    process.exit(code);
  };

  if (!(await waitListening(bridge, 'bridge'))) {
    console.log('  FAIL  bridge starts -> ' + bridge.out.slice(-500));
    cleanup(1);
    return;
  }
  check('bridge starts', true);
  bridgeOut = bridge.out;

  const token = fs.readFileSync(path.join(dataDir, '.bridge-token'), 'utf8').trim();
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  async function call(method, p, body) {
    const res = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }
  async function callBuf(method, p, body) {
    const res = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, contentType: res.headers.get('content-type') || '', disposition: res.headers.get('content-disposition') || '' };
  }
  const diagCheck = (diag, key) => (diag.checks || []).find((c) => c.key === key);

  /* ==================== 0. VERSION ==================== */
  console.log('\n[0] version');
  {
    const res = await fetch(BASE + '/health');
    const h = await res.json();
    check('health reports v3.0.1', h.version === '3.1.0', JSON.stringify(h.version));
  }

  /* ==================== 1. DIAGNOSTICS (bad token) ==================== */
  console.log('\n[1] login diagnostics — broken token, OAuth App unconfigured');
  let diag = await call('GET', '/api/github/login/diagnostics');
  check('diagnostics returns 6 checks', Array.isArray(diag.checks) && diag.checks.length === 6, JSON.stringify(diag.checks && diag.checks.length));
  check('diagnostics: bridge check ok', diagCheck(diag, 'bridge') && diagCheck(diag, 'bridge').ok === true, JSON.stringify(diagCheck(diag, 'bridge')));
  check('diagnostics: oauth-app check fails when unconfigured', diagCheck(diag, 'oauth-app') && diagCheck(diag, 'oauth-app').ok === false && /OAuth App/i.test(diagCheck(diag, 'oauth-app').fix || ''), JSON.stringify(diagCheck(diag, 'oauth-app')));
  check('diagnostics: bad token fails with 401 detail', diagCheck(diag, 'token') && diagCheck(diag, 'token').ok === false && /401/.test(diagCheck(diag, 'token').detail || ''), JSON.stringify(diagCheck(diag, 'token')));
  check('diagnostics: scope unknown while token is bad', diagCheck(diag, 'scopes') && diagCheck(diag, 'scopes').ok === false, JSON.stringify(diagCheck(diag, 'scopes')));
  check('diagnostics: rate limit ok when unknown', diagCheck(diag, 'rate-limit') && diagCheck(diag, 'rate-limit').ok === true, JSON.stringify(diagCheck(diag, 'rate-limit')));
  check('diagnostics: github.com reachable (mock returns 401 < 500)', diagCheck(diag, 'reachability') && diagCheck(diag, 'reachability').ok === true, JSON.stringify(diagCheck(diag, 'reachability')));
  check('diagnostics: overall ok=false + Vietnamese summary', diag.ok === false && /vấn đề/.test(diag.summary || ''), JSON.stringify(diag.summary));
  check('diagnostics: authed flag + login from seeded config', diag.authed === true && diag.login === 'octocat', JSON.stringify({ authed: diag.authed, login: diag.login }));

  /* ==================== 2. OAUTH START UNCONFIGURED ==================== */
  console.log('\n[2] OAuth Web Flow start without an OAuth App');
  let r = await call('GET', '/api/github/oauth/start');
  check('oauth start refused with OAUTH_APP_NOT_CONFIGURED', r.status === 400 && r.code === 'OAUTH_APP_NOT_CONFIGURED', JSON.stringify(r).slice(0, 220));
  check('oauth start error is Vietnamese + actionable', /OAuth App/.test(r.error || '') && /Dashboard|dashboard/i.test(r.error || ''), (r.error || '').slice(0, 160));

  /* ==================== 3. PAT FORMAT GUARD ==================== */
  console.log('\n[3] PAT format guard + sign-in');
  await call('POST', '/api/github/logout', {});
  diag = await call('GET', '/api/github/login/diagnostics');
  check('diagnostics: no token after logout', diagCheck(diag, 'token') && diagCheck(diag, 'token').ok === false && /Chưa đăng nhập/.test(diagCheck(diag, 'token').detail || ''), JSON.stringify(diagCheck(diag, 'token')));

  r = await call('POST', '/api/github/auth', { token: 'nguyenvu16592b@gmail.com' });
  check('email rejected with INVALID_TOKEN_FORMAT', r.status === 400 && r.code === 'INVALID_TOKEN_FORMAT', JSON.stringify(r).slice(0, 200));
  check('email error explains passwords are not accepted', /email\/mật khẩu|mật khẩu/.test(r.error || '') && /ghp_/.test(r.error || ''), (r.error || '').slice(0, 200));
  r = await call('POST', '/api/github/auth', { token: 'mat khau 1234567890' });
  check('password with space rejected with INVALID_TOKEN_FORMAT', r.status === 400 && r.code === 'INVALID_TOKEN_FORMAT', JSON.stringify(r).slice(0, 160));
  r = await call('POST', '/api/github/auth', { token: 'notatoken1234567890abcdef' });
  check('random string rejected with INVALID_TOKEN_FORMAT', r.status === 400 && r.code === 'INVALID_TOKEN_FORMAT', JSON.stringify(r).slice(0, 160));
  r = await call('POST', '/api/github/auth', { token: 'ghp_short' });
  check('well-formed but too-short token still refused', r.status === 400 && /too short/i.test(r.error || ''), JSON.stringify(r).slice(0, 160));
  r = await call('POST', '/api/github/auth', { token: GOOD_TOKEN });
  check('good PAT signs in', r.ok === true && r.user && r.user.login === 'octocat', JSON.stringify(r).slice(0, 160));
  r = await call('GET', '/api/github/me');
  check('publicUser now carries email', r.user && r.user.email === 'octocat@github.com', JSON.stringify(r.user));
  r = await call('POST', '/api/github/auth', { token: BAD_TOKEN });
  check('well-formed but revoked token rejected by GitHub (401)', r.status === 401, JSON.stringify(r).slice(0, 160));
  // The failed sign-in must not have wiped the good token.
  r = await call('GET', '/api/github/me');
  check('good token survives a failed sign-in attempt', r.authed === true && r.user && r.user.login === 'octocat', JSON.stringify(r).slice(0, 120));

  /* ==================== 4. DIAGNOSTICS (good token) ==================== */
  console.log('\n[4] login diagnostics — good token, then OAuth App configured');
  diag = await call('GET', '/api/github/login/diagnostics');
  check('diagnostics: token ok with good PAT', diagCheck(diag, 'token') && diagCheck(diag, 'token').ok === true, JSON.stringify(diagCheck(diag, 'token')));
  check('diagnostics: repo scope ok', diagCheck(diag, 'scopes') && diagCheck(diag, 'scopes').ok === true, JSON.stringify(diagCheck(diag, 'scopes')));
  check('diagnostics: overall still false while OAuth App missing', diag.ok === false, JSON.stringify(diag.ok));
  r = await call('POST', '/api/github/oauth/config', { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET });
  check('OAuth App config saved', r.ok === true && r.configured === true, JSON.stringify(r));
  diag = await call('GET', '/api/github/login/diagnostics');
  check('diagnostics: all checks ok once configured', diag.ok === true && diag.checks.every((c) => c.ok), JSON.stringify(diag.checks.map((c) => `${c.key}:${c.ok}`).join(',')));
  check('diagnostics: summary says everything is fine', /Mọi kiểm tra đều ổn/.test(diag.summary || ''), diag.summary);

  /* ==================== 5. DEVICE FLOW ==================== */
  console.log('\n[5] Device Flow (mock)');
  r = await call('POST', '/api/github/auth/device/start', {});
  check('device flow start', r.ok === true && r.user_code === 'ABCD-1234', JSON.stringify(r).slice(0, 160));
  r = await call('POST', '/api/github/auth/device/poll', { device_code: 'dev-code-1' });
  check('device poll pending (1st)', r.status === 'pending', JSON.stringify(r));
  await call('POST', '/api/github/auth/device/poll', { device_code: 'dev-code-1' });
  r = await call('POST', '/api/github/auth/device/poll', { device_code: 'dev-code-1' });
  check('device poll authorized (3rd)', r.status === 'authorized' && r.user.login === 'octocat', JSON.stringify(r).slice(0, 160));
  r = await call('GET', '/api/github/user');
  check('device authMethod recorded', r.authMethod === 'device', JSON.stringify(r.authMethod));

  /* ==================== 6. DIAGNOSTICS, UNREACHABLE GITHUB ========= */
  console.log('\n[6] login diagnostics — github.com unreachable (dead port)');
  {
    const dataDir2 = path.join(tmp, 'data2');
    fs.mkdirSync(dataDir2, { recursive: true });
    const bridge2 = startBridge(BRIDGE2_PORT, dataDir2, { GITHUB_OAUTH_BASE: 'http://127.0.0.1:9' });
    try {
      if (await waitListening(bridge2, 'bridge2')) {
        const token2 = fs.readFileSync(path.join(dataDir2, '.bridge-token'), 'utf8').trim();
        const res2 = await fetch(BASE2 + '/api/github/login/diagnostics', { headers: { Authorization: 'Bearer ' + token2 } });
        const diag2 = await res2.json();
        const reach = (diag2.checks || []).find((c) => c.key === 'reachability');
        check('diagnostics: unreachable github.com fails reachability', reach && reach.ok === false && /Kiểm tra mạng/.test(reach.fix || ''), JSON.stringify(reach));
      } else {
        check('second bridge starts (dead-oauth test)', false, bridge2.out.slice(-300));
      }
    } finally {
      try { bridge2.proc.kill('SIGTERM'); } catch (_) {}
    }
  }

  /* ==================== 7. ZIP DOWNLOAD (mock codeload) ============== */
  console.log('\n[7] repo .zip download');
  r = await call('POST', '/api/repo/select', { path: repoA });
  check('select repo A', r.ok === true, JSON.stringify(r).slice(0, 140));
  let z = await callBuf('GET', '/api/github/repos/octocat/alpha/zip?ref=main');
  check('zip download returns PK bytes', z.status === 200 && z.buf.slice(0, 2).toString() === 'PK' && z.buf.equals(ZIP_BYTES), `status ${z.status}, ${z.buf.length} bytes`);
  check('zip Content-Type is application/zip', /application\/zip/.test(z.contentType), z.contentType);
  check('zip Content-Disposition names alpha-main.zip', /attachment; filename="alpha-main\.zip"/.test(z.disposition), z.disposition);
  z = await callBuf('GET', '/api/github/repos/octocat/alpha/zip');
  check('zip without ref defaults to default_branch', z.status === 200 && /alpha-main\.zip/.test(z.disposition) && z.buf.slice(0, 2).toString() === 'PK', `status ${z.status}, ${z.disposition}`);
  const shaRef = 'a'.repeat(40);
  z = await callBuf('GET', `/api/github/repos/octocat/alpha/zip?ref=${shaRef}`);
  check('zip with 40-hex SHA ref works', z.status === 200 && z.disposition.includes(`alpha-${shaRef}.zip`), `status ${z.status}, ${z.disposition}`);
  r = await call('GET', '/api/github/repos/octocat/alpha/zip?ref=no-such-branch');
  check('zip for unknown branch is a clear 404', r.status === 404 && /Không tìm thấy/.test(r.error || ''), JSON.stringify(r).slice(0, 160));

  /* ==================== 8. GIT ARCHIVE-ZIP =========================== */
  console.log('\n[8] git archive-zip');
  z = await callBuf('POST', '/api/git/archive-zip', { ref: 'HEAD' });
  check('archive-zip returns PK bytes', z.status === 200 && z.buf.slice(0, 2).toString() === 'PK', `status ${z.status}, ${z.buf.length} bytes`);
  check('archive-zip contains the committed file name', z.buf.includes(Buffer.from('f.txt')), 'f.txt not found in zip bytes');
  z = await callBuf('POST', '/api/git/archive-zip', {});
  check('archive-zip defaults to HEAD', z.status === 200 && z.buf.slice(0, 2).toString() === 'PK', `status ${z.status}`);
  r = await call('POST', '/api/git/archive-zip', { ref: 'bad ref!' });
  check('archive-zip refuses an invalid ref', r.status === 400, JSON.stringify(r).slice(0, 140));

  /* ==================== 9. REPO CRUD / FORK / STAR =================== */
  console.log('\n[9] repo create / edit / fork / star / delete');
  r = await call('POST', '/api/github/repos', { name: 'newrepo', description: 'created by v3 test', private: false, auto_init: true });
  check('create repo', r.ok === true && r.repo && r.repo.full_name === 'octocat/newrepo', JSON.stringify(r).slice(0, 180));
  r = await call('POST', '/api/github/repos', { name: 'bad name!' });
  check('create repo with invalid name refused', r.status === 400, JSON.stringify(r).slice(0, 140));
  r = await call('PATCH', '/api/github/repos/octocat/newrepo', { description: 'updated description' });
  check('edit repo description', r.ok === true && r.repo && r.repo.description === 'updated description', JSON.stringify(r).slice(0, 180));
  r = await call('POST', '/api/github/repos/octocat/alpha/fork', {});
  check('fork repo', r.ok === true && r.repo && r.repo.fork === true, JSON.stringify(r).slice(0, 160));
  r = await call('PUT', '/api/github/repos/octocat/alpha/star', {});
  check('star repo', r.ok === true && r.starred === true, JSON.stringify(r));
  r = await call('DELETE', '/api/github/repos/octocat/alpha/star', {});
  check('unstar repo', r.ok === true && r.starred === false, JSON.stringify(r));
  r = await call('DELETE', '/api/github/repos/octocat/newrepo', {});
  check('delete repo without confirm refused', r.status === 400 && /xác nhận/.test(r.error || ''), JSON.stringify(r).slice(0, 160));
  r = await call('DELETE', '/api/github/repos/octocat/newrepo', { confirm: true });
  check('delete repo with confirm', r.ok === true, JSON.stringify(r));

  /* ==================== 10. ISSUES ================================== */
  console.log('\n[10] issues');
  r = await call('POST', '/api/github/repos/octocat/alpha/issues', { title: 'v3 test issue', body: 'hello', labels: ['bug'] });
  check('create issue', r.ok === true && r.issue && r.issue.number === 7 && r.issue.title === 'v3 test issue', JSON.stringify(r).slice(0, 200));
  r = await call('GET', '/api/github/repos/octocat/alpha/issues/7');
  check('read issue with empty comments', r.ok === true && r.issue && r.issue.title === 'v3 test issue' && Array.isArray(r.comments) && r.comments.length === 0, JSON.stringify(r).slice(0, 200));
  r = await call('POST', '/api/github/repos/octocat/alpha/issues/7/comments', { body: 'first comment' });
  check('comment on issue', r.ok === true && r.comment && r.comment.id === 501 && r.comment.body === 'first comment', JSON.stringify(r).slice(0, 180));
  r = await call('GET', '/api/github/repos/octocat/alpha/issues/7');
  check('issue now shows the comment', r.ok === true && r.comments.length === 1 && r.comments[0].body === 'first comment', JSON.stringify(r.comments));
  r = await call('PATCH', '/api/github/repos/octocat/alpha/issues/7', { state: 'closed' });
  check('close issue', r.ok === true && r.issue && r.issue.state === 'closed', JSON.stringify(r).slice(0, 160));
  r = await call('POST', '/api/github/repos/octocat/alpha/issues', { body: 'no title' });
  check('create issue without title refused', r.status === 400, JSON.stringify(r).slice(0, 140));

  /* ==================== 11. PULL REQUESTS =========================== */
  console.log('\n[11] pull requests');
  r = await call('POST', '/api/github/repos/octocat/alpha/pulls', { title: 'v3 test PR', head: 'feature-x', body: 'please merge' });
  check('create PR (base defaults to default_branch)', r.ok === true && r.pull && r.pull.number === 3 && r.pull.base === 'main', JSON.stringify(r).slice(0, 200));
  r = await call('PUT', '/api/github/repos/octocat/alpha/pulls/3/merge', { merge_method: 'squash' });
  check('merge PR', r.ok === true && r.merged === true && /merged/i.test(r.message || ''), JSON.stringify(r));
  r = await call('PATCH', '/api/github/repos/octocat/alpha/pulls/3', { state: 'closed' });
  check('close PR', r.ok === true && r.pull && r.pull.state === 'closed', JSON.stringify(r).slice(0, 160));
  r = await call('POST', '/api/github/repos/octocat/alpha/pulls', { head: 'feature-x' });
  check('create PR without title refused', r.status === 400, JSON.stringify(r).slice(0, 140));

  /* ==================== 12. RELEASES ================================ */
  console.log('\n[12] releases');
  r = await call('GET', '/api/github/repos/octocat/alpha/releases');
  check('list releases with assets', r.ok === true && Array.isArray(r.releases) && r.releases.length === 1 && r.releases[0].tag_name === 'v1.0.0' && r.releases[0].assets[0].name === 'app.zip', JSON.stringify(r).slice(0, 220));
  r = await call('POST', '/api/github/repos/octocat/alpha/releases', { tag_name: 'v2.0.0', name: 'Release 2', body: 'second' });
  check('create release', r.ok === true && r.release && r.release.tag_name === 'v2.0.0', JSON.stringify(r).slice(0, 180));
  z = await callBuf('GET', '/api/github/repos/octocat/alpha/releases/assets/21?name=app.zip');
  check('release asset downloads exact bytes', z.status === 200 && z.buf.equals(ASSET_BYTES), `status ${z.status}, ${z.buf.length} bytes`);
  check('release asset Content-Disposition uses the file name', /attachment; filename="app\.zip"/.test(z.disposition), z.disposition);
  r = await call('GET', '/api/github/repos/octocat/alpha/releases/assets/999?name=nope.zip');
  check('unknown release asset is 404', r.status === 404, JSON.stringify(r).slice(0, 140));
  r = await call('POST', '/api/github/repos/octocat/alpha/releases', { name: 'no tag' });
  check('create release without tag_name refused', r.status === 400, JSON.stringify(r).slice(0, 140));

  /* ==================== 13. CONTENTS (base64 + delete) =============== */
  console.log('\n[13] file contents via API');
  const binB64 = Buffer.from([0, 1, 2, 255, 104, 105]).toString('base64');
  r = await call('PUT', '/api/github/repos/octocat/alpha/contents', { path: 'hello.bin', message: 'add binary', contentBase64: binB64 });
  check('upload binary file via contentBase64', r.ok === true && r.commit && r.commit.sha === 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', JSON.stringify(r).slice(0, 180));
  check('bridge forwarded the exact base64 payload', lastContentsPut && lastContentsPut.content === binB64, JSON.stringify(lastContentsPut && lastContentsPut.content));
  r = await call('DELETE', '/api/github/repos/octocat/alpha/contents', { path: 'hello.bin', message: 'remove binary', sha: 'abc123' });
  check('delete file via API', r.ok === true && r.commit && r.commit.sha === 'feedfacefeedfacefeedfacefeedfacefeedface', JSON.stringify(r).slice(0, 160));
  check('bridge forwarded the delete sha', lastContentsDelete && lastContentsDelete.sha === 'abc123', JSON.stringify(lastContentsDelete));
  r = await call('DELETE', '/api/github/repos/octocat/alpha/contents', { path: 'hello.bin', message: 'no sha' });
  check('delete file without sha refused', r.status === 400, JSON.stringify(r).slice(0, 140));

  /* ==================== 14. SEARCH / NOTIFICATIONS / PROFILE ========= */
  console.log('\n[14] code search / notifications / profile');
  r = await call('GET', '/api/github/search/code?q=f.txt&repo=octocat/alpha');
  check('code search returns the mocked hit', r.ok === true && r.total_count === 1 && r.items[0].name === 'f.txt' && r.items[0].repository === 'octocat/alpha', JSON.stringify(r).slice(0, 200));
  r = await call('GET', '/api/github/search/code');
  check('code search without q refused', r.status === 400, JSON.stringify(r).slice(0, 140));
  r = await call('GET', '/api/github/notifications');
  check('notifications list', r.ok === true && Array.isArray(r.notifications) && r.notifications.length === 1 && r.notifications[0].unread === true && r.notifications[0].repository === 'octocat/alpha', JSON.stringify(r).slice(0, 220));
  r = await call('POST', '/api/github/notifications/read', {});
  check('mark notifications read', r.ok === true, JSON.stringify(r));
  r = await call('GET', '/api/github/profile');
  check('full profile carries email + bio', r.ok === true && r.profile && r.profile.login === 'octocat' && r.profile.email === 'octocat@github.com' && r.profile.bio === 'Test octocat', JSON.stringify(r.profile).slice(0, 220));

  /* ==================== 15. LOCAL GIT: CHERRY-PICK / REVERT / RESET / TAGS */
  console.log('\n[15] local git — cherry-pick / revert / reset / tags');

  // Cherry-pick (success): side branch adds side.txt; main cherry-picks it.
  git(repoA, 'checkout', '-b', 'side');
  fs.writeFileSync(path.join(repoA, 'side.txt'), 'side\n');
  git(repoA, 'add', '.');
  git(repoA, 'commit', '-m', 'side commit');
  const sideSha = git(repoA, 'rev-parse', 'side').trim();
  git(repoA, 'checkout', 'main');
  r = await call('POST', '/api/git/cherry-pick', { sha: sideSha });
  check('cherry-pick succeeds', r.ok === true && r.conflict === false, JSON.stringify(r).slice(0, 180));
  check('cherry-picked file present', fs.existsSync(path.join(repoA, 'side.txt')), '');
  r = await call('POST', '/api/git/cherry-pick', { sha: 'not-a-sha' });
  check('cherry-pick with invalid sha refused', r.status === 400, JSON.stringify(r).slice(0, 140));

  // Revert (success): revert the cherry-picked commit.
  const headSha = git(repoA, 'rev-parse', 'HEAD').trim();
  r = await call('POST', '/api/git/revert', { sha: headSha });
  check('revert succeeds', r.ok === true && r.conflict === false, JSON.stringify(r).slice(0, 180));
  check('reverted file is gone', !fs.existsSync(path.join(repoA, 'side.txt')), '');

  // Reset: soft, then mixed, then hard (with the confirm gate).
  const countOf = () => Number(git(repoA, 'rev-list', '--count', 'HEAD').trim());
  fs.writeFileSync(path.join(repoA, 'r.txt'), 'r\n');
  await call('POST', '/api/git/commit', { summary: 'reset-me', all: true });
  const countBefore = countOf();
  r = await call('POST', '/api/git/reset', { mode: 'soft', ref: 'HEAD~1' });
  check('reset --soft', r.ok === true && r.mode === 'soft', JSON.stringify(r).slice(0, 160));
  check('soft reset: commit undone, change still staged', countOf() === countBefore - 1 && fs.existsSync(path.join(repoA, 'r.txt')) && git(repoA, 'status', '--porcelain').includes('A  r.txt'), git(repoA, 'status', '--porcelain'));
  await call('POST', '/api/git/commit', { summary: 'reset-me-2' });
  r = await call('POST', '/api/git/reset', { mode: 'mixed', ref: 'HEAD~1' });
  check('reset --mixed', r.ok === true && r.mode === 'mixed', JSON.stringify(r).slice(0, 160));
  check('mixed reset: file present but unstaged', fs.existsSync(path.join(repoA, 'r.txt')) && git(repoA, 'status', '--porcelain').includes('?? r.txt'), git(repoA, 'status', '--porcelain'));
  await call('POST', '/api/git/commit', { summary: 'reset-me-3', all: true });
  r = await call('POST', '/api/git/reset', { mode: 'hard', ref: 'HEAD~1' });
  check('reset --hard WITHOUT confirm refused', r.status === 400 && /xác nhận/.test(r.error || ''), JSON.stringify(r).slice(0, 180));
  check('file still there after refused hard reset', fs.existsSync(path.join(repoA, 'r.txt')), '');
  r = await call('POST', '/api/git/reset', { mode: 'hard', ref: 'HEAD~1', confirm: true });
  check('reset --hard WITH confirm succeeds', r.ok === true && r.mode === 'hard', JSON.stringify(r).slice(0, 160));
  check('hard reset: file gone, commit undone', !fs.existsSync(path.join(repoA, 'r.txt')) && countOf() === countBefore - 1, `count ${countOf()} vs ${countBefore - 1}`);
  r = await call('POST', '/api/git/reset', { mode: 'weird' });
  check('reset with invalid mode refused', r.status === 400, JSON.stringify(r).slice(0, 140));
  r = await call('POST', '/api/git/reset', { ref: 'bad ref!' });
  check('reset with invalid ref refused', r.status === 400, JSON.stringify(r).slice(0, 140));

  // Tags: create (lightweight + annotated), list, delete, push.
  r = await call('POST', '/api/git/tag/create', { name: 'v1.0' });
  check('create lightweight tag', r.ok === true && r.tag === 'v1.0' && r.annotated === false, JSON.stringify(r).slice(0, 140));
  r = await call('GET', '/api/git/tags');
  check('tags list has v1.0 with a 40-hex sha', r.ok === true && Array.isArray(r.tags) && r.tags.some((t) => t.name === 'v1.0' && /^[0-9a-f]{40}$/.test(t.sha || '')), JSON.stringify(r.tags));
  r = await call('POST', '/api/git/tag/create', { name: 'v2.0', message: 'second release' });
  check('create annotated tag', r.ok === true && r.tag === 'v2.0' && r.annotated === true, JSON.stringify(r).slice(0, 140));
  r = await call('GET', '/api/git/tags');
  check('tags list has both tags', r.tags.some((t) => t.name === 'v1.0') && r.tags.some((t) => t.name === 'v2.0'), JSON.stringify(r.tags));
  r = await call('POST', '/api/git/tag/delete', { name: 'v1.0' });
  check('delete tag', r.ok === true && r.tag === 'v1.0', JSON.stringify(r).slice(0, 140));
  r = await call('GET', '/api/git/tags');
  check('tags list no longer has v1.0', !r.tags.some((t) => t.name === 'v1.0') && r.tags.some((t) => t.name === 'v2.0'), JSON.stringify(r.tags));
  r = await call('POST', '/api/git/tag/push', { name: 'v2.0' });
  check('push tag to origin', r.ok === true && r.tag === 'v2.0' && r.remote === 'origin', JSON.stringify(r).slice(0, 160));
  const lsTags = git(repoA, 'ls-remote', '--tags', 'origin');
  check('tag exists on remote', /v2\.0/.test(lsTags), lsTags.slice(0, 120));
  r = await call('POST', '/api/git/tag/create', { name: 'bad name!' });
  check('invalid tag name refused', r.status === 400, JSON.stringify(r).slice(0, 140));
  r = await call('POST', '/api/git/tag/push', { name: 'v9.9' });
  check('pushing a missing tag fails', r.status === 400, JSON.stringify(r).slice(0, 160));

  // Cherry-pick conflict: both sides change the same line of f.txt.
  git(repoA, 'checkout', '-b', 'cp-side');
  fs.writeFileSync(path.join(repoA, 'f.txt'), 'one\nCP-SIDE\n');
  git(repoA, 'add', '.');
  git(repoA, 'commit', '-m', 'cp side');
  const cpSha = git(repoA, 'rev-parse', 'cp-side').trim();
  git(repoA, 'checkout', 'main');
  fs.writeFileSync(path.join(repoA, 'f.txt'), 'one\nMAIN-SIDE\n');
  git(repoA, 'add', '.');
  git(repoA, 'commit', '-m', 'main side');
  r = await call('POST', '/api/git/cherry-pick', { sha: cpSha });
  check('cherry-pick reports conflict (HTTP 200, ok:false)', r.status === 200 && r.ok === false && r.conflict === true && (r.conflicts || []).includes('f.txt'), JSON.stringify(r).slice(0, 220));
  git(repoA, 'cherry-pick', '--abort');
  check('working tree clean after cherry-pick abort', git(repoA, 'status', '--porcelain').trim() === '', git(repoA, 'status', '--porcelain'));

  // Revert conflict: revert commit A after commit B rewrote the same line.
  fs.writeFileSync(path.join(repoA, 'f.txt'), 'one\nA-LINE\n');
  git(repoA, 'add', '.');
  git(repoA, 'commit', '-m', 'commit A');
  const aSha = git(repoA, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(repoA, 'f.txt'), 'one\nB-LINE\n');
  git(repoA, 'add', '.');
  git(repoA, 'commit', '-m', 'commit B');
  r = await call('POST', '/api/git/revert', { sha: aSha });
  check('revert reports conflict (HTTP 200, ok:false)', r.status === 200 && r.ok === false && r.conflict === true && (r.conflicts || []).includes('f.txt'), JSON.stringify(r).slice(0, 220));
  git(repoA, 'revert', '--abort');
  check('working tree clean after revert abort', git(repoA, 'status', '--porcelain').trim() === '', git(repoA, 'status', '--porcelain'));

  cleanup(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('bridge-v3 test crashed:', err);
  process.exit(1);
});
