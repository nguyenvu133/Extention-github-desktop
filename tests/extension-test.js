'use strict';

/*
 * Functional test harness for the extension's own source files.
 *
 * It loads dashboard.js / popup.js UNMODIFIED, provides a minimal DOM +
 * chrome.* shim, and runs them against the real bridge on 127.0.0.1:17321.
 * This exercises the actual extension code paths (api(), health(), status(),
 * branches(), history(), commit, stage, diff) without a browser.
 *
 * The harness is self-contained: it creates its own throwaway Git repository
 * in the OS temp directory, so it can be run repeatedly and never depends on
 * (or mutates) any repository you already have.
 *
 * Usage:
 *   1. start the bridge:  node bridge/bridge-server.js
 *   2. run the tests:     node tests/extension-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const EXT = path.resolve(__dirname, '..', 'extension');
const TOKEN_FILE = path.resolve(__dirname, '..', 'bridge', '.bridge-token');
const BASE = process.env.BRIDGE_URL || 'http://127.0.0.1:17321';

if (!fs.existsSync(TOKEN_FILE)) {
  console.error(`\nNo bridge token at ${TOKEN_FILE}`);
  console.error('Start the bridge first:  node bridge/bridge-server.js\n');
  process.exit(1);
}
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

/* ---------------- throwaway repository ---------------- */

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }),
  });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixijs-bridge-test-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Bridge Test']);
  git(dir, ['config', 'user.email', 'bridge-test@example.com']);
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed commit']);
  return dir;
}

/* ---------------- minimal DOM ---------------- */

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

/* ---------------- chrome shim ---------------- */

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
      },
    },
    runtime: {
      getManifest: () => ({ version: '2.0.0' }),
      getURL: (p) => 'chrome-extension://test/' + p,
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    tabs: { create: async () => ({}) },
  };
}

/* ---------------- run a script ---------------- */

const DASHBOARD_IDS = [
  'log', 'lamp', 'bridgeStatus', 'repoName', 'branch', 'remote', 'repoPath',
  'bridgeUrl', 'token', 'summary', 'description', 'branchSelect', 'diff',
  'diffFile', 'changes', 'history', 'saveConnection', 'connectRepo',
  'refreshStatus', 'stageAll', 'unstageAll', 'commit', 'fetch', 'pull',
  'push', 'switchBranch', 'loadHistory', 'copyPath', 'reconnectBtn',
  'userChip', 'userAvatar', 'userLogin', 'logoutBtn', 'loginPanel', 'patInput', 'loginPatBtn',
  'deviceFlowBtn', 'deviceBox', 'deviceCode', 'deviceOpenBtn', 'deviceStatus', 'rateLimit',
  'view-repos', 'view-repo', 'view-local', 'navRepos', 'navLocal', 'globalSearch',
  'repoCount', 'refreshRepos', 'refreshReposForce', 'repoSearch', 'repoFilter', 'repoSort',
  'autoUpdateToggle', 'autoUpdateInterval', 'autoUpdateState', 'manualRefresh', 'updateBadge', 'repoList',
  'backToRepos', 'detailName', 'detailDesc', 'detailBadges', 'detailStars', 'detailForks', 'detailIssues',
  'readmeName', 'readmeView', 'fileBranchSelect', 'fileUpBtn', 'filePathLabel', 'fileTree',
  'fileViewerWrap', 'fileViewerName', 'fileViewerMeta', 'fileViewer',
  'reloadCommits', 'commitList', 'reloadBranches', 'branchList', 'reloadIssues', 'issueList',
  'reloadPulls', 'pullList',
];

function runScript(file, ids, store) {
  const code = fs.readFileSync(path.join(EXT, file), 'utf8');
  const document = makeDocument(ids);
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
    window: { close() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });
  return { document, sandbox };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- tests ---------------- */

(async () => {
  console.log('\n=== Extension functional test (real bridge) ===\n');

  const repo = makeRepo();
  const repoName = path.basename(repo);
  console.log(`temp repository: ${repo}\n`);

  try {
    /* --- 1. dashboard.js boots and connects --- */
    console.log('[dashboard.js]');
    const store = { bridgeUrl: BASE, token: TOKEN };
    const dash = runScript('dashboard.js', DASHBOARD_IDS, store);

    await sleep(1200);
    const d = dash.document;

    check('bridge status shows CONNECTED', d.getElementById('bridgeStatus').textContent === 'BRIDGE CONNECTED',
      d.getElementById('bridgeStatus').textContent);
    check('lamp class is ok', d.getElementById('lamp').className === 'ok', d.getElementById('lamp').className);
    check('token field pre-filled from storage', d.getElementById('token').value === TOKEN);
    check('bridgeUrl field pre-filled', d.getElementById('bridgeUrl').value === BASE);

    /* --- 2. connect the repository through the real UI handler --- */
    d.getElementById('repoPath').value = repo;
    await d.getElementById('connectRepo').onclick();
    await sleep(600);

    check('repoName populated', d.getElementById('repoName').textContent === repoName,
      d.getElementById('repoName').textContent);
    check('branch populated', d.getElementById('branch').textContent === 'main',
      d.getElementById('branch').textContent);
    check('remote shows "No remote" for local repo', d.getElementById('remote').textContent === 'No remote',
      d.getElementById('remote').textContent);
    check('history rendered the seed commit', d.getElementById('history').children.length === 1,
      'children=' + d.getElementById('history').children.length);
    check('branchSelect populated', d.getElementById('branchSelect').children.length > 0,
      'options=' + d.getElementById('branchSelect').children.length);

    /* --- 3. stage / diff / commit through the UI --- */
    const fileName = 'ui-test.txt';
    const fileBody = 'from ui test\n';
    fs.writeFileSync(path.join(repo, fileName), fileBody);

    await d.getElementById('refreshStatus').onclick();
    await sleep(400);

    const rows = d.getElementById('changes').children;
    const uiRow = rows.find((r) => r.children.some((c) => c.textContent === fileName));
    check('new file appears in changes list', !!uiRow,
      'rows=' + rows.length);

    if (uiRow) {
      const buttons = uiRow.children[uiRow.children.length - 1].children;
      const diffBtn = buttons[0];
      const stageBtn = buttons[1];
      check('row has Diff + Stage buttons', !!diffBtn && !!stageBtn);

      await diffBtn.onclick();
      await sleep(400);
      check('diff viewer shows added content', d.getElementById('diff').textContent.includes('from ui test'),
        d.getElementById('diff').textContent.slice(0, 80));

      await stageBtn.onclick();
      await sleep(500);
      check('file became staged', d.getElementById('log').textContent.includes('Staged'),
        d.getElementById('log').textContent);
    }

    d.getElementById('summary').value = 'UI test commit';
    d.getElementById('description').value = 'created by harness';
    await d.getElementById('commit').onclick();
    await sleep(700);
    check('commit succeeded', d.getElementById('log').textContent.includes('Commit created'),
      d.getElementById('log').textContent);
    check('summary field cleared after commit', d.getElementById('summary').value === '');
    check('history grew to 2 commits', d.getElementById('history').children.length === 2,
      'children=' + d.getElementById('history').children.length);

    /* --- 4. error path: bad token --- */
    console.log('\n[error handling]');
    const bad = runScript('dashboard.js', DASHBOARD_IDS, { bridgeUrl: BASE, token: 'deadbeef'.repeat(6) });
    await sleep(1000);
    bad.document.getElementById('repoPath').value = repo;
    await bad.document.getElementById('connectRepo').onclick();
    await sleep(500);
    check('bad token surfaces an error in the log',
      bad.document.getElementById('log').textContent.includes('ERROR'),
      bad.document.getElementById('log').textContent);

    /* --- 5. popup.js --- */
    console.log('\n[popup.js]');
    const pop = runScript('popup.js', [
      'lamp', 'connection', 'repoName', 'branchName', 'repoPath', 'message',
      'version', 'token', 'refresh', 'saveToken', 'open',
    ], { bridgeUrl: BASE, token: TOKEN });
    await sleep(1200);
    const p = pop.document;
    check('popup shows CONNECTED', p.getElementById('connection').textContent === 'CONNECTED',
      p.getElementById('connection').textContent);
    check('popup lamp ok', p.getElementById('lamp').className === 'lamp ok', p.getElementById('lamp').className);
    check('popup shows token accepted', p.getElementById('message').textContent === 'Token accepted',
      p.getElementById('message').textContent);
    check('popup version from manifest', p.getElementById('version').textContent === 'v2.0.0',
      p.getElementById('version').textContent);
    check('popup shows repo name', p.getElementById('repoName').textContent === repoName,
      p.getElementById('repoName').textContent);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }

  console.log('\n=== ' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') + ' ===\n');
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(1);
});
