'use strict';

/*
 * PixiJS GitHub Desktop Sync — popup v3.5.0
 *
 * Shows, at a glance: bridge connection state (with reconnect), the
 * signed-in GitHub account (with its sign-in method and email), the
 * connected local repository with its ahead/behind badge, quick Git
 * actions (status / fetch / pull / push / sync), local .zip export,
 * and the auto-update switch.
 * The popup re-checks the bridge on open, on demand (reconnect button)
 * and every 10 s while it stays open, so it recovers on its own when
 * the bridge comes back.
 *
 * Shows, at a glance: bridge connection state (with reconnect), the
 * signed-in GitHub account (with its sign-in method), the connected
 * local repository with its ahead/behind badge, quick Git actions
 * (status / fetch / pull / push / sync) and the auto-update switch.
 * The popup re-checks the bridge on open, on demand (reconnect button)
 * and every 10 s while it stays open, so it recovers on its own when
 * the bridge comes back.
 *
 * Security note: the GitHub Personal Access Token is NEVER stored in
 * the extension. It lives in bridge/.github-config.json on the user's
 * machine; the popup only ever sees the public profile (login, name,
 * avatar, sign-in method) through /api/github/user.
 */

const $ = (id) => document.getElementById(id);
const DEFAULTS = { bridgeUrl: 'http://127.0.0.1:17321', token: '', autoUpdateEnabled: false, autoUpdateInterval: 60, settingsDefaultBranch: '', settingsNotifications: true };

let bridgeState = 'checking'; // 'connected' | 'reconnecting' | 'disconnected'
let pollTimer = null;
let keepMessageUntil = 0; // v3.1.1: hold Fetch/Pull/Push results on screen for a while

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '') || DEFAULTS.bridgeUrl;
}

// Same root-vs-extension/ logic as background.js: popup.html lives
// beside dashboard.html, so the dashboard path follows the folder
// popup.html itself was loaded from. Falls back to dashboard.html
// when the page URL is unavailable (e.g. in the Node test harness).
function dashboardUrl() {
  try {
    const href = (typeof location !== 'undefined' && location.href) || '';
    const path = href.split('?')[0].split('#')[0];
    const dir = path.replace(/[^/]*$/, '').replace(/^(?:[a-z-]+:\/\/[^/]+\/)?/, '');
    return chrome.runtime.getURL(dir + 'dashboard.html');
  } catch (_) {
    return chrome.runtime.getURL('dashboard.html');
  }
}

async function settings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return {
    bridgeUrl: normalizeBase(s.bridgeUrl),
    token: String(s.token || '').trim(),
    autoUpdateEnabled: !!s.autoUpdateEnabled,
    autoUpdateInterval: Number(s.autoUpdateInterval) || 60,
    settingsDefaultBranch: String(s.settingsDefaultBranch || '').trim(),
    settingsNotifications: s.settingsNotifications !== false,
  };
}

async function fetchJson(url, options) {
  // v3.0.1: bridgeFetch (extension/bridge-client.js) translates every
  // network failure into a Vietnamese BRIDGE_UNREACHABLE error — the
  // raw browser "Failed to fetch" never reaches the user.
  const res = await bridgeFetch(url, options);
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

// v3.0.1: never show the browser's raw error text ("Failed to fetch")
// in the popup — show the translated Vietnamese message, with the
// detailed start guide on the detail line.
function showError(err) {
  const t = translateBridgeError(err);
  $('message').textContent = t.short;
  $('bridgeDetail').textContent = t.detail || '';
}

async function api(path, method = 'GET', body) {
  const s = await settings();
  if (!s.token) throw new Error('No bridge token saved');
  return fetchJson(s.bridgeUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function setLamp(state) {
  $('lamp').className = 'lamp ' + state;
}

function setBridgeState(state, detail) {
  bridgeState = state;
  if (state === 'connected') {
    setLamp('ok');
    $('connection').textContent = 'CONNECTED';
  } else if (state === 'reconnecting') {
    setLamp('warn');
    $('connection').textContent = 'RECONNECTING…';
  } else {
    setLamp('off');
    $('connection').textContent = 'DISCONNECTED';
  }
  if (detail !== undefined) $('bridgeDetail').textContent = detail;
}

function authMethodLabel(method) {
  if (method === 'oauth-web') return 'OAuth Web';
  if (method === 'pat') return 'PAT';
  if (method === 'device') return 'Device Flow';
  return method ? String(method) : '';
}

function showGithub(user) {
  if (user && user.login) {
    $('githubSignedOut').classList.add('hidden');
    $('githubSignedIn').classList.remove('hidden');
    $('ghAvatar').src = user.avatar_url || '';
    $('ghAvatar').alt = user.login;
    $('ghLogin').textContent = user.login;
    // v3.0: show the account email when the bridge reports it.
    $('ghEmail').textContent = user.email || '';
    const method = authMethodLabel(user.authMethod);
    $('ghAuthMethod').textContent =
      (method ? 'via ' + method : '') + (user.scopes ? ' · ' + user.scopes : '');
    $('ghName').textContent = user.name || (user.public_repos != null ? user.public_repos + ' public repos' : 'GitHub');
  } else {
    $('githubSignedOut').classList.remove('hidden');
    $('githubSignedIn').classList.add('hidden');
    $('ghAvatar').src = '';
    $('ghLogin').textContent = '—';
    $('ghEmail').textContent = '';
    $('ghAuthMethod').textContent = '';
    $('ghName').textContent = '—';
  }
}

// v2.1 ahead/behind badge for the local repo. Silent when there is no
// repo or no upstream — the popup must never fail its refresh over it.
async function showAheadBehind() {
  const badge = $('aheadBehindBadge');
  try {
    const data = await api('/api/git/ahead-behind');
    if (!data.hasUpstream) {
      badge.textContent = 'No upstream';
      badge.classList.remove('hidden');
    } else {
      badge.textContent = `↑${Number(data.ahead) || 0} ↓${Number(data.behind) || 0}`;
      badge.title = `ahead ${Number(data.ahead) || 0}, behind ${Number(data.behind) || 0}${data.upstream ? ' ' + data.upstream : ''}`;
      badge.classList.remove('hidden');
    }
  } catch (_) {
    badge.textContent = '';
    badge.classList.add('hidden');
  }
}

function showAutoUpdate(status) {
  const box = $('autoUpdateState');
  if (!status) { box.textContent = '—'; return; }
  if (!status.enabled) { box.textContent = 'Off'; return; }
  const last = status.lastRunAt ? new Date(status.lastRunAt).toLocaleTimeString() : 'never';
  box.textContent = `On · every ${status.intervalSeconds}s · last check ${last}` +
    (status.updatesFound ? ` · ${status.updatesFound} update(s) found` : '');
}

// v3.0 — download the connected local repository as a .zip through the
// bridge (POST /api/git/archive-zip, bridge v3.0). Disabled state is
// handled by the caller; here a missing repo is a clear message.
async function downloadLocalZip() {
  const s = await settings();
  if (!s.token) throw new Error('No bridge token saved');
  const branch = $('branchName').textContent.trim();
  const repoName = $('repoName').textContent.trim();
  if (!repoName || repoName === 'No repository selected') throw new Error('Chưa chọn repo');
  const ref = branch && branch !== '—' ? branch : undefined;
  const filename = `${repoName}-${ref || 'HEAD'}.zip`;
  $('message').textContent = 'Downloading ' + filename + '…';
  $('downloadZipBtn').disabled = true;
  try {
    const res = await bridgeFetch(s.bridgeUrl + '/api/git/archive-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.token },
      body: JSON.stringify({ ref }),
    });
    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      try {
        const data = await res.json();
        if (data && data.error) detail = data.error;
      } catch (_) {}
      throw new Error(detail);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      if (typeof a.click === 'function') a.click();
    } finally {
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
    }
    $('message').textContent = 'Downloaded ' + filename;
  } finally {
    $('downloadZipBtn').disabled = false;
  }
}

async function refresh() {
  const s = await settings();
  $('token').value = s.token;
  $('autoUpdateToggle').checked = s.autoUpdateEnabled;

  try {
    const health = await fetchJson(s.bridgeUrl + '/health');
    setBridgeState('connected', 'Bridge v' + (health.version || '?'));

    const repo = health.repository;
    $('repoName').textContent = repo ? repo.name : 'No repository selected';
    $('branchName').textContent = repo && repo.branch ? repo.branch : '—';
    $('repoPath').textContent = repo ? repo.path : 'Open Workspace to select a repository';
    $('downloadZipBtn').disabled = !repo;

    // /health is public, so the token has to be verified separately.
    if (!s.token) {
      setLamp('warn');
      $('message').textContent = 'Add bridge token';
      showGithub(null);
      return;
    }
    try {
      await api('/api/repo/current');
      // v3.1.1: do not wipe the result of a Fetch/Pull/Push click.
      if (Date.now() > keepMessageUntil) $('message').textContent = 'Token accepted';
    } catch (err) {
      setLamp('warn');
      $('message').textContent = 'Token rejected — paste the current bridge token';
      showGithub(null);
      return;
    }

    // GitHub sign-in state + auto-update state (both read-only here).
    // v2.1: /user reports the sign-in method + scopes; fall back to /me
    // when talking to an older bridge.
    try {
      let me;
      try {
        me = await api('/api/github/user');
      } catch (_) {
        me = await api('/api/github/me');
      }
      if (me.authed && me.user) {
        if (!me.user.authMethod && me.authMethod) me.user.authMethod = me.authMethod;
        if (!me.user.scopes && me.scopes) me.user.scopes = me.scopes;
      }
      showGithub(me.authed ? me.user : null);
    } catch (_) {
      showGithub(null);
    }
    try {
      const au = await api('/api/github/auto-update');
      showAutoUpdate(au);
    } catch (_) {
      showAutoUpdate(null);
    }
    await showAheadBehind();
  } catch (_) {
    // v3.0.1: Vietnamese guidance instead of the raw "Failed to fetch".
    setBridgeState('disconnected', BRIDGE_START_GUIDE);
    $('message').textContent = BRIDGE_START_SHORT;
    $('repoName').textContent = 'No repository selected';
    $('branchName').textContent = '—';
    $('repoPath').textContent = 'Open Workspace to select a repository';
    $('downloadZipBtn').disabled = true;
    showGithub(null);
  }
}

async function reconnect() {
  setBridgeState('reconnecting', 'Trying ' + (await settings()).bridgeUrl + ' …');
  $('message').textContent = 'Reconnecting…';
  await refresh();
}

$('reconnect').onclick = reconnect;
$('refresh') && ($('refresh').onclick = refresh);

$('saveToken').onclick = async () => {
  const token = $('token').value.trim();
  await chrome.storage.local.set({ token });
  await refresh();
};

$('logout').onclick = async () => {
  try {
    await api('/api/github/logout', 'POST', {});
    showGithub(null);
    $('message').textContent = 'Signed out of GitHub';
  } catch (err) {
    showError(err);
  }
};

$('autoUpdateToggle').onchange = async () => {
  const enabled = $('autoUpdateToggle').checked;
  try {
    const s = await settings();
    await chrome.storage.local.set({ autoUpdateEnabled: enabled });
    const status = await api('/api/github/auto-update', 'POST', { enabled, intervalSeconds: s.autoUpdateInterval });
    showAutoUpdate(status);
    $('message').textContent = enabled ? 'Auto-update ON' : 'Auto-update OFF';
  } catch (err) {
    $('autoUpdateToggle').checked = !enabled;
    showError(err);
  }
};

$('open').onclick = () => {
  chrome.tabs.create({ url: dashboardUrl() });
  window.close();
};

$('downloadZipBtn').onclick = async () => {
  try {
    await downloadLocalZip();
  } catch (err) {
    showError(err);
  }
};


document.querySelectorAll('[data-action]').forEach((button) => {
  button.onclick = async () => {
    const action = button.dataset.action;
    const method = action === 'status' ? 'GET' : 'POST';
    try {
      // v3.1.1: same defaults as the dashboard toolbar — pull/sync use
      // autostash; push publishes a branch that has no upstream yet.
      let body;
      if (method === 'POST') {
        body = {};
        if (action === 'pull' || action === 'sync') body.autostash = true;
        if (action === 'push') {
          const ab = await api('/api/git/ahead-behind').catch(() => null);
          if (ab && ab.hasUpstream === false) body.setUpstream = true;
        }
      }
      button.disabled = true;
      $('message').textContent = button.textContent + '…';
      let data;
      try {
        data = await api('/api/git/' + action, method, body);
      } finally {
        button.disabled = false;
      }
      if (action === 'status') {
        const count = (data.files || []).length;
        $('message').textContent = count + ' changed file(s)';
      } else if (data && data.conflict) {
        $('message').textContent = 'Có conflict — mở OPEN FULL WORKSPACE → Local Git để xử lý.';
      } else if (action === 'pull') {
        $('message').textContent = data.commitsPulled ? `Pull ✓ — nhận ${data.commitsPulled} commit` : 'Pull ✓ — đã mới nhất';
      } else if (action === 'fetch') {
        $('message').textContent = `Fetch ✓ — ↓${Number(data.behind) || 0} ↑${Number(data.ahead) || 0}`;
      } else {
        $('message').textContent = button.textContent + ' ✓';
      }
      keepMessageUntil = Date.now() + 20000;
      await refresh();
    } catch (err) {
      showError(err);
    }
  };
});

$('version').textContent = 'v' + chrome.runtime.getManifest().version;
refresh();
pollTimer = setInterval(() => { refresh(); }, 10000);
