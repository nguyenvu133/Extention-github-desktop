'use strict';
require('./_node16-fetch'); // v3.1.0: Node 16.13 has no global fetch

/*
 * Functional test harness for the extension's own source files.
 *
 * It loads dashboard.js / popup.js UNMODIFIED, provides a minimal DOM +
 * chrome.* shim, and runs them against the real bridge on 127.0.0.1:17321.
 * This exercises the actual extension code paths (api(), health(), status(),
 * branches(), history(), commit, stage, diff) without a browser.
 *
 * v3.0 additions: looksLikeGithubToken shape checks, login-diagnostics
 * rendering (soft-skips when the bridge is older than v3.0 and lacks the
 * route), the downloadBlob helper, and existence checks for the v3.0
 * functions (repos/releases/issues/pulls/notifications/profile/settings/
 * cherry-pick/revert/reset/tags/local .zip).
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
      getManifest: () => ({ version: '3.1.1' }),
      getURL: (p) => 'chrome-extension://test/' + p,
      id: 'test-extension-id', // v3.0.1: isExtensionContext() needs this
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
  'userChip', 'userAvatar', 'userLogin', 'userEmail', 'logoutBtn', 'loginPanel', 'patInput', 'patWarning', 'patCreateLink', 'loginPatBtn',
  'deviceFlowBtn', 'deviceBox', 'deviceCode', 'deviceCountdown', 'deviceOpenBtn', 'deviceStatus', 'rateLimit',
  'view-repos', 'view-repo', 'view-local', 'view-profile', 'view-settings', 'navRepos', 'navLocal', 'navProfile', 'navSettings', 'globalSearch',
  'repoCount', 'refreshRepos', 'refreshReposForce', 'repoSearch', 'repoFilter', 'repoSort',
  'autoUpdateToggle', 'autoUpdateInterval', 'autoUpdateState', 'manualRefresh', 'updateBadge', 'repoList',
  'backToRepos', 'detailName', 'detailDesc', 'detailBadges', 'detailStars', 'detailForks', 'detailIssues',
  'readmeName', 'readmeView', 'fileBranchSelect', 'fileUpBtn', 'filePathLabel', 'fileTree',
  'fileViewerWrap', 'fileViewerName', 'fileViewerMeta', 'fileViewer',
  'reloadCommits', 'commitList', 'reloadBranches', 'branchList', 'reloadIssues', 'issueList',
  'reloadPulls', 'pullList',
  // v3.0: login wizard + diagnostics
  'diagBtn', 'diagStatus', 'diagList', 'oauthConfigDetails',
  // v3.0.1: bridge-down notice + connection diagnostics + login gate
  'bridgeDownNotice', 'bridgeDownNoticeText', 'bridgeRetryBtn',
  'connDiagBtn', 'connDiagStatus', 'connDiagList', 'outsideExtensionNotice',
  'oauthConnectBtn', 'oauthSaveBtn', 'oauthClientId', 'oauthClientSecret',
  'oauthCallbackUrl', 'oauthConnectHint', 'oauthCopyCallbackBtn', 'userAuthMethod',
  // v3.0: notifications
  'notifBtn', 'notifBadge', 'notifPanel', 'notifList', 'notifMarkReadBtn', 'notifCloseBtn',
  // v3.0: create repo + repo actions
  'createRepoName', 'createRepoDesc', 'createRepoPrivate', 'createRepoBtn',
  'repoZipBtn', 'repoStarBtn', 'repoUnstarBtn', 'repoForkBtn', 'repoEditDescBtn', 'repoDeleteBtn',
  // v3.0: code search + file edit/create/delete/upload
  'codeSearchInput', 'codeSearchBtn', 'codeSearchResults',
  'fileEditWrap', 'fileEditArea', 'fileSaveBtn', 'fileDeleteBtn',
  'newFileName', 'newFileContent', 'newFileBtn', 'fileUploadInput',
  // v3.0: releases
  'reloadReleases', 'releaseList', 'releaseTag', 'releaseName', 'releaseBody',
  'releaseDraft', 'releasePrerelease', 'createReleaseBtn', 'tab-releases',
  // v3.0: issues detail + create
  'issueTitle', 'issueBody', 'issueLabels', 'createIssueBtn',
  'issueDetail', 'issueDetailTitle', 'issueDetailMeta', 'issueDetailBody',
  'issueComments', 'commentBody', 'addCommentBtn', 'issueCloseBtn', 'issueDetailBackBtn',
  // v3.0: pull requests create
  'prTitle', 'prHead', 'prBase', 'prBody', 'createPrBtn', 'prMergeMethod',
  // v3.0: profile + settings views
  'profileAvatar', 'profileName', 'profileLogin', 'profileEmail', 'profileBio',
  'profileCompany', 'profileBlog', 'profileLocation', 'profileStats', 'profileLink', 'reloadProfile',
  'settingsInterval', 'settingsDefaultBranch', 'settingsAutoSync', 'settingsNotifications',
  'saveSettingsBtn', 'settingsStatus',
  // v3.0: local git — cherry-pick / revert / reset, tags, local .zip
  'localZipBtn', 'cpSha', 'cherryPickBtn', 'revertBtn', 'resetMode', 'resetRef',
  'resetHardConfirm', 'resetBtn',
  'tagList', 'newTagName', 'newTagMessage', 'newTagRef', 'createTagBtn',
  'deleteTagName', 'deleteTagBtn', 'pushTagName', 'pushTagBtn', 'refreshTagsBtn',
];

function runScript(files, ids, store) {
  // v3.0.1: files may be an array — bridge-client.js must load BEFORE
  // dashboard.js / popup.js so its helpers are global when they run.
  const list = Array.isArray(files) ? files : [files];
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
  for (const file of list) {
    const code = fs.readFileSync(path.join(EXT, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
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
    const dash = runScript(['bridge-client.js', 'dashboard.js'], DASHBOARD_IDS, store);

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
    const bad = runScript(['bridge-client.js', 'dashboard.js'], DASHBOARD_IDS, { bridgeUrl: BASE, token: 'deadbeef'.repeat(6) });
    await sleep(1000);
    bad.document.getElementById('repoPath').value = repo;
    await bad.document.getElementById('connectRepo').onclick();
    await sleep(500);
    check('bad token surfaces an error in the log',
      bad.document.getElementById('log').textContent.includes('ERROR'),
      bad.document.getElementById('log').textContent);

    /* --- 5. popup.js --- */
    console.log('\n[popup.js]');
    const pop = runScript(['bridge-client.js', 'popup.js'], [
      'lamp', 'connection', 'bridgeDetail', 'repoName', 'branchName', 'repoPath', 'message',
      'version', 'token', 'refresh', 'saveToken', 'open', 'downloadZipBtn',
      'githubBox', 'githubSignedOut', 'githubSignedIn', 'ghAvatar', 'ghLogin', 'ghEmail',
      'ghAuthMethod', 'ghName', 'logout', 'aheadBehindBadge', 'autoUpdateToggle',
      'autoUpdateState', 'reconnect',
    ], { bridgeUrl: BASE, token: TOKEN });
    await sleep(1200);
    const p = pop.document;
    check('popup shows CONNECTED', p.getElementById('connection').textContent === 'CONNECTED',
      p.getElementById('connection').textContent);
    check('popup lamp ok', p.getElementById('lamp').className === 'lamp ok', p.getElementById('lamp').className);
    check('popup shows token accepted', p.getElementById('message').textContent === 'Token accepted',
      p.getElementById('message').textContent);
    check('popup version from manifest', p.getElementById('version').textContent === 'v3.1.1',
      p.getElementById('version').textContent);
    check('popup shows repo name', p.getElementById('repoName').textContent === repoName,
      p.getElementById('repoName').textContent);
    check('popup zip button enabled when a repo is connected (section 2 connected one)',
      p.getElementById('downloadZipBtn').disabled === false,
      'disabled=' + p.getElementById('downloadZipBtn').disabled);
    check('popup downloadLocalZip helper exists',
      vm.runInContext('typeof downloadLocalZip', pop.sandbox) === 'function');

    /* --- 6. dashboard v3.0 --- */
    console.log('\n[dashboard v3.0]');
    const dashEval = (expr) => vm.runInContext(expr, dash.sandbox);

    // 6a. looksLikeGithubToken: real tokens pass, email/password do not.
    check('looksLikeGithubToken accepts ghp_ classic token',
      dashEval(`looksLikeGithubToken('ghp_${'A'.repeat(36)}')`) === true);
    check('looksLikeGithubToken accepts github_pat_ fine-grained token',
      dashEval(`looksLikeGithubToken('github_pat_${'A'.repeat(40)}')`) === true);
    check('looksLikeGithubToken accepts gho_/ghu_/ghs_/ghr_ prefixes',
      dashEval(`looksLikeGithubToken('gho_${'A'.repeat(36)}')`) === true &&
      dashEval(`looksLikeGithubToken('ghu_${'A'.repeat(36)}')`) === true &&
      dashEval(`looksLikeGithubToken('ghs_${'A'.repeat(36)}')`) === true &&
      dashEval(`looksLikeGithubToken('ghr_${'A'.repeat(36)}')`) === true);
    check('looksLikeGithubToken rejects an email address',
      dashEval(`looksLikeGithubToken('nguyenvu16592b@gmail.com')`) === false);
    check('looksLikeGithubToken rejects a plain password',
      dashEval(`looksLikeGithubToken('MySecretPassword123')`) === false);
    check('looksLikeGithubToken rejects a too-short token',
      dashEval(`looksLikeGithubToken('ghp_abc')`) === false);
    check('looksLikeGithubToken rejects empty input',
      dashEval(`looksLikeGithubToken('')`) === false);

    // 6b. Pasting an email into the PAT box warns and never sends a request.
    d.getElementById('patInput').value = 'nguyenvu16592b@gmail.com';
    await dashEval('loginWithPat()').catch(() => {});
    check('email pasted as PAT shows the red format warning',
      d.getElementById('patWarning').textContent.includes('không phải token'),
      d.getElementById('patWarning').textContent.slice(0, 80));
    check('email pasted as PAT leaves the warning visible',
      !d.getElementById('patWarning').classList.contains('hidden'));

    // 6c. Login diagnostics renders instead of crashing. The v2.1 bridge
    // has no /login/diagnostics route, so this is a SOFT SKIP: the panel
    // must explain the gap (naming bridge v3.0) rather than fail.
    await dashEval('loadLoginDiagnostics()').catch(() => {});
    const diagText = d.getElementById('diagStatus').textContent;
    check('diagnostics panel renders a status line', diagText.length > 0, diagText);
    check('diagnostics 404 path names the bridge version gap',
      !diagText.includes('Không kiểm tra được') || diagText.includes('v3.0'), diagText);

    // 6d. v3.0 helpers + feature functions exist.
    for (const fn of [
      'downloadBlob', 'downloadRepoZip', 'downloadCurrentRepoZip', 'createRepo',
      'starRepo', 'unstarRepo', 'forkRepo', 'editRepoDescription', 'deleteRepo',
      'loadReleases', 'createRelease', 'searchCode', 'saveEditedFile',
      'createNewFile', 'deleteCurrentFile', 'uploadFileToRepo',
      'createIssue', 'showIssueDetail', 'addIssueComment', 'toggleIssueState',
      'createPullRequest', 'mergePullRequest', 'closePullRequest',
      'loadNotifications', 'markAllNotificationsRead', 'loadProfile',
      'applySettingsToUI', 'saveSettings',
      'cherryPickCommit', 'revertCommit', 'resetBranch',
      'loadTags', 'createTag', 'deleteTag', 'pushTag', 'exportLocalZip',
    ]) {
      check(`v3.0 function ${fn} exists`, dashEval(`typeof ${fn}`) === 'function');
    }

    // 6e. New views switch correctly.
    dashEval(`showView('profile')`);
    check('profile view shows, repos view hides',
      d.getElementById('view-profile').classList.contains('hidden') === false &&
      d.getElementById('view-repos').classList.contains('hidden') === true);
    dashEval(`showView('settings')`);
    check('settings view shows, profile view hides',
      d.getElementById('view-settings').classList.contains('hidden') === false &&
      d.getElementById('view-profile').classList.contains('hidden') === true);
    dashEval(`showView('repos')`);
    check('repos view restores after profile/settings',
      d.getElementById('view-repos').classList.contains('hidden') === false);

    // 6f. Settings save persists to storage (no bridge route needed).
    d.getElementById('settingsDefaultBranch').value = 'main';
    d.getElementById('settingsNotifications').checked = true;
    await dashEval('saveSettings()').catch(() => {});
    check('settings default branch persisted to storage', store.settingsDefaultBranch === 'main',
      'stored=' + store.settingsDefaultBranch);
    check('settings notifications persisted to storage', store.settingsNotifications === true);

    /* --- 7. dashboard + popup v3.0.1 (fix "Failed to fetch") --- */
    console.log('\n[dashboard + popup v3.0.1]');
    for (const fn of ['translateBridgeError', 'bridgeFetch', 'checkBridgeHealth', 'checkConnectionSteps', 'isExtensionContext']) {
      check(`bridge-client function ${fn} exists`, dashEval(`typeof ${fn}`) === 'function');
    }
    check('translateBridgeError: Failed to fetch -> BRIDGE_UNREACHABLE + Vietnamese',
      dashEval(`translateBridgeError(new TypeError('Failed to fetch'))`).code === 'BRIDGE_UNREACHABLE' &&
      /Bridge chưa chạy/.test(dashEval(`translateBridgeError(new TypeError('Failed to fetch'))`).message) &&
      !/Failed to fetch/.test(dashEval(`translateBridgeError(new TypeError('Failed to fetch'))`).message));
    check('login buttons enabled while the bridge is up',
      d.getElementById('oauthConnectBtn').disabled === false &&
      d.getElementById('deviceFlowBtn').disabled === false &&
      d.getElementById('loginPatBtn').disabled === false);
    check('bridge-down notice hidden while the bridge is up',
      d.getElementById('bridgeDownNotice').classList.contains('hidden') === true);
    check('outside-extension notice hidden inside the extension',
      d.getElementById('outsideExtensionNotice').classList.contains('hidden') === true);
    for (const fn of ['setLoginEnabled', 'ensureBridgeUp', 'runConnectionDiagnostics']) {
      check(`v3.0.1 function ${fn} exists`, dashEval(`typeof ${fn}`) === 'function');
    }
    let deadErr = null;
    try {
      await dashEval(`fetchJson('http://127.0.0.1:17499/health')`);
    } catch (e) { deadErr = e; }
    check('dashboard fetchJson(dead port) throws translated BRIDGE_UNREACHABLE',
      !!deadErr && deadErr.code === 'BRIDGE_UNREACHABLE' && /Bridge chưa chạy/.test(deadErr.message) &&
      !/Failed to fetch/.test(deadErr.message),
      deadErr ? deadErr.code + ' / ' + String(deadErr.message).slice(0, 80) : 'no error');
    const connSteps = await dashEval('runConnectionDiagnostics()');
    check('runConnectionDiagnostics(live bridge): 5 steps, none failed',
      Array.isArray(connSteps) && connSteps.length === 5 && connSteps.every((s) => s.ok === true),
      JSON.stringify(connSteps).slice(0, 200));
    check('runConnectionDiagnostics panel status says all steps passed',
      /đều đạt/.test(d.getElementById('connDiagStatus').textContent),
      d.getElementById('connDiagStatus').textContent);
    check('popup showError helper exists',
      vm.runInContext('typeof showError', pop.sandbox) === 'function');
    let popDeadErr = null;
    try {
      await vm.runInContext(`fetchJson('http://127.0.0.1:17499/health')`, pop.sandbox);
    } catch (e) { popDeadErr = e; }
    check('popup fetchJson(dead port) throws translated BRIDGE_UNREACHABLE',
      !!popDeadErr && popDeadErr.code === 'BRIDGE_UNREACHABLE' && !/Failed to fetch/.test(popDeadErr.message),
      popDeadErr ? popDeadErr.code : 'no error');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }

  console.log('\n=== ' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') + ' ===\n');
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(1);
});
