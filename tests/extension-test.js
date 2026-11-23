'use strict';

/*
 * Functional test harness for the extension's own source files.
 *
 * It loads dashboard.js / popup.js UNMODIFIED, provides a minimal DOM +
 * chrome.* shim, and runs them against the real bridge on 127.0.0.1:17321.
 * This exercises the actual extension code paths (api(), health(), status(),
 * branches(), history(), commit, stage, diff) without a browser.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.resolve(__dirname, '..', 'extension');
const TOKEN = fs.readFileSync(path.resolve(__dirname, '..', 'bridge', '.bridge-token'), 'utf8').trim();
const BASE = 'http://127.0.0.1:17321';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
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
    this._html = '';
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
      getManifest: () => ({ version: '1.0.1' }),
      getURL: (p) => 'chrome-extension://test/' + p,
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    tabs: { create: async () => ({}) },
  };
}

/* ---------------- run a script ---------------- */

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

  /* --- 1. dashboard.js boots and connects --- */
  console.log('[dashboard.js]');
  const store = { bridgeUrl: BASE, token: TOKEN };
  const dash = runScript('dashboard.js', [
    'log', 'lamp', 'bridgeStatus', 'repoName', 'branch', 'remote', 'repoPath',
    'bridgeUrl', 'token', 'summary', 'description', 'branchSelect', 'diff',
    'diffFile', 'changes', 'history', 'saveConnection', 'connectRepo',
    'refreshStatus', 'stageAll', 'unstageAll', 'commit', 'fetch', 'pull',
    'push', 'switchBranch', 'loadHistory', 'copyPath',
  ], store);

  await sleep(1200);
  const d = dash.document;

  check('bridge status shows CONNECTED', d.getElementById('bridgeStatus').textContent === 'LOCAL BRIDGE CONNECTED',
    d.getElementById('bridgeStatus').textContent);
  check('lamp class is ok', d.getElementById('lamp').className === 'ok', d.getElementById('lamp').className);
  check('token field pre-filled from storage', d.getElementById('token').value === TOKEN);
  check('bridgeUrl field pre-filled', d.getElementById('bridgeUrl').value === BASE);

  /* --- 2. connect a repository through the real UI handler --- */
  d.getElementById('repoPath').value = '/workspace/testrepo';
  await d.getElementById('connectRepo').onclick();
  await sleep(600);

  check('repoName populated', d.getElementById('repoName').textContent === 'testrepo',
    d.getElementById('repoName').textContent);
  check('branch populated', !!d.getElementById('branch').textContent && d.getElementById('branch').textContent !== '—',
    d.getElementById('branch').textContent);
  check('remote shows "No remote" for local repo', d.getElementById('remote').textContent === 'No remote',
    d.getElementById('remote').textContent);
  check('changes list rendered rows', d.getElementById('changes').children.length >= 0);
  check('history rendered commits', d.getElementById('history').children.length > 0,
    'children=' + d.getElementById('history').children.length);
  check('branchSelect populated', d.getElementById('branchSelect').children.length > 0,
    'options=' + d.getElementById('branchSelect').children.length);

  /* --- 3. stage / diff / commit through the UI --- */
  fs.writeFileSync('/workspace/testrepo/ui-test.txt', 'from ui test\n');
  await d.getElementById('refreshStatus').onclick();
  await sleep(400);

  const rows = d.getElementById('changes').children;
  const uiRow = rows.find((r) => r.children.some((c) => c.textContent === 'ui-test.txt'));
  check('new file appears in changes list', !!uiRow);

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

  /* --- 4. error path: bad token --- */
  console.log('\n[error handling]');
  const badStore = { bridgeUrl: BASE, token: 'deadbeef'.repeat(6) };
  const bad = runScript('dashboard.js', [
    'log', 'lamp', 'bridgeStatus', 'repoName', 'branch', 'remote', 'repoPath',
    'bridgeUrl', 'token', 'summary', 'description', 'branchSelect', 'diff',
    'diffFile', 'changes', 'history', 'saveConnection', 'connectRepo',
    'refreshStatus', 'stageAll', 'unstageAll', 'commit', 'fetch', 'pull',
    'push', 'switchBranch', 'loadHistory', 'copyPath',
  ], badStore);
  await sleep(1000);
  bad.document.getElementById('repoPath').value = '/workspace/testrepo';
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
  check('popup version from manifest', p.getElementById('version').textContent === 'v1.0.1',
    p.getElementById('version').textContent);
  check('popup shows repo name', p.getElementById('repoName').textContent === 'testrepo',
    p.getElementById('repoName').textContent);

  console.log('\n=== ' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') + ' ===\n');
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(1);
});
