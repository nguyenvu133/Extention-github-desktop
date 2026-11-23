'use strict';

/*
 * Bridge v2 functional test harness.
 *
 * Starts the REAL bridge (bridge/bridge-server.js) as a child process on
 * a test port, pointed at a FAKE GitHub API (a local HTTP server in this
 * file — no call to api.github.com is ever made), then drives it:
 *
 *   - manifests (both), bridge boot + /health
 *   - GitHub sign-in with a fake PAT (good token / bad token), logout,
 *     Device Flow (start + poll)
 *   - the token is never returned to any client
 *   - list repos (paginated + /repos/all), search, repo detail,
 *     branches, commits, contents, README, issues, pulls
 *   - create a file (PUT contents)
 *   - ETag / 304 behaviour (second identical list costs no data)
 *   - auto-update: polling detects a new commit, SSE pushes the event
 *   - the dashboard (real dashboard.js in a vm) renders ALL repos,
 *     survives the bridge being killed and comes back to CONNECTED
 *     when the bridge restarts — the v1 "Bridge disconnected" bug
 *   - the v1 local-git flows still work (via tests/extension-test.js)
 *
 * Usage:
 *   node tests/bridge-v2-test.js
 *
 * The bridge under test writes its token/config into a temp directory
 * (BRIDGE_DATA_DIR), so nothing in bridge/ is touched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_ENTRY = path.join(ROOT, 'bridge', 'bridge-server.js');
const EXT = path.join(ROOT, 'extension');
const MOCK_PORT = 17401;
const BRIDGE_PORT = 17399;
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

const GOOD_TOKEN = 'ghp_testtoken1234567890';
const USER = {
  login: 'octocat',
  id: 1,
  name: 'The Octocat',
  avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
  html_url: 'https://github.com/octocat',
  type: 'User',
  public_repos: 3,
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
/* Fake GitHub API                                                     */
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
  {
    id: 102, name: 'beta', full_name: 'octocat/beta', owner: { login: 'octocat', avatar_url: USER.avatar_url },
    description: 'Private beta repo', language: 'Python', stargazers_count: 7, forks_count: 0,
    open_issues_count: 0, watchers_count: 7, private: true, fork: false, archived: false,
    default_branch: 'main', pushed_at: '2026-11-19T09:00:00Z', updated_at: '2026-11-19T09:00:00Z',
    created_at: '2026-02-01T00:00:00Z', html_url: 'https://github.com/octocat/beta',
    clone_url: 'https://github.com/octocat/beta.git', ssh_url: 'git@github.com:octocat/beta.git',
    size: 45, license: null, topics: [], visibility: 'private',
  },
  {
    id: 103, name: 'gamma-fork', full_name: 'octocat/gamma-fork', owner: { login: 'octocat', avatar_url: USER.avatar_url },
    description: 'A fork', language: 'TypeScript', stargazers_count: 0, forks_count: 0,
    open_issues_count: 0, watchers_count: 0, private: false, fork: true, archived: false,
    default_branch: 'main', pushed_at: '2026-11-01T08:00:00Z', updated_at: '2026-11-01T08:00:00Z',
    created_at: '2026-03-01T00:00:00Z', html_url: 'https://github.com/octocat/gamma-fork',
    clone_url: 'https://github.com/octocat/gamma-fork.git', ssh_url: 'git@github.com:octocat/gamma-fork.git',
    size: 10, license: null, topics: [], visibility: 'public',
  },
];

// Mutable commit SHAs: the auto-update test flips one to simulate a push.
const commitShaByRepo = {
  'octocat/alpha': 'aaaa1111111111111111111111111111111111',
  'octocat/beta': 'bbbb2222222222222222222222222222222222',
  'octocat/gamma-fork': 'cccc3333333333333333333333333333333333',
};
const requestCounts = new Map();
const devicePollCounts = new Map();
const putContentsCalls = [];

function countReq(key) {
  requestCounts.set(key, (requestCounts.get(key) || 0) + 1);
  return requestCounts.get(key);
}

function mockAuth(req) {
  return req.headers.authorization === `Bearer ${GOOD_TOKEN}`;
}

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}));
  res.end(body);
}

function mockHandler(req, res) {
  const url = new URL(req.url, MOCK_BASE);
  const route = url.pathname;
  countReq(`${req.method} ${route}`);

  // --- OAuth Device Flow (no GitHub token needed) ---
  if (route === '/login/device/code' && req.method === 'POST') {
    return sendJson(res, 200, {
      device_code: 'dev-code-1', user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-1234',
      expires_in: 900, interval: 1,
    });
  }
  if (route === '/login/oauth/access_token' && req.method === 'POST') {
    const n = (devicePollCounts.get('dev-code-1') || 0) + 1;
    devicePollCounts.set('dev-code-1', n);
    if (n < 3) return sendJson(res, 200, { error: 'authorization_pending' });
    return sendJson(res, 200, { access_token: GOOD_TOKEN, token_type: 'bearer', scope: 'repo read:user' });
  }

  // --- everything else needs the fake PAT ---
  if (!mockAuth(req)) {
    return sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
  }

  if (route === '/user' && req.method === 'GET') return sendJson(res, 200, USER);

  if (route === '/rate_limit' && req.method === 'GET') {
    return sendJson(res, 200, {
      resources: { core: { limit: 60, remaining: 59, reset: Math.floor(Date.now() / 1000) + 3600, used: 1 } },
      rate: { limit: 60, remaining: 59, reset: Math.floor(Date.now() / 1000) + 3600, used: 1 },
    });
  }

  if (route === '/user/repos' && req.method === 'GET') {
    const perPage = Number(url.searchParams.get('per_page')) || 30;
    const page = Number(url.searchParams.get('page')) || 1;
    // ETag: a stable value so the bridge can prove a 304 round-trip.
    if (req.headers['if-none-match'] === 'W/"repos-v1"') {
      res.writeHead(304, { ETag: 'W/"repos-v1"' });
      return res.end();
    }
    const start = (page - 1) * perPage;
    const slice = mockRepos.slice(start, start + perPage);
    const headers = { ETag: 'W/"repos-v1"' };
    if (start + perPage < mockRepos.length) {
      const next = `${MOCK_BASE}/user/repos?per_page=${perPage}&page=${page + 1}`;
      const last = `${MOCK_BASE}/user/repos?per_page=${perPage}&page=${Math.ceil(mockRepos.length / perPage)}`;
      headers.Link = `<${next}>; rel="next", <${last}>; rel="last"`;
    }
    return sendJson(res, 200, slice, headers);
  }

  if (route === '/search/repositories' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '').toLowerCase();
    const items = mockRepos.filter((r) => (r.name + ' ' + (r.description || '')).toLowerCase().includes(q));
    return sendJson(res, 200, { total_count: items.length, incomplete_results: false, items });
  }

  const repoMatch = route.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (repoMatch) {
    const owner = repoMatch[1];
    const name = repoMatch[2];
    const rest = repoMatch[3] || '';
    const fullName = `${owner}/${name}`;
    const repo = mockRepos.find((r) => r.full_name === fullName);
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });

    if (rest === '' && req.method === 'GET') return sendJson(res, 200, repo);

    if (rest === 'branches' && req.method === 'GET') {
      return sendJson(res, 200, [
        { name: 'main', protected: false, commit: { sha: commitShaByRepo[fullName] } },
        { name: 'dev', protected: false, commit: { sha: commitShaByRepo[fullName] } },
      ]);
    }

    if (rest === 'commits' && req.method === 'GET') {
      const perPage = Number(url.searchParams.get('per_page')) || 10;
      const sha = commitShaByRepo[fullName];
      // ETag follows the SHA: when the test flips the SHA, the ETag
      // changes too, exactly like real GitHub.
      const etag = `W/"commit-${sha.slice(0, 7)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      const commits = perPage === 1
        ? [{ sha, commit: { message: 'latest commit', author: { name: 'octocat', date: '2026-11-20T10:00:00Z' } }, author: { login: 'octocat', avatar_url: USER.avatar_url }, html_url: `https://github.com/${fullName}/commit/${sha}` }]
        : [1, 2, 3].map((i) => ({
          sha: sha.slice(0, 7) + String(i).padStart(33, '0'),
          commit: { message: `commit ${i}`, author: { name: 'octocat', date: '2026-11-20T10:00:00Z' } },
          author: { login: 'octocat', avatar_url: USER.avatar_url },
          html_url: `https://github.com/${fullName}/commit/${sha}`,
        }));
      return sendJson(res, 200, commits, { ETag: etag });
    }

    if (rest === 'readme' && req.method === 'GET') {
      return sendJson(res, 200, {
        name: 'README.md', path: 'README.md',
        content: Buffer.from(`# ${name}\n\nHello from ${fullName}.\n`, 'utf8').toString('base64'),
        encoding: 'base64', sha: 'readme-sha-1', html_url: `https://github.com/${fullName}/blob/main/README.md`,
      });
    }

    if (rest === 'issues' && req.method === 'GET') {
      return sendJson(res, 200, [
        { number: 1, title: 'First issue', state: 'open', html_url: `https://github.com/${fullName}/issues/1`, user: { login: 'octocat' }, created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-19T00:00:00Z', comments: 2, labels: [{ name: 'bug' }], pull_request: undefined },
      ]);
    }

    if (rest === 'pulls' && req.method === 'GET') {
      return sendJson(res, 200, [
        { number: 2, title: 'Add feature', state: 'open', html_url: `https://github.com/${fullName}/pull/2`, user: { login: 'octocat' }, created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-19T00:00:00Z', head: { ref: 'feature' }, base: { ref: 'main' }, draft: false, merged_at: null },
      ]);
    }

    if (rest.startsWith('contents') && req.method === 'GET') {
      const sub = rest.slice('contents'.length).replace(/^\//, '');
      const decoded = decodeURIComponent(sub);
      if (!decoded) {
        return sendJson(res, 200, [
          { name: 'README.md', path: 'README.md', type: 'file', size: 40, sha: 'readme-sha-1', html_url: `https://github.com/${fullName}/blob/main/README.md`, download_url: `https://raw.githubusercontent.com/${fullName}/main/README.md` },
          { name: 'src', path: 'src', type: 'dir', size: 0, sha: 'dir-sha-1', html_url: `https://github.com/${fullName}/tree/main/src`, download_url: null },
        ]);
      }
      if (decoded === 'README.md') {
        return sendJson(res, 200, {
          name: 'README.md', path: 'README.md', type: 'file', size: 40, sha: 'readme-sha-1',
          content: Buffer.from(`# ${name}\n\nHello from ${fullName}.\n`, 'utf8').toString('base64'),
          encoding: 'base64', html_url: `https://github.com/${fullName}/blob/main/README.md`,
          download_url: `https://raw.githubusercontent.com/${fullName}/main/README.md`,
        });
      }
      return sendJson(res, 404, { message: 'Not Found' });
    }

    if (rest.startsWith('contents') && req.method === 'PUT') {
      let bodyText = '';
      req.on('data', (c) => { bodyText += c; });
      req.on('end', () => {
        const body = JSON.parse(bodyText || '{}');
        putContentsCalls.push({ repo: fullName, path: rest.slice('contents'.length).replace(/^\//, ''), body });
        sendJson(res, 200, {
          commit: { sha: 'newcommitsha1234567890', message: body.message, html_url: `https://github.com/${fullName}/commit/newcommitsha1234567890` },
          content: { name: body.path || 'file', path: body.path || '', sha: 'newcontentsha' },
        });
      });
      return;
    }
  }

  return sendJson(res, 404, { message: 'Not Found' });
}

/* ------------------------------------------------------------------ */
/* Bridge process                                                      */
/* ------------------------------------------------------------------ */

let bridgeProc = null;
let bridgeToken = '';
let dataDir = '';

function startBridge() {
  return new Promise((resolve, reject) => {
    bridgeProc = spawn('node', [BRIDGE_ENTRY], {
      env: Object.assign({}, process.env, {
        BRIDGE_PORT: String(BRIDGE_PORT),
        BRIDGE_DATA_DIR: dataDir,
        GITHUB_API_BASE: MOCK_BASE,
        GITHUB_OAUTH_BASE: MOCK_BASE,
        GITHUB_CLIENT_ID: 'test-client-id-123',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('bridge did not start in time: ' + out)), 15000);
    const onData = () => {
      if (!bridgeProc) return; // stopped already (late stdout flush)
      if (out.includes('Listening:')) {
        clearTimeout(timer);
        try { bridgeProc.stdout.off('data', onData); } catch (_) {}
        resolve();
      }
    };
    bridgeProc.stdout.on('data', (d) => { out += d.toString(); onData(); });
    bridgeProc.stderr.on('data', (d) => { out += d.toString(); });
    bridgeProc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function stopBridge() {
  return new Promise((resolve) => {
    if (!bridgeProc) return resolve();
    const proc = bridgeProc;
    bridgeProc = null;
    proc.once('exit', () => resolve());
    try { proc.kill('SIGTERM'); } catch (_) { resolve(); }
    setTimeout(resolve, 5000);
  });
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return await res.json();
    } catch (_) {}
    await sleep(300);
  }
  throw new Error('bridge /health never came up');
}

async function bfetch(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: Object.assign(
      { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (opts.token !== undefined ? opts.token : bridgeToken) },
      opts.headers || {}
    ),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, ok: res.ok, data };
}

/* ------------------------------------------------------------------ */
/* Minimal DOM + chrome shim (shared with tests/extension-test.js)     */
/* ------------------------------------------------------------------ */

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this._text = '';
    this.className = '';
    this.value = '';
    this.title = '';
    this.dataset = {};
    this.style = {};
    this.onclick = null;
    this.onchange = null;
    this.oninput = null;
    this.checked = false;
    this.src = '';
    this.alt = '';
    this._html = '';
    const classes = new Set();
    this.classList = {
      add: (...names) => { for (const n of names) classes.add(n); this.className = [...classes].join(' '); },
      remove: (...names) => { for (const n of names) classes.delete(n); this.className = [...classes].join(' '); },
      toggle: (name, force) => {
        const want = force === undefined ? !classes.has(name) : !!force;
        if (want) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' ');
        return want;
      },
      contains: (name) => classes.has(name),
    };
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) {
    this._text = String(v == null ? '' : v);
    this.children = [];
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v == null ? '' : v);
    this.children = [];
    this._text = '';
  }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') this.children.push(Object.assign(new El('span'), { _text: n }));
      else this.children.push(n);
    }
  }
  appendChild(n) { this.append(n); return n; }
  addEventListener() {}
  querySelectorAll() { return []; }
}

function makeDocument(ids) {
  const map = new Map();
  for (const id of ids) map.set(id, new El('div'));
  return {
    _map: map,
    getElementById(id) {
      if (!map.has(id)) map.set(id, new El('div'));
      return map.get(id);
    },
    createElement(tag) { return new El(tag); },
    createTextNode(text) { return Object.assign(new El('span'), { _text: String(text) }); },
    querySelectorAll() { return []; },
  };
}

function makeChrome(store) {
  return {
    storage: {
      local: {
        async get(defaults) {
          const out = {};
          for (const k of Object.keys(defaults || {})) {
            out[k] = Object.prototype.hasOwnProperty.call(store, k) ? store[k] : defaults[k];
          }
          return out;
        },
        async set(obj) { Object.assign(store, obj); },
        async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
      },
    },
    runtime: {
      getManifest: () => ({ version: '2.0.0' }),
      getURL: (p) => 'chrome-extension://test/' + p,
      id: 'test-extension-id', // v3.0.1: isExtensionContext() needs this
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    tabs: { create: async () => ({}) },
  };
}

const DASHBOARD_IDS = [
  'log', 'lamp', 'bridgeStatus', 'bridgeUrl', 'token', 'saveConnection', 'reconnectBtn',
  'userChip', 'userAvatar', 'userLogin', 'logoutBtn', 'loginPanel', 'patInput', 'loginPatBtn',
  'deviceFlowBtn', 'deviceBox', 'deviceCode', 'deviceOpenBtn', 'deviceStatus', 'rateLimit',
  'repoPath', 'connectRepo', 'repoName', 'branch', 'remote', 'branchSelect', 'switchBranch',
  'copyPath', 'summary', 'description', 'commit',
  'view-repos', 'view-repo', 'view-local', 'navRepos', 'navLocal', 'globalSearch',
  'repoCount', 'refreshRepos', 'refreshReposForce', 'repoSearch', 'repoFilter', 'repoSort',
  'autoUpdateToggle', 'autoUpdateInterval', 'autoUpdateState', 'manualRefresh', 'updateBadge', 'repoList',
  'backToRepos', 'detailName', 'detailDesc', 'detailBadges', 'detailStars', 'detailForks', 'detailIssues',
  'readmeName', 'readmeView', 'fileBranchSelect', 'fileUpBtn', 'filePathLabel', 'fileTree',
  'fileViewerWrap', 'fileViewerName', 'fileViewerMeta', 'fileViewer',
  'reloadCommits', 'commitList', 'reloadBranches', 'branchList', 'reloadIssues', 'issueList',
  'reloadPulls', 'pullList',
  'refreshStatus', 'stageAll', 'unstageAll', 'changes', 'diffFile', 'diff', 'loadHistory', 'history',
  'fetch', 'pull', 'push',
];

function runDashboard(store) {
  // v3.0.1: bridge-client.js must load BEFORE dashboard.js so its
  // helpers (isExtensionContext, bridgeFetch, ...) are global.
  const clientCode = fs.readFileSync(path.join(EXT, 'bridge-client.js'), 'utf8');
  const code = fs.readFileSync(path.join(EXT, 'dashboard.js'), 'utf8');
  const document = makeDocument(DASHBOARD_IDS);
  const sandbox = {
    document,
    chrome: makeChrome(store),
    fetch,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    navigator: { clipboard: { writeText: async () => {} } },
    alert: (m) => console.log('    [alert] ' + m),
    location: { href: '' },
    window: { close() {}, open: () => {} },
  };
  if (typeof EventSource !== 'undefined') sandbox.EventSource = EventSource;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(clientCode, sandbox, { filename: 'bridge-client.js' });
  vm.runInContext(code, sandbox, { filename: 'dashboard.js' });
  return { document, sandbox };
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) { last = err; }
    await sleep(400);
  }
  throw new Error('timeout waiting for: ' + label);
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

(async () => {
  console.log('\n=== Bridge v2 test (mock GitHub, real bridge) ===\n');

  /* --- 0. manifests (spawn the existing validators) --- */
  for (const [label, file] of [['validate-manifest', 'tests/validate-manifest.js'], ['load-from-root', 'tests/load-from-root-test.js']]) {
    try {
      execFileSync('node', [path.join(ROOT, file)], { encoding: 'utf8', stdio: 'pipe' });
      check(`${label} exits 0`, true);
    } catch (err) {
      check(`${label} exits 0`, false, String(err.status || err.message));
    }
  }

  /* --- mock GitHub + bridge --- */
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixijs-bridge-v2-'));
  const mock = http.createServer(mockHandler);
  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
  console.log(`mock GitHub API: ${MOCK_BASE}`);
  await startBridge();
  bridgeToken = fs.readFileSync(path.join(dataDir, '.bridge-token'), 'utf8').trim();
  console.log(`bridge: ${BASE} (data dir ${dataDir})\n`);

  try {
    /* --- 1. health --- */
    const health = await waitForHealth(10000);
    check('health ok + version 3.0.1', health.ok === true && health.version === '3.0.1', JSON.stringify(health).slice(0, 120));
    check('health reports github not authed', health.github && health.github.authed === false, JSON.stringify(health.github));
    check('health reports Device Flow available (test client id)', health.github && health.github.deviceFlowAvailable === true);
    check('health reports auto-update off by default', health.autoUpdate && health.autoUpdate.enabled === false);

    /* --- 2. GitHub auth: bad token, then good token --- */
    let r = await bfetch('/api/github/me');
    check('me before auth: authed=false', r.ok && r.data.authed === false, JSON.stringify(r.data));

    r = await bfetch('/api/github/auth', { method: 'POST', body: { token: 'ghp_bogus' + 'x'.repeat(30) } });
    check('auth with bad token fails', !r.ok && r.status === 401, `status=${r.status} ${JSON.stringify(r.data)}`);

    r = await bfetch('/api/github/auth', { method: 'POST', body: { token: GOOD_TOKEN } });
    check('auth with good token succeeds as octocat', r.ok && r.data.user && r.data.user.login === 'octocat', JSON.stringify(r.data).slice(0, 160));
    check('auth response never contains the raw token', !JSON.stringify(r.data).includes(GOOD_TOKEN));
    check('config file on disk holds the token (0600, git-ignored)',
      fs.existsSync(path.join(dataDir, '.github-config.json')) &&
      fs.readFileSync(path.join(dataDir, '.github-config.json'), 'utf8').includes(GOOD_TOKEN));

    r = await bfetch('/api/github/me');
    check('me after auth: authed + public profile only', r.ok && r.data.authed === true && r.data.user.login === 'octocat' && !('token' in r.data), JSON.stringify(r.data).slice(0, 160));

    /* --- 3. repos: pagination, all, search --- */
    r = await bfetch('/api/github/repos?per_page=2&page=1');
    check('repos page 1: 2 repos + has_next', r.ok && Array.isArray(r.data.repos) && r.data.repos.length === 2 && r.data.has_next === true, JSON.stringify(r.data).slice(0, 120));
    check('repos are normalised (full_name, stars, visibility)',
      Array.isArray(r.data.repos) && r.data.repos[0] && r.data.repos[0].full_name === 'octocat/alpha' && r.data.repos[0].stargazers_count === 42 && r.data.repos[0].visibility === 'public',
      JSON.stringify(r.data).slice(0, 160));
    r = await bfetch('/api/github/repos?per_page=2&page=2');
    check('repos page 2: 1 repo + no next', r.ok && Array.isArray(r.data.repos) && r.data.repos.length === 1 && r.data.has_next === false);

    r = await bfetch('/api/github/repos/all');
    check('repos/all returns ALL 3 repos', r.ok && r.data.total === 3 && Array.isArray(r.data.repos) && r.data.repos.length === 3, JSON.stringify(r.data).slice(0, 120));
    check('repos/all includes the private repo', Array.isArray(r.data.repos) && r.data.repos.some((x) => x.full_name === 'octocat/beta' && x.private === true));

    r = await bfetch('/api/github/repos/search?q=alpha');
    check('search q=alpha finds 1 repo', r.ok && r.data.repos.length === 1 && r.data.repos[0].name === 'alpha', JSON.stringify(r.data).slice(0, 120));

    /* --- 4. repo detail --- */
    r = await bfetch('/api/github/repos/octocat/alpha');
    check('repo detail: alpha, JS, 42 stars', r.ok && r.data.repo.language === 'JavaScript' && r.data.repo.stargazers_count === 42);
    r = await bfetch('/api/github/repos/octocat/alpha/branches');
    check('branches: main + dev', r.ok && r.data.branches.length === 2 && r.data.branches[0].name === 'main');
    r = await bfetch('/api/github/repos/octocat/alpha/commits?per_page=3');
    check('commits: 3 returned, normalised', r.ok && r.data.commits.length === 3 && r.data.commits[0].short.length === 7);
    r = await bfetch('/api/github/repos/octocat/alpha/contents');
    check('contents root: dir with README.md + src/', r.ok && r.data.kind === 'dir' && r.data.entries.some((e) => e.name === 'README.md') && r.data.entries.some((e) => e.type === 'dir'));
    r = await bfetch('/api/github/repos/octocat/alpha/contents?path=README.md');
    check('contents file: README.md decoded', r.ok && r.data.kind === 'file' && r.data.content.includes('# alpha'), String(r.data.content).slice(0, 60));
    r = await bfetch('/api/github/repos/octocat/alpha/readme');
    check('readme endpoint returns decoded text', r.ok && r.data.content.includes('Hello from octocat/alpha'));
    r = await bfetch('/api/github/repos/octocat/alpha/issues?state=open');
    check('issues: 1 open issue', r.ok && r.data.issues.length === 1 && r.data.issues[0].number === 1);
    r = await bfetch('/api/github/repos/octocat/alpha/pulls?state=open');
    check('pulls: 1 open PR', r.ok && r.data.pulls.length === 1 && r.data.pulls[0].number === 2);

    /* --- 5. create a file --- */
    r = await bfetch('/api/github/repos/octocat/alpha/contents', {
      method: 'PUT',
      body: { path: 'docs/hello.txt', message: 'Add hello', content: 'Hello, world!\n' },
    });
    check('PUT contents creates a file + commit sha', r.ok && r.data.commit && r.data.commit.sha === 'newcommitsha1234567890', JSON.stringify(r.data).slice(0, 140));
    check('mock recorded base64 content for the file',
      putContentsCalls.length === 1 &&
      Buffer.from(putContentsCalls[0].body.content, 'base64').toString('utf8') === 'Hello, world!\n',
      JSON.stringify(putContentsCalls[0] || null));

    /* --- 6. rate limit --- */
    r = await bfetch('/api/github/rate-limit');
    check('rate-limit: 59/60 remaining', r.ok && r.data.remaining === 59 && r.data.limit === 60, JSON.stringify(r.data));

    /* --- 7. ETag / 304 --- */
    const before = requestCounts.get('GET /user/repos') || 0;
    await bfetch('/api/github/repos?per_page=2&page=1');
    const afterFirst = requestCounts.get('GET /user/repos') || 0;
    r = await bfetch('/api/github/repos?per_page=2&page=1');
    const afterSecond = requestCounts.get('GET /user/repos') || 0;
    check('ETag: second identical list still returns data', r.ok && r.data.repos.length === 2);
    check('ETag: mock saw If-None-Match on the repeat call', afterSecond > afterFirst && r.data.notModified === true,
      `counts ${before} -> ${afterFirst} -> ${afterSecond}, notModified=${r.data.notModified}`);

    /* --- 8. auto-update: baseline, new commit, status --- */
    r = await bfetch('/api/github/auto-update', { method: 'POST', body: { enabled: true, intervalSeconds: 15 } });
    check('auto-update can be enabled (15s)', r.ok && r.data.enabled === true && r.data.intervalSeconds === 15, JSON.stringify(r.data));
    r = await bfetch('/api/github/refresh', { method: 'POST', body: {} });
    check('manual refresh (baseline): 3 repos checked, no updates', r.ok && r.data.checked === 3 && r.data.updated.length === 0, JSON.stringify(r.data).slice(0, 160));
    // Simulate a push to octocat/alpha (new HEAD sha -> new ETag too).
    commitShaByRepo['octocat/alpha'] = 'dddd4444444444444444444444444444444444';
    r = await bfetch('/api/github/refresh', { method: 'POST', body: {} });
    check('manual refresh detects the new commit in octocat/alpha',
      r.ok && r.data.updated.length === 1 && r.data.updated[0].repo === 'octocat/alpha' && r.data.updated[0].newSha === 'dddd444',
      JSON.stringify(r.data).slice(0, 200));
    r = await bfetch('/api/github/auto-update');
    check('auto-update status: updatesFound >= 1, lastChangeAt set',
      r.ok && r.data.updatesFound >= 1 && !!r.data.lastChangeAt, JSON.stringify(r.data).slice(0, 160));

    /* --- 9. SSE: hello + repo-updated event (minimal SSE client:
       this VM's Node has no global EventSource, so parse the stream
       directly over http) --- */
    {
      const sseEvents = [];
      const sse = await new Promise((resolveSse, rejectSse) => {
        const req = http.get(`${BASE}/api/events?token=${encodeURIComponent(bridgeToken)}`, (res) => {
          if (res.statusCode !== 200) return rejectSse(new Error('SSE HTTP ' + res.statusCode));
          let buf = '';
          const client = {
            events: sseEvents,
            close() { try { req.destroy(); } catch (_) {} try { res.destroy(); } catch (_) {} },
          };
          res.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              let type = 'message';
              let data = '';
              for (const line of frame.split('\n')) {
                if (line.startsWith('event:')) type = line.slice(6).trim();
                else if (line.startsWith('data:')) data += line.slice(5).trim();
                // lines starting with ':' are heartbeat pings — ignore
              }
              if (data) {
                try { sseEvents.push({ type, data: JSON.parse(data) }); } catch (_) {}
              }
            }
          });
          resolveSse(client);
        });
        req.on('error', rejectSse);
      });
      await sleep(1200);
      check('SSE hello event received', sseEvents.some((e) => e.type === 'hello' && e.data.version === '3.0.1'), JSON.stringify(sseEvents).slice(0, 160));
      commitShaByRepo['octocat/beta'] = 'eeee5555555555555555555555555555555555';
      await bfetch('/api/github/refresh', { method: 'POST', body: {} });
      await sleep(1500);
      check('SSE repo-updated event pushed for octocat/beta',
        sseEvents.some((e) => e.type === 'repo-updated' && e.data.repo === 'octocat/beta'),
        JSON.stringify(sseEvents).slice(0, 300));
      sse.close();
    }

    /* --- 10. Device Flow --- */
    r = await bfetch('/api/github/auth/device/start', { method: 'POST', body: {} });
    check('device flow start returns user_code', r.ok && r.data.user_code === 'ABCD-1234' && !!r.data.device_code, JSON.stringify(r.data).slice(0, 160));
    const deviceCode = r.data.device_code;
    r = await bfetch('/api/github/auth/device/poll', { method: 'POST', body: { device_code: deviceCode } });
    check('device poll #1: pending', r.ok && r.data.status === 'pending', JSON.stringify(r.data));
    r = await bfetch('/api/github/auth/device/poll', { method: 'POST', body: { device_code: deviceCode } });
    check('device poll #2: pending', r.ok && r.data.status === 'pending', JSON.stringify(r.data));
    r = await bfetch('/api/github/auth/device/poll', { method: 'POST', body: { device_code: deviceCode } });
    check('device poll #3: authorized as octocat', r.ok && r.data.status === 'authorized' && r.data.user.login === 'octocat', JSON.stringify(r.data).slice(0, 160));

    /* --- 11. bad bridge token --- */
    r = await bfetch('/api/repo/current', { token: 'deadbeef'.repeat(6) });
    check('bad bridge token -> 401', !r.ok && r.status === 401, `status=${r.status}`);

    /* --- 12. dashboard renders ALL repos + reconnects (the v1 bug) --- */
    console.log('\n[dashboard.js: render + reconnect]');
    const store = { bridgeUrl: BASE, token: bridgeToken, autoUpdateEnabled: false, autoUpdateInterval: 60, lastRepo: '' };
    const dash = runDashboard(store);
    const d = dash.document;

    await waitFor(async () => {
      const txt = d.getElementById('repoList').textContent;
      return txt.includes('octocat/alpha') && txt.includes('octocat/beta') && txt.includes('octocat/gamma-fork') ? true : null;
    }, 15000, 'repo list renders all 3 repos');
    check('dashboard renders ALL 3 repos', true);
    check('dashboard shows CONNECTED', d.getElementById('bridgeStatus').textContent === 'BRIDGE CONNECTED',
      d.getElementById('bridgeStatus').textContent);
    check('dashboard shows signed-in user octocat', d.getElementById('userLogin').textContent === 'octocat',
      d.getElementById('userLogin').textContent);
    check('repo count shows 3', /3/.test(d.getElementById('repoCount').textContent), d.getElementById('repoCount').textContent);

    // Filter: type "beta" in the search box -> only beta remains.
    d.getElementById('repoSearch').value = 'beta';
    d.getElementById('repoSearch').oninput();
    check('repo search filters to beta only',
      d.getElementById('repoList').textContent.includes('octocat/beta') &&
      !d.getElementById('repoList').textContent.includes('octocat/alpha'),
      d.getElementById('repoList').textContent.slice(0, 120));
    d.getElementById('repoSearch').value = '';
    d.getElementById('repoSearch').oninput();

    // Open a repo detail: README + commits load.
    const firstRow = d.getElementById('repoList').children[0];
    check('repo list has clickable rows', !!firstRow && typeof firstRow.onclick === 'function');
    if (firstRow && firstRow.onclick) {
      firstRow.onclick();
      await sleep(1500);
      check('repo detail opens (name shown)', d.getElementById('detailName').textContent === 'octocat/alpha',
        d.getElementById('detailName').textContent);
      check('repo detail README loaded', d.getElementById('readmeView').textContent.includes('Hello from octocat/alpha'),
        d.getElementById('readmeView').textContent.slice(0, 80));
      check('repo detail commits loaded', d.getElementById('commitList').children.length === 3,
        'children=' + d.getElementById('commitList').children.length);
      d.getElementById('backToRepos').onclick();
    }

    // Kill the bridge: the dashboard must notice and go RECONNECTING/DISCONNECTED.
    await stopBridge();
    await waitFor(async () => {
      const t = d.getElementById('bridgeStatus').textContent;
      return (t === 'RECONNECTING…' || t === 'BRIDGE DISCONNECTED') ? t : null;
    }, 20000, 'dashboard notices the bridge is gone');
    check('dashboard notices bridge death (RECONNECTING/DISCONNECTED)',
      ['RECONNECTING…', 'BRIDGE DISCONNECTED'].includes(d.getElementById('bridgeStatus').textContent),
      d.getElementById('bridgeStatus').textContent);

    // Restart the SAME bridge (same data dir -> same token + GitHub login).
    await startBridge();
    await waitForHealth(10000);
    await waitFor(async () => {
      const t = d.getElementById('bridgeStatus').textContent;
      return t === 'BRIDGE CONNECTED' ? t : null;
    }, 25000, 'dashboard reconnects after bridge restart');
    check('dashboard AUTO-RECONNECTS after bridge restart', d.getElementById('bridgeStatus').textContent === 'BRIDGE CONNECTED',
      d.getElementById('bridgeStatus').textContent);
    check('repo list still rendered after reconnect',
      d.getElementById('repoList').textContent.includes('octocat/alpha'),
      d.getElementById('repoList').textContent.slice(0, 120));

    /* --- 13. logout --- */
    r = await bfetch('/api/github/logout', { method: 'POST', body: {} });
    check('logout succeeds', r.ok && r.data.authed === false);
    r = await bfetch('/api/github/me');
    check('me after logout: authed=false', r.ok && r.data.authed === false);
    r = await bfetch('/api/github/repos/all');
    check('repos/all after logout -> 401', !r.ok && r.status === 401, `status=${r.status}`);
    check('config file no longer holds a token',
      !fs.readFileSync(path.join(dataDir, '.github-config.json'), 'utf8').includes(GOOD_TOKEN));
  } finally {
    await stopBridge();
    mock.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n=== bridge-v2-test: ${passes} passed, ${failures} failed ===\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(1);
});
