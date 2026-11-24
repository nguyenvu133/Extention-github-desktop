'use strict';

/*
 * PixiJS GitHub Desktop Sync — dashboard v3.6.0
 *
 * A GitHub-like workspace in the browser:
 *   - Repositories tab: ALL GitHub repositories (search / filter / sort),
 *     repo detail (README, file tree + viewer/editor, commits, branches,
 *     issues, pull requests, releases), code search, notifications,
 *     profile, create/fork/star/delete repos, download .zip.
 *   - Local Git tab: the v1 local-git client (status, stage, commit,
 *     branches, history, diff, fetch/pull/push) plus v2.1 push/pull/sync
 *     with ahead/behind, branch management, merge-conflict resolution,
 *     stash, remotes and clone — and v3.0 cherry-pick / revert / reset,
 *     tags, and local .zip export.
 *   - Sign-in: a 3-step Vietnamese wizard — OAuth Web Flow (Connect
 *     GitHub) first, Device Flow, then PAT. NO password field anywhere:
 *     GitHub stopped accepting passwords for third-party apps in 2020,
 *     so the extension never asks for one. A login-diagnostics panel
 *     (GET /api/github/login/diagnostics) pinpoints the failing step
 *     instead of a generic error.
 *
 * CONNECTION MODEL (this is what v1 got wrong — "Bridge disconnected"
 * used to stick forever):
 *   - health() polls GET /health every 10 s;
 *   - an EventSource stream (GET /api/events) pushes live updates;
 *   - on ANY failure the state machine goes to "reconnecting" and
 *     retries with backoff (1s, 2s, 5s, 10s, 30s cap) until the bridge
 *     answers again — the user never has to click anything.
 * States: 'connected' (green) / 'reconnecting' (yellow) / 'disconnected' (red).
 *
 * SECURITY: the GitHub PAT lives in bridge/.github-config.json. The
 * dashboard only ever sees the public profile through /api/github/me.
 */

const $ = (id) => document.getElementById(id);
const DEFAULTS = { bridgeUrl: 'http://127.0.0.1:17321', token: '', autoUpdateEnabled: false, autoUpdateInterval: 60, lastRepo: '', settingsDefaultBranch: '', settingsNotifications: true, autoStartBridge: false };

let bridgeState = 'disconnected'; // 'connected' | 'reconnecting' | 'disconnected'
let healthTimer = null;
let sseSource = null;
let sseBackoffMs = 1000;
let sseBackoffTimer = null;
let healthFailures = 0;

let ghUser = null; // public profile from /api/github/user, or null
let allRepos = []; // full repo list from /api/github/repos/all
let reposLoadedAt = null;
let currentRepo = null; // { owner, repo, full_name, default_branch }
let currentPath = ''; // path inside the file tree
let selectedFile = '';
let selectedFileSha = ''; // blob sha of the file open in the viewer (for edits)
let localConnected = false;
let updateBadgeCount = 0;
let historyPage = 1; // v2.1 paginated local history
let historyHasNext = false;
let oauthConfigured = false; // v2.1 OAuth Web Flow ready?
let oauthPollTimer = null;
let deviceCountdownTimer = null; // v3.0 Device Flow countdown
let deviceDeadline = 0;
let currentIssueNumber = null; // issue open in the detail pane
let notifUnreadCount = 0; // v3.0 notification badge
let settingsDefaultBranch = ''; // v3.0 from storage
let settingsNotifications = true; // v3.0 from storage

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '') || DEFAULTS.bridgeUrl;
}

async function cfg() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return {
    bridgeUrl: normalizeBase(s.bridgeUrl),
    token: String(s.token || '').trim(),
    autoUpdateEnabled: !!s.autoUpdateEnabled,
    autoUpdateInterval: Number(s.autoUpdateInterval) || 60,
    lastRepo: String(s.lastRepo || ''),
    settingsDefaultBranch: String(s.settingsDefaultBranch || '').trim(),
    settingsNotifications: s.settingsNotifications !== false,
    autoStartBridge: !!s.autoStartBridge,
  };
}

function log(message) {
  const time = new Date().toLocaleTimeString();
  $('log').textContent = time + ' · ' + message;
}

function esc(s) {
  return String(s == null ? '' : s);
}

function timeAgo(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  if (sec < 86400 * 30) return Math.floor(sec / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString();
}

function formatNumber(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(v);
}

// v3.0 — client-side PAT shape check, BEFORE anything is sent to the
// bridge. GitHub tokens always start with one of these prefixes and are
// at least 20 characters long. An email (contains @) or a plain password
// never matches, so pasting one shows a clear warning instead of a
// generic "invalid token" error from the API.
function looksLikeGithubToken(value) {
  const v = String(value || '').trim();
  if (v.length < 20) return false;
  return /^(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+$/.test(v);
}

const TOKEN_FORMAT_HINT = 'Đây không phải token — token bắt đầu bằng ghp_… (classic) hoặc github_pat_… (fine-grained). GitHub không cho app khác nhập mật khẩu — mật khẩu chỉ nhập trên trang github.com.';

/* ------------------------------------------------------------------ */
/* Bridge API                                                          */
/* ------------------------------------------------------------------ */

async function fetchJson(url, options) {
  // v3.0.1: bridgeFetch (extension/bridge-client.js) translates every
  // network failure into a Vietnamese BRIDGE_UNREACHABLE error — the
  // raw browser "Failed to fetch" never reaches the user.
  const res = await bridgeFetch(url, options);
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error(data.error || 'HTTP ' + res.status);
    err.data = data; // v3.1.0: reason / hint / refs for push & pull failures
    err.status = res.status;
    throw err;
  }
  return data;
}

async function api(path, method = 'GET', body) {
  const c = await cfg();
  if (!c.token) throw new Error('Missing bridge token. Start the bridge and paste its token.');
  return fetchJson(c.bridgeUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// GitHub calls all go through the bridge (the PAT never leaves it).
async function gh(path, method = 'GET', body) {
  return api('/api/github' + path, method, body);
}

// v3.0 — download a binary response (repo .zip, release asset, local
// archive) through the bridge with the bearer token, then trigger a
// browser download. Throws a readable error when the bridge answers
// with JSON instead of a file (e.g. 404 on an older bridge).
async function downloadBlob(path, method = 'GET', body, filename) {
  const c = await cfg();
  if (!c.token) throw new Error('Missing bridge token. Start the bridge and paste its token.');
  const res = await bridgeFetch(c.bridgeUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = 'HTTP ' + res.status;
    try {
      const data = await res.json();
      if (data && data.error) detail = data.error;
    } catch (_) { /* non-JSON error body — keep the status */ }
    throw new Error(detail);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download.zip';
    if (typeof a.click === 'function') a.click();
  } finally {
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
  }
  return { filename: filename || 'download.zip', size: blob.size };
}

/* ------------------------------------------------------------------ */
/* Connection state machine: health poll + SSE, auto-reconnect         */
/* ------------------------------------------------------------------ */

function setBridgeState(state, detail) {
  bridgeState = state;
  const lamp = $('lamp');
  lamp.className = state === 'connected' ? 'ok' : state === 'reconnecting' ? 'reconnecting' : 'off';
  $('bridgeStatus').textContent =
    state === 'connected' ? 'BRIDGE CONNECTED' :
    state === 'reconnecting' ? 'RECONNECTING…' : 'BRIDGE DISCONNECTED';
  if (detail !== undefined) log(detail);
}

async function health() {
  const c = await cfg();
  try {
    const res = await bridgeFetch(c.bridgeUrl + '/health', undefined, 8000);
    if (!res.ok) throw new Error('offline');
    const data = await res.json();
    healthFailures = 0;

    const wasDown = bridgeState !== 'connected';
    setBridgeState('connected');
    setLoginEnabled(true);
    updateRateLimit(data.github && data.github.rateLimit);

    const repo = data.repository;
    if (repo) {
      $('repoName').textContent = repo.name;
      $('branch').textContent = repo.branch || '—';
      $('remote').textContent = repo.remote || 'No remote';
      if (!$('repoPath').value.trim()) $('repoPath').value = repo.path;
      localConnected = true;
    } else {
      $('repoName').textContent = 'Not connected';
      $('branch').textContent = '—';
      $('remote').textContent = '—';
      localConnected = false;
    }
    if (data.github) {
      if (data.github.authed) {
        ghUser = ghUser || { login: data.github.login, avatar_url: data.github.avatar_url };
        showUser(ghUser);
      }
    }
    if (data.autoUpdate) showAutoUpdate(data.autoUpdate);
    dbOnHealth(data);
    if (wasDown) {
      log('Bridge is back. Reconnected.');
      startEventStream();
      await refreshGithubState().catch((err) => log('ERROR: ' + err.message));
    }
    return true;
  } catch (err) {
    healthFailures += 1;
    // First failure while connected -> reconnecting (retries keep running).
    // Failure at boot -> disconnected (nothing ever worked yet).
    // v3.0.1: login buttons are disabled while the bridge is down, so
    // the user cannot click sign-in into a raw "Failed to fetch".
    setLoginEnabled(false);
    if (bridgeState === 'connected' || healthFailures > 1) {
      setBridgeState('reconnecting', `Bridge không kết nối được (lần thử ${healthFailures}). Đang thử lại…`);
    } else {
      setBridgeState('disconnected', BRIDGE_START_SHORT);
    }
    localConnected = false;
    dbOnOffline();
    stopEventStream();
    return false;
  }
}

function startHealthPoll() {
  if (healthTimer) return;
  healthTimer = setInterval(() => { health(); }, 10000);
}

function startEventStream() {
  if (typeof EventSource === 'undefined') return; // Node test harness without EventSource
  cfg().then((c) => {
    if (!c.token) return;
    if (sseSource) return;
    const url = c.bridgeUrl + '/api/events?token=' + encodeURIComponent(c.token);
    let source;
    try {
      source = new EventSource(url);
    } catch (err) {
      scheduleSseReconnect();
      return;
    }
    sseSource = source;
    source.onopen = () => {
      sseBackoffMs = 1000;
      log('Live updates connected (SSE).');
    };
    source.addEventListener('auto-update', (ev) => {
      let payload = {};
      try { payload = JSON.parse(ev.data); } catch (_) {}
      if (payload.updated && payload.updated.length) {
        updateBadgeCount += payload.updated.length;
        showUpdateBadge();
        log(`Auto-update: ${payload.updated.length} repo(s) have new commits — ${payload.updated.map((u) => u.repo + '@' + u.newSha).join(', ')}`);
        if (!$('view-repos').classList.contains('hidden')) loadRepos(false).catch(() => {});
      }
      if (payload.at) showAutoUpdate({ lastRunAt: payload.at });
    });
    source.addEventListener('repo-updated', (ev) => {
      let payload = {};
      try { payload = JSON.parse(ev.data); } catch (_) {}
      updateBadgeCount += 1;
      showUpdateBadge();
      log(`New commit in ${payload.repo || '?'} (${payload.newSha || ''})`);
    });
    source.addEventListener('github-auth', (ev) => {
      let payload = {};
      try { payload = JSON.parse(ev.data); } catch (_) {}
      if (payload.authed === false) {
        ghUser = null;
        showUser(null);
      } else if (payload.authed === true) {
        // OAuth Web Flow (or another sign-in) completed on the bridge.
        stopOAuthPolling();
        refreshGithubState().catch((err) => log('ERROR: ' + err.message));
      }
    });
    source.addEventListener('auto-sync', (ev) => {
      let payload = {};
      try { payload = JSON.parse(ev.data); } catch (_) {}
      if (payload.skipped) {
        log(`Auto-sync skipped for ${payload.repo || '?'}: ${payload.reason || 'no reason given'}`);
      } else {
        log(`Auto-sync pulled ${payload.commitsPulled || 0} commit(s) into ${payload.repo || '?'}@${payload.branch || ''}` +
          (payload.changedFiles && payload.changedFiles.length ? ` — ${payload.changedFiles.join(', ')}` : ''));
        if (localConnected) refreshAllLocal().catch(() => {});
      }
      if (payload.at) showAutoUpdate({ lastAutoSync: payload });
    });
    source.addEventListener('git-progress', (ev) => {
      let payload = {};
      try { payload = JSON.parse(ev.data); } catch (_) {}
      showGitProgress(payload);
    });
    source.addEventListener('git-history', () => {
      if (localConnected) loadSyncHistory().catch(() => {});
    });
    source.addEventListener('rate-limit', (ev) => {
      let payload = {};
      try { payload = JSON.parse(ev.data); } catch (_) {}
      updateRateLimit(payload);
      log(`GitHub rate limit low: ${payload.remaining} requests remaining.`);
    });
    source.onerror = () => {
      stopEventStream();
      if (bridgeState === 'connected') setBridgeState('reconnecting', 'Live updates dropped. Reconnecting…');
      scheduleSseReconnect();
    };
  }).catch(() => {});
}

function scheduleSseReconnect() {
  if (sseBackoffTimer) return;
  const delay = sseBackoffMs;
  sseBackoffMs = Math.min(30000, sseBackoffMs * 2);
  sseBackoffTimer = setTimeout(() => {
    sseBackoffTimer = null;
    if (bridgeState !== 'disconnected') startEventStream();
  }, delay);
}

function stopEventStream() {
  if (sseBackoffTimer) { clearTimeout(sseBackoffTimer); sseBackoffTimer = null; }
  if (sseSource) { try { sseSource.close(); } catch (_) {} sseSource = null; }
}

async function reconnectNow() {
  healthFailures = 0;
  sseBackoffMs = 1000;
  setBridgeState('reconnecting', 'Reconnecting to the bridge…');
  const ok = await health();
  if (ok) {
    startEventStream();
    await refreshGithubState().catch((err) => log('ERROR: ' + err.message));
  }
}

// v3.6.0 — one-click bridge start via the Native Messaging host
// (extension/native-bridge.js). Same storage as the manual flow: the
// host's token + bridgeUrl are saved to chrome.storage.local (token /
// bridgeUrl) and api() picks them up unchanged. The token is never
// logged. Host not installed -> Vietnamese install guide in the panel;
// every manual flow (paste token, CONNECT BRIDGE, GitHub sign-in)
// keeps working untouched.
let nativeStartInFlight = false;
let autoStartAttempted = false;

async function startBridgeOnce() {
  if (bridgeState === 'connected') {
    $('startBridgeStatus').textContent = 'Bridge đã chạy (BRIDGE CONNECTED).';
    return true;
  }
  if (nativeStartInFlight) return false;
  nativeStartInFlight = true;
  const btn = $('startBridgeBtn');
  if (btn) btn.disabled = true;
  $('startBridgeStatus').textContent = 'Đang mở bridge…';
  try {
    const res = await startBridgeViaNative();
    const c = await cfg();
    await chrome.storage.local.set({ token: res.token, bridgeUrl: res.bridgeUrl || c.bridgeUrl });
    $('token').value = res.token;
    $('bridgeUrl').value = res.bridgeUrl || c.bridgeUrl;
    $('startBridgeStatus').textContent = 'Bridge đã mở — đang kiểm tra kết nối…';
    stopEventStream();
    const ok = await health();
    if (!ok) {
      $('startBridgeStatus').textContent = 'Bridge đã mở nhưng chưa kết nối được — kiểm tra lại Bridge URL rồi bấm CONNECT BRIDGE.';
      return false;
    }
    startEventStream();
    await refreshGithubState().catch((err) => log('ERROR: ' + err.message));
    if (localConnected) await refreshAllLocal().catch((err) => log('ERROR: ' + err.message));
    $('startBridgeStatus').textContent = 'CONNECTED — bridge đã chạy.';
    return true;
  } catch (err) {
    if (err && err.code === NATIVE_HOST_NOT_INSTALLED_CODE) {
      $('startBridgeStatus').textContent = err.short + '\n' + (err.detail || '');
    } else {
      $('startBridgeStatus').textContent = (err && err.short) || String((err && err.message) || err);
    }
    throw err;
  } finally {
    nativeStartInFlight = false;
    if (btn) btn.disabled = false;
  }
}

// v3.6.0 — auto-start, called at most ONCE per dashboard open, only
// when the user enabled it. Never loops, never spams: a failure just
// leaves the manual flow (and the button) in place.
async function tryAutoStartBridge() {
  if (autoStartAttempted) return false;
  autoStartAttempted = true;
  try {
    return await startBridgeOnce();
  } catch (err) {
    log('Auto-start bridge: ' + ((err && err.short) || (err && err.message) || err));
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* v3.0.1 — login gate + connection diagnostics (fix "Failed to fetch") */
/* ------------------------------------------------------------------ */

// v3.0.1: while the bridge is down, every sign-in button is disabled
// and the login panel shows the 3-step start guide instead of letting
// the user click sign-in into a raw "Failed to fetch".
const LOGIN_BUTTON_IDS = ['oauthConnectBtn', 'deviceFlowBtn', 'loginPatBtn', 'oauthSaveBtn', 'diagBtn', 'connDiagBtn'];

function setLoginEnabled(enabled) {
  for (const id of LOGIN_BUTTON_IDS) {
    const el = $(id);
    if (el) el.disabled = !enabled;
  }
  const notice = $('bridgeDownNotice');
  if (notice) {
    notice.classList.toggle('hidden', enabled);
    if (!enabled) $('bridgeDownNoticeText').textContent = BRIDGE_START_GUIDE;
  }
}

// Throws the translated BRIDGE_UNREACHABLE error when the bridge does
// not answer /health. Every sign-in entry point calls this first.
async function ensureBridgeUp() {
  const c = await cfg();
  await checkBridgeHealth(c.bridgeUrl);
  return true;
}

// v3.0.1 — one-click connection check: bridge reachable? right port?
// CORS preflight? /health ok? /oauth/status? Renders one row per step
// (same .diag-row style as the login diagnostics). Never throws.
async function runConnectionDiagnostics() {
  const list = $('connDiagList');
  const statusEl = $('connDiagStatus');
  list.innerHTML = '';
  statusEl.textContent = 'Đang kiểm tra…';
  const c = await cfg();
  let steps;
  try {
    steps = await checkConnectionSteps(c.bridgeUrl, c.token);
  } catch (err) {
    statusEl.textContent = 'Không kiểm tra được: ' + translateBridgeError(err, c.bridgeUrl).short;
    return null;
  }
  const failed = steps.filter((s) => !s.ok);
  statusEl.textContent = failed.length
    ? `${failed.length}/${steps.length} bước chưa đạt — xem cách sửa bên dưới.`
    : 'Tất cả các bước đều đạt ✓ — bridge đã sẵn sàng, thử đăng nhập lại.';
  for (const s of steps) {
    const row = document.createElement('div');
    row.className = 'diag-row' + (s.ok ? ' ok' : ' bad');
    const mark = document.createElement('b');
    mark.textContent = s.ok ? '✓' : '✗';
    const body = document.createElement('span');
    const label = document.createElement('b');
    label.textContent = s.label || s.key || 'check';
    body.append(label);
    if (s.detail) body.append(document.createTextNode(' — ' + s.detail));
    if (!s.ok && s.fix) {
      const fix = document.createElement('small');
      fix.textContent = 'Cách sửa: ' + s.fix;
      body.append(fix);
    }
    row.append(mark, body);
    list.append(row);
  }
  return steps;
}

/* ------------------------------------------------------------------ */
/* GitHub sign-in                                                      */
/* ------------------------------------------------------------------ */

function authMethodLabel(method) {
  if (method === 'oauth-web') return 'OAuth Web';
  if (method === 'pat') return 'PAT';
  if (method === 'device') return 'Device Flow';
  return method ? String(method) : '';
}

function showUser(user) {
  ghUser = user || null;
  if (user && user.login) {
    $('userChip').classList.remove('hidden');
    $('userAvatar').src = user.avatar_url || '';
    $('userAvatar').alt = user.login;
    $('userLogin').textContent = user.login;
    // v3.0: show the account email when the bridge reports it, so the
    // user can recognise their own account at a glance.
    const emailEl = $('userEmail');
    if (user.email) {
      emailEl.textContent = user.email;
      emailEl.classList.remove('hidden');
    } else {
      emailEl.textContent = '';
      emailEl.classList.add('hidden');
    }
    const method = authMethodLabel(user.authMethod);
    $('userAuthMethod').textContent =
      (method ? 'via ' + method : '') + (user.scopes ? ' · ' + user.scopes : '');
    $('loginPanel').classList.add('hidden');
  } else {
    $('userChip').classList.add('hidden');
    $('userAvatar').src = '';
    $('userLogin').textContent = '—';
    $('userEmail').textContent = '';
    $('userEmail').classList.add('hidden');
    $('userAuthMethod').textContent = '';
    $('loginPanel').classList.remove('hidden');
  }
}

function updateRateLimit(rl) {
  if (!rl) return;
  const el = $('rateLimit');
  if (rl.remaining == null && rl.limit == null) { el.textContent = '—'; return; }
  const reset = rl.reset ? new Date(typeof rl.reset === 'number' ? rl.reset * 1000 : rl.reset).toLocaleTimeString() : '—';
  el.textContent = `${rl.remaining ?? '?'}/${rl.limit ?? '?'} remaining (resets ${reset})`;
}

async function refreshGithubState() {
  try {
    // v2.1: /user reports the sign-in method + scopes; fall back to the
    // v2.0 /me endpoint when talking to an older bridge.
    let me;
    try {
      me = await gh('/user');
    } catch (_) {
      me = await gh('/me');
    }
    if (me.authed && me.user) {
      // /me does not return authMethod/scopes on the user object, but the
      // v2.1 /user response carries them at the top level too.
      if (!me.user.authMethod && me.authMethod) me.user.authMethod = me.authMethod;
      if (!me.user.scopes && me.scopes) me.user.scopes = me.scopes;
      showUser(me.user);
      updateRateLimit(me.rateLimit);
      await loadRepos(false);
      await loadAutoUpdateStatus();
    } else {
      showUser(null);
      setRepoListEmpty('Sign in to GitHub to list your repositories.');
    }
  } catch (err) {
    // v3.0.1: a dead bridge is now a translated BRIDGE_UNREACHABLE
    // error (Vietnamese) instead of the raw "Failed to fetch" — treat
    // it like "not connected" and show the empty state, not a crash.
    if (err.code === BRIDGE_UNREACHABLE_CODE || /not connected|Missing bridge token|Bridge chưa chạy/i.test(err.message)) {
      showUser(null);
      setRepoListEmpty('Bridge chưa chạy — chạy bridge trước rồi đăng nhập GitHub (xem hướng dẫn trong khung "Bridge chưa chạy" ở panel đăng nhập).');
    } else {
      throw err;
    }
  }
  await loadOAuthStatus();
}

let devicePollTimer = null;

async function loginWithPat() {
  // v3.0.1: check the bridge first — a dead bridge used to surface as
  // a raw "Failed to fetch" from this very call.
  await ensureBridgeUp();
  const token = $('patInput').value.trim();
  if (!token) throw new Error('Paste a Personal Access Token first');
  // v3.0: check the shape on the client before sending anything. Users
  // used to paste their GitHub email / password here — GitHub has not
  // accepted passwords for third-party apps since 2020, so that can
  // never work. Warn clearly and do NOT send the request.
  if (!looksLikeGithubToken(token)) {
    $('patWarning').textContent = TOKEN_FORMAT_HINT;
    $('patWarning').classList.remove('hidden');
    await loadLoginDiagnostics().catch(() => {});
    throw new Error('The pasted text is not a GitHub token — see the warning above the button.');
  }
  $('patWarning').classList.add('hidden');
  let res;
  try {
    res = await gh('/auth', 'POST', { token });
    if (res.dotenvSaved === false) throw new Error('Signed in, but bridge/.env could not be updated. Check file permissions/free space.');
  } catch (err) {
    if (/INVALID_TOKEN_FORMAT/.test(err.message)) {
      $('patWarning').textContent = TOKEN_FORMAT_HINT;
      $('patWarning').classList.remove('hidden');
    }
    await loadLoginDiagnostics().catch(() => {});
    throw err;
  }
  $('patInput').value = '';
  showUser(res.user);
  log(`Signed in to GitHub as ${res.user.login}`);
  await loadRepos(true);
  await loadAutoUpdateStatus();
}

/* ------------------------------------------------------------------ */
/* v3.0 — Login diagnostics: pinpoint the failing sign-in step         */
/* ------------------------------------------------------------------ */

// GET /api/github/login/diagnostics (bridge v3.0). Renders one line per
// check: ✓/✗ + detail + how to fix it. Never throws: on an older bridge
// (404) or when the bridge is down it says so in the panel instead of
// failing — the UI must not break just because the route is missing.
async function loadLoginDiagnostics() {
  const list = $('diagList');
  const statusEl = $('diagStatus');
  list.innerHTML = '';
  list.className = '';
  statusEl.textContent = 'Đang kiểm tra…';
  let data;
  try {
    data = await gh('/login/diagnostics');
  } catch (err) {
    statusEl.textContent = 'Không kiểm tra được: ' + err.message +
      ' — bridge này có thể là bản cũ (cần bridge v3.0 cho chẩn đoán chi tiết). Kiểm tra lại: bridge có đang chạy không, token bridge có đúng không, rồi thử lại cách đăng nhập.';
    return null;
  }
  const checks = (data && data.checks) || [];
  if (!checks.length) {
    statusEl.textContent = 'Bridge không trả về kết quả kiểm tra nào.';
    return data;
  }
  const failed = checks.filter((c) => !c.ok);
  statusEl.textContent = data.summary ||
    (failed.length ? `${failed.length}/${checks.length} bước chưa đạt — xem cách sửa bên dưới.` : 'Tất cả các bước đều đạt ✓ — thử đăng nhập lại.');
  for (const c of checks) {
    const row = document.createElement('div');
    row.className = 'diag-row' + (c.ok ? ' ok' : ' bad');
    const mark = document.createElement('b');
    mark.textContent = c.ok ? '✓' : '✗';
    const body = document.createElement('span');
    const label = document.createElement('b');
    label.textContent = c.label || c.key || 'check';
    body.append(label);
    if (c.detail) body.append(document.createTextNode(' — ' + c.detail));
    if (!c.ok && c.fix) {
      const fix = document.createElement('small');
      fix.textContent = 'Cách sửa: ' + c.fix;
      body.append(fix);
    }
    row.append(mark, body);
    list.append(row);
  }
  return data;
}

function stopDeviceCountdown() {
  if (deviceCountdownTimer) { clearInterval(deviceCountdownTimer); deviceCountdownTimer = null; }
}

function updateDeviceCountdown() {
  const left = Math.max(0, Math.floor((deviceDeadline - Date.now()) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  $('deviceCountdown').textContent = left > 0 ? `Mã còn hiệu lực: ${mm}:${ss}` : 'Mã đã hết hạn.';
}

async function startDeviceFlow() {
  // v3.0.1: check the bridge first (see loginWithPat).
  await ensureBridgeUp();
  let res;
  try {
    res = await gh('/auth/device/start', 'POST', {});
  } catch (err) {
    await loadLoginDiagnostics().catch(() => {});
    throw err;
  }
  $('deviceBox').classList.remove('hidden');
  $('deviceCode').textContent = res.user_code || '—';
  $('deviceStatus').textContent = 'Waiting for you to approve on GitHub…';
  // v3.0: show how long the code stays valid (countdown, 1s tick).
  stopDeviceCountdown();
  deviceDeadline = Date.now() + (Number(res.expires_in) || 900) * 1000;
  updateDeviceCountdown();
  deviceCountdownTimer = setInterval(updateDeviceCountdown, 1000);
  const verifyUrl = res.verification_uri_complete || res.verification_uri;
  $('deviceOpenBtn').onclick = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url: verifyUrl });
    else if (typeof window !== 'undefined' && window.open) window.open(verifyUrl, '_blank');
  };
  if (devicePollTimer) clearInterval(devicePollTimer);
  const interval = Math.max(5, Number(res.interval) || 5) * 1000;
  const deadline = deviceDeadline;
  devicePollTimer = setInterval(async () => {
    if (Date.now() > deadline) {
      clearInterval(devicePollTimer);
      devicePollTimer = null;
      stopDeviceCountdown();
      $('deviceStatus').textContent = 'The code expired. Click "Sign in with Device Flow" again.';
      return;
    }
    try {
      const poll = await gh('/auth/device/poll', 'POST', { device_code: res.device_code });
      if (poll.status === 'authorized') {
        clearInterval(devicePollTimer);
        devicePollTimer = null;
        stopDeviceCountdown();
        $('deviceBox').classList.add('hidden');
        showUser(poll.user);
        log(`Signed in to GitHub as ${poll.user.login} (Device Flow)`);
        await loadRepos(true);
        await loadAutoUpdateStatus();
      } else if (poll.status === 'slow_down') {
        $('deviceStatus').textContent = 'Slow down — GitHub asked us to poll less often. Still waiting…';
      }
    } catch (err) {
      clearInterval(devicePollTimer);
      devicePollTimer = null;
      stopDeviceCountdown();
      $('deviceStatus').textContent = 'Device Flow failed: ' + err.message;
      await loadLoginDiagnostics().catch(() => {});
    }
  }, interval);
}

async function logoutGithub() {
  await gh('/logout', 'POST', {});
  ghUser = null;
  allRepos = [];
  currentRepo = null;
  showUser(null);
  setRepoListEmpty('Signed out. Sign in to GitHub to list your repositories.');
  showView('repos');
  log('Signed out of GitHub.');
}

/* ------------------------------------------------------------------ */
/* OAuth Web Flow (v2.1, kept in v3.0): Connect GitHub — the recommended sign-in */
/* ------------------------------------------------------------------ */

// Reads /oauth/status and updates the setup form. Never throws: an
// older bridge (or a bridge that is down) simply leaves the form as-is.
async function loadOAuthStatus() {
  try {
    const st = await gh('/oauth/status');
    oauthConfigured = !!st.configured;
    $('oauthCallbackUrl').textContent = st.callbackUrl || '—';
    $('oauthConfigStatus').textContent = st.configured
      ? `OAuth App: configured ✓ (Client ID ${st.clientIdConfigured ? 'set' : 'missing'} · Client Secret ${st.clientSecretConfigured ? 'set' : 'missing'} — the secret is never shown again)`
      : 'OAuth App: not configured yet. Create an OAuth App (see above), save its Client ID + Client Secret, then click CONNECT GITHUB.';
    $('oauthConnectHint').textContent = st.configured
      ? 'Sign in with your real GitHub account in the browser (OAuth Web Flow — the recommended way).'
      : 'Connect GitHub needs an OAuth App first — open "OAUTH APP SETUP" below, or sign in with a token / Device Flow instead.';
  } catch (_) { /* older bridge or offline — PAT / Device Flow still work */ }
}

async function saveOAuthConfig() {
  // v3.0.1: check the bridge first (see loginWithPat).
  await ensureBridgeUp();
  const clientId = $('oauthClientId').value.trim();
  const clientSecret = $('oauthClientSecret').value.trim();
  if (!clientId) throw new Error('Paste the Client ID from your GitHub OAuth App first');
  if (!clientSecret) throw new Error('Paste the Client Secret from your GitHub OAuth App first');
  const res = await gh('/oauth/config', 'POST', { clientId, clientSecret });
  $('oauthClientSecret').value = '';
  if (res.dotenvSaved === false) throw new Error('OAuth App is saved locally, but bridge/.env could not be updated. Check file permissions/free space.');
  oauthConfigured = !!res.configured;
  $('oauthCallbackUrl').textContent = res.callbackUrl || $('oauthCallbackUrl').textContent;
  await loadOAuthStatus();
  log('OAuth App saved. You can now click CONNECT GITHUB.');
}

function stopOAuthPolling() {
  if (oauthPollTimer) { clearInterval(oauthPollTimer); oauthPollTimer = null; }
}

async function startOAuthWeb() {
  // v3.0.1: check the bridge first (see loginWithPat).
  await ensureBridgeUp();
  if (!oauthConfigured) {
    // Refresh the status first — the user may just have saved the config
    // in another tab, or the bridge may have one from its environment.
    await loadOAuthStatus();
  }
  if (!oauthConfigured) {
    throw new Error('OAuth Web Flow is not configured yet. Open "OAUTH APP SETUP" above: create a GitHub OAuth App (github.com → Settings → Developer settings → OAuth Apps), paste its Authorization callback URL from this page, then save its Client ID + Client Secret here. Or sign in with a Personal Access Token / Device Flow instead.');
  }
  let res;
  try {
    res = await gh('/oauth/start');
  } catch (err) {
    // v3.0: the bridge now names the missing step. Point the user at the
    // OAuth App setup form instead of a generic "failed" message.
    if (/OAUTH_APP_NOT_CONFIGURED/.test(err.message)) {
      $('oauthConfigDetails').open = true;
      $('oauthConnectHint').textContent = 'Chưa cấu hình OAuth App: mở "CÁCH 1 — CẤU HÌNH OAUTH APP" bên dưới, tạo OAuth App trên github.com rồi lưu Client ID + Client Secret ở đây.';
      await loadLoginDiagnostics().catch(() => {});
      throw new Error('OAuth App chưa được cấu hình trên bridge. Xem hướng dẫn trong phần "CÁCH 1 — CẤU HÌNH OAUTH APP" bên dưới.');
    }
    await loadLoginDiagnostics().catch(() => {});
    throw err;
  }
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url: res.authorizeUrl });
  else if (typeof window !== 'undefined' && window.open) window.open(res.authorizeUrl, '_blank');
  log('GitHub sign-in opened in a new tab. Approve the app there — this page will pick up the account automatically.');
  $('oauthConnectHint').textContent = 'Waiting for you to approve on GitHub… (this page checks every 2s, up to 5 minutes)';
  stopOAuthPolling();
  const deadline = Date.now() + 5 * 60 * 1000;
  oauthPollTimer = setInterval(async () => {
    if (Date.now() > deadline) {
      stopOAuthPolling();
      $('oauthConnectHint').textContent = 'The sign-in timed out. Click CONNECT GITHUB again.';
      return;
    }
    try {
      const me = await gh('/user');
      if (me.authed && me.user) {
        stopOAuthPolling();
        if (!me.user.authMethod && me.authMethod) me.user.authMethod = me.authMethod;
        if (!me.user.scopes && me.scopes) me.user.scopes = me.scopes;
        showUser(me.user);
        log(`Signed in to GitHub as ${me.user.login} (OAuth Web)`);
        await loadRepos(true);
        await loadAutoUpdateStatus();
      }
    } catch (_) { /* bridge hiccup — keep polling until the deadline */ }
  }, 2000);
}

/* ------------------------------------------------------------------ */
/* Auto-update                                                         */
/* ------------------------------------------------------------------ */

function showAutoUpdate(status) {
  if (!status) return;
  const el = $('autoUpdateState');
  if (!status.enabled) {
    el.textContent = 'Auto-update is off.' + (status.dotenvSynced === true ? ' · settings saved to local .env' : '');
    $('autoSyncState').textContent = '';
    $('autoSyncToggle').checked = false;
    $('autoSyncToggle').disabled = true;
    return;
  }
  const last = status.lastRunAt ? new Date(status.lastRunAt).toLocaleTimeString() : 'never';
  const next = status.nextRunAt ? new Date(status.nextRunAt).toLocaleTimeString() : '—';
  el.textContent = `On · every ${status.intervalSeconds}s · last check ${last} · next ${next}` +
    (status.updatesFound ? ` · ${status.updatesFound} update(s) found` : '') +
    (status.lastError ? ` · last error: ${status.lastError}` : '') +
    (status.dotenvSynced === true ? ' · settings saved to local .env' : ' · .env sync pending');
  $('autoSyncToggle').disabled = false;
  $('autoSyncToggle').checked = !!status.autoSync;
  const lastSync = status.lastAutoSync;
  $('autoSyncState').textContent = status.autoSync
    ? 'Auto-sync ON — new commits are pulled into the local repo automatically.' +
      (lastSync && lastSync.at
        ? ' Last auto-sync: ' + new Date(lastSync.at).toLocaleTimeString() +
          (lastSync.skipped ? ' (skipped: ' + (lastSync.reason || '') + ')' :
            ' · ' + (lastSync.commitsPulled || 0) + ' commit(s) pulled')
        : '')
    : '';
}

function showUpdateBadge() {
  const badge = $('updateBadge');
  if (updateBadgeCount > 0) {
    badge.classList.remove('hidden');
    badge.textContent = updateBadgeCount + ' new';
  } else {
    badge.classList.add('hidden');
    badge.textContent = '';
  }
}

async function loadAutoUpdateStatus() {
  try {
    const status = await gh('/auto-update');
    showAutoUpdate(status);
    $('autoUpdateToggle').checked = !!status.enabled;
    if (status.intervalSeconds) $('autoUpdateInterval').value = String(status.intervalSeconds);
  } catch (_) { /* not authed yet — ignore */ }
}

async function setAutoUpdateUI(enabled, intervalSeconds, autoSync) {
  const body = { enabled, intervalSeconds };
  if (autoSync !== undefined) body.autoSync = !!autoSync;
  const status = await gh('/auto-update', 'POST', body);
  showAutoUpdate(status);
  if (status.dotenvSaved === false) throw new Error(status.dotenvError || 'Could not save the auto-update settings to bridge/.env');
  await chrome.storage.local.set({ autoUpdateEnabled: status.enabled, autoUpdateInterval: status.intervalSeconds });
  return status;
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function showView(name) {
  $('view-repos').classList.toggle('hidden', name !== 'repos');
  $('view-repo').classList.toggle('hidden', name !== 'repo');
  $('view-local').classList.toggle('hidden', name !== 'local');
  $('view-actions').classList.toggle('hidden', name !== 'actions');
  $('view-profile').classList.toggle('hidden', name !== 'profile');
  $('view-settings').classList.toggle('hidden', name !== 'settings');
  $('navRepos').classList.toggle('active', name === 'repos' || name === 'repo');
  $('navLocal').classList.toggle('active', name === 'local');
  $('navActions').classList.toggle('active', name === 'actions');
  $('navProfile').classList.toggle('active', name === 'profile');
  $('navSettings').classList.toggle('active', name === 'settings');
}

function showRepoTab(tab) {
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  for (const name of ['overview', 'files', 'commits', 'branches', 'issues', 'pulls', 'releases']) {
    $('tab-' + name).classList.toggle('hidden', name !== tab);
  }
}

/* ------------------------------------------------------------------ */
/* Repositories: list, search, filter, sort                            */
/* ------------------------------------------------------------------ */

const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', HTML: '#e34c26',
  CSS: '#563d7c', Java: '#b07219', 'C++': '#f34b7d', C: '#555555', Go: '#00ADD8',
  Rust: '#dea584', Ruby: '#701516', PHP: '#4F5D95', Swift: '#F05138', Kotlin: '#A97BFF',
  Shell: '#89e051', Vue: '#41b883', Dart: '#00B4AB', 'C#': '#178600',
};

function setRepoListEmpty(text) {
  const container = $('repoList');
  container.className = 'empty';
  container.textContent = text;
}

function repoMatchesFilter(repo, filter) {
  if (filter === 'all') return true;
  if (filter === 'public') return !repo.private;
  if (filter === 'private') return !!repo.private;
  if (filter === 'forks') return !!repo.fork;
  if (filter === 'sources') return !repo.fork;
  if (filter === 'archived') return !!repo.archived;
  return true;
}

function filteredRepos() {
  const query = ($('repoSearch').value || '').trim().toLowerCase();
  const globalQuery = ($('globalSearch').value || '').trim().toLowerCase();
  const q = query || globalQuery;
  const filter = $('repoFilter').value;
  const sort = $('repoSort').value;
  let list = allRepos.filter((r) => repoMatchesFilter(r, filter));
  if (q) {
    list = list.filter((r) =>
      (r.name || '').toLowerCase().includes(q) ||
      (r.full_name || '').toLowerCase().includes(q) ||
      (r.description || '').toLowerCase().includes(q) ||
      (r.language || '').toLowerCase().includes(q));
  }
  const byDate = (key) => (a, b) => new Date(b[key] || 0) - new Date(a[key] || 0);
  if (sort === 'updated') list.sort(byDate('updated_at'));
  else if (sort === 'pushed') list.sort(byDate('pushed_at'));
  else if (sort === 'created') list.sort(byDate('created_at'));
  else if (sort === 'stars') list.sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));
  else if (sort === 'name') list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return list;
}

function renderRepos() {
  const container = $('repoList');
  const list = filteredRepos();
  $('repoCount').textContent = allRepos.length ? `(${list.length} of ${allRepos.length})` : '';
  if (!allRepos.length) {
    setRepoListEmpty('No repositories found. Sign in to GitHub first, or check that your token has the repo scope.');
    return;
  }
  if (!list.length) {
    setRepoListEmpty('No repositories match the current search / filter.');
    return;
  }
  container.className = '';
  container.innerHTML = '';
  for (const repo of list) {
    const item = document.createElement('button');
    item.className = 'repo-item';
    item.onclick = () => openRepo(repo);

    const name = document.createElement('span');
    name.className = 'rname';
    name.textContent = repo.full_name;
    item.append(name);

    if (repo.description) {
      const desc = document.createElement('div');
      desc.className = 'rdesc';
      desc.textContent = repo.description;
      item.append(desc);
    }

    const meta = document.createElement('div');
    meta.className = 'rmeta';

    const vis = document.createElement('span');
    vis.className = 'vis';
    vis.textContent = repo.private ? 'Private' : 'Public';
    meta.append(vis);

    if (repo.language) {
      const lang = document.createElement('span');
      const dot = document.createElement('span');
      dot.className = 'lang-dot';
      dot.style.background = LANG_COLORS[repo.language] || '#79c0ff';
      lang.append(dot);
      lang.append(document.createTextNode(repo.language));
      meta.append(lang);
    }

    const stars = document.createElement('span');
    stars.textContent = '★ ' + formatNumber(repo.stargazers_count);
    meta.append(stars);

    const forks = document.createElement('span');
    forks.textContent = '⑂ ' + formatNumber(repo.forks_count);
    meta.append(forks);

    const updated = document.createElement('span');
    updated.textContent = 'Updated ' + timeAgo(repo.updated_at);
    meta.append(updated);

    if (repo.fork) {
      const forkTag = document.createElement('span');
      forkTag.textContent = 'Fork';
      meta.append(forkTag);
    }
    if (repo.archived) {
      const archTag = document.createElement('span');
      archTag.textContent = 'Archived';
      meta.append(archTag);
    }
    const hasUpdate = document.createElement('span');
    hasUpdate.className = 'updated';
    hasUpdate.textContent = '';
    meta.append(hasUpdate);

    // v3.0: per-repo .zip download (stops the click so the repo does not open).
    const zipBtn = document.createElement('button');
    zipBtn.className = 'mini zip-btn';
    zipBtn.textContent = '⬇ .zip';
    zipBtn.title = 'Download this repository as a .zip';
    zipBtn.onclick = (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      run('Repository .zip downloaded', () => downloadRepoZip(repo));
    };
    meta.append(zipBtn);

    item.append(meta);
    container.append(item);
  }
  log(list.length + ' repositories shown' + (reposLoadedAt ? ' (loaded ' + new Date(reposLoadedAt).toLocaleTimeString() + ')' : ''));
}

async function loadRepos(force) {
  const res = await gh('/repos/all' + (force ? '?force=1' : ''));
  allRepos = res.repos || [];
  reposLoadedAt = Date.now();
  updateBadgeCount = 0;
  showUpdateBadge();
  renderRepos();
  return allRepos;
}

// v3.0 — download a GitHub repo as .zip (bridge v3.0 route). `ref` is a
// branch name; defaults to the repo's default branch.
async function downloadRepoZip(repo, ref) {
  const parts = String(repo.full_name || '').split('/');
  if (parts.length !== 2) throw new Error('Invalid repository name');
  const branch = ref || repo.default_branch || 'main';
  const filename = `${repo.name || parts[1]}-${branch}.zip`;
  log(`Downloading ${repo.full_name}@${branch} as ${filename}…`);
  const res = await downloadBlob(`/api/github/repos/${parts[0]}/${parts[1]}/zip?ref=${encodeURIComponent(branch)}`, 'GET', undefined, filename);
  log(`Downloaded ${res.filename} (${formatNumber(res.size)} B)`);
  return res;
}

async function downloadCurrentRepoZip() {
  if (!currentRepo) throw new Error('Open a repository first');
  const branch = $('fileBranchSelect').value || currentRepo.default_branch;
  await downloadRepoZip({ full_name: currentRepo.full_name, name: currentRepo.repo, default_branch: currentRepo.default_branch }, branch);
}

// v3.0 — create a repository on GitHub (bridge v3.0 route).
async function createRepo() {
  const name = $('createRepoName').value.trim();
  if (!name) throw new Error('Enter a name for the new repository');
  const res = await gh('/repos', 'POST', {
    name,
    description: $('createRepoDesc').value.trim(),
    private: !!$('createRepoPrivate').checked,
    auto_init: true,
  });
  $('createRepoName').value = '';
  $('createRepoDesc').value = '';
  $('createRepoPrivate').checked = false;
  log(`Repository created: ${res.full_name || res.name || name}`);
  await loadRepos(true);
  return res;
}

/* ------------------------------------------------------------------ */
/* Repo detail: overview / files / commits / branches / issues / pulls */
/* ------------------------------------------------------------------ */

function openRepo(repo) {
  const parts = String(repo.full_name || '').split('/');
  if (parts.length !== 2) return;
  currentRepo = { owner: parts[0], repo: parts[1], full_name: repo.full_name, default_branch: repo.default_branch || 'main' };
  currentPath = '';
  chrome.storage.local.set({ lastRepo: repo.full_name }).catch(() => {});
  $('detailName').textContent = repo.full_name;
  $('detailDesc').textContent = repo.description || 'No description.';
  $('detailStars').textContent = formatNumber(repo.stargazers_count);
  $('detailForks').textContent = formatNumber(repo.forks_count);
  $('detailIssues').textContent = formatNumber(repo.open_issues_count);
  const badges = $('detailBadges');
  badges.innerHTML = '';
  const mk = (text) => { const s = document.createElement('span'); s.textContent = text; badges.append(s); };
  mk(repo.private ? 'Private' : 'Public');
  if (repo.language) mk(repo.language);
  if (repo.fork) mk('Fork');
  if (repo.archived) mk('Archived');
  if (repo.license) mk('License: ' + repo.license);
  if (Array.isArray(repo.topics)) repo.topics.slice(0, 8).forEach((t) => mk(t));
  showView('repo');
  showRepoTab('overview');
  loadReadme().catch((err) => { $('readmeView').textContent = 'Could not load README: ' + err.message; });
  loadRepoBranches().catch(() => {});
  loadRepoCommits().catch(() => {});
}

async function loadReadme() {
  if (!currentRepo) return;
  const res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/readme`);
  $('readmeName').textContent = res.name || '';
  $('readmeView').textContent = res.content || '(Empty README)';
}

async function loadRepoBranches() {
  if (!currentRepo) return;
  const res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/branches?per_page=100`);
  const list = res.branches || [];
  const container = $('branchList');
  container.className = '';
  container.innerHTML = '';
  const select = $('fileBranchSelect');
  select.innerHTML = '';
  if (!list.length) {
    container.className = 'empty';
    container.textContent = 'No branches found.';
    return;
  }
  for (const b of list) {
    const row = document.createElement('div');
    row.className = 'commititem';
    const title = document.createElement('b');
    title.textContent = (b.protected ? '🔒 ' : '') + b.name;
    const meta = document.createElement('small');
    meta.textContent = b.sha ? b.sha.slice(0, 7) : '';
    row.append(title, meta);
    container.append(row);

    const opt = document.createElement('option');
    opt.value = b.name;
    opt.textContent = b.name;
    select.append(opt);
  }
  if (currentRepo.default_branch) select.value = currentRepo.default_branch;
  // v3.0: a saved default branch (Settings) wins when it exists here.
  if (settingsDefaultBranch && list.some((b) => b.name === settingsDefaultBranch)) select.value = settingsDefaultBranch;
  await loadFileTree(currentPath);
}

async function loadRepoCommits() {
  if (!currentRepo) return;
  const res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/commits?per_page=20`);
  const container = $('commitList');
  container.className = '';
  container.innerHTML = '';
  const commits = res.commits || [];
  if (!commits.length) {
    container.className = 'empty';
    container.textContent = 'No commits found.';
    return;
  }
  $('commitDetail').classList.add('hidden');
  container.classList.remove('hidden');
  for (const c of commits) {
    const row = document.createElement('div');
    row.className = 'commititem';
    row.style.cursor = 'pointer';
    row.title = 'Bấm để xem chi tiết commit';
    row.onclick = () => showCommitDetail(c.sha || c.hash).catch((err) => log('ERROR: ' + err.message));
    const title = document.createElement('b');
    title.textContent = c.short + ' · ' + c.message;
    const meta = document.createElement('small');
    meta.textContent = (c.author || 'unknown') + ' · ' + (c.date ? new Date(c.date).toLocaleString() : '');
    row.append(title, meta);
    container.append(row);
  }
}

async function loadRepoIssues() {
  if (!currentRepo) return;
  const res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/issues?state=open&per_page=20`);
  const container = $('issueList');
  container.classList.remove('hidden');
  $('issueDetail').classList.add('hidden');
  container.className = '';
  container.innerHTML = '';
  const issues = res.issues || [];
  if (!issues.length) {
    container.className = 'empty';
    container.textContent = 'No open issues.';
    return;
  }
  for (const i of issues) {
    const row = document.createElement('div');
    row.className = 'issueitem';
    row.style.cursor = 'pointer';
    row.title = 'Click to view details and comments';
    row.onclick = () => showIssueDetail(i.number).catch((err) => log('ERROR: ' + err.message));
    const title = document.createElement('b');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = '#' + i.number;
    title.append(num);
    title.append(document.createTextNode(i.title + (i.is_pull_request ? ' (PR)' : '')));
    const meta = document.createElement('small');
    meta.textContent = `${i.user || ''} · opened ${timeAgo(i.created_at)} · ${i.comments} comments` +
      (i.labels && i.labels.length ? ' · ' + i.labels.join(', ') : '');
    row.append(title, meta);
    container.append(row);
  }
}

async function loadRepoPulls() {
  if (!currentRepo) return;
  const res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/pulls?state=open&per_page=20`);
  const container = $('pullList');
  container.className = '';
  container.innerHTML = '';
  const pulls = res.pulls || [];
  if (!pulls.length) {
    container.className = 'empty';
    container.textContent = 'No open pull requests.';
    return;
  }
  $('prDetail').classList.add('hidden');
  container.classList.remove('hidden');
  for (const p of pulls) {
    const row = document.createElement('div');
    row.className = 'issueitem';
    row.style.cursor = 'pointer';
    row.title = 'Bấm để xem chi tiết PR';
    row.onclick = () => showPrDetail(p.number).catch((err) => log('ERROR: ' + err.message));
    const title = document.createElement('b');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = '#' + p.number;
    title.append(num);
    title.append(document.createTextNode(p.title + (p.draft ? ' (draft)' : '')));
    const meta = document.createElement('small');
    meta.textContent = `${p.user || ''} · ${p.head} → ${p.base} · opened ${timeAgo(p.created_at)}`;
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const mergeBtn = document.createElement('button');
    mergeBtn.className = 'mini blue';
    mergeBtn.textContent = 'Merge';
    mergeBtn.onclick = (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); run('Pull request merged', () => mergePullRequest(p.number)); };
    const closeBtn = document.createElement('button');
    closeBtn.className = 'mini';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); run('Pull request closed', () => closePullRequest(p.number)); };
    actions.append(mergeBtn, closeBtn);
    row.append(title, meta, actions);
    container.append(row);
  }
}

async function loadFileTree(relPath) {
  if (!currentRepo) return;
  currentPath = relPath || '';
  $('filePathLabel').textContent = '/' + currentPath;
  const branch = $('fileBranchSelect').value || currentRepo.default_branch;
  let apiPath = `/repos/${currentRepo.owner}/${currentRepo.repo}/contents?path=${encodeURIComponent(currentPath)}`;
  if (branch) apiPath += `&ref=${encodeURIComponent(branch)}`;
  const res = await gh(apiPath);
  const container = $('fileTree');
  container.className = '';
  container.innerHTML = '';
  $('fileViewerWrap').classList.add('hidden');
  $('blameView').classList.add('hidden');
  $('fileHistoryView').classList.add('hidden');
  if (!currentPath) renderFileReadme().catch(() => {});
  else $('fileReadmeWrap').classList.add('hidden');
  const entries = res.entries || [];
  if (!entries.length) {
    container.className = 'empty';
    container.textContent = 'This folder is empty.';
    return;
  }
  const sorted = [...entries].sort((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });
  for (const e of sorted) {
    const row = document.createElement('button');
    row.className = 'file-row';
    const icon = document.createElement('span');
    icon.textContent = e.type === 'dir' ? '📁' : '📄';
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = e.name;
    const meta = document.createElement('span');
    meta.className = 'fmeta';
    meta.textContent = e.type === 'dir' ? '' : formatNumber(e.size) + ' B';
    row.append(icon, name, meta);
    row.onclick = () => {
      if (e.type === 'dir') loadFileTree(e.path).catch((err) => log('ERROR: ' + err.message));
      else showFile(e.path).catch((err) => log('ERROR: ' + err.message));
    };
    container.append(row);
  }
}

async function showFile(relPath) {
  if (!currentRepo) return;
  const branch = $('fileBranchSelect').value || currentRepo.default_branch;
  const res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/contents?path=${encodeURIComponent(relPath)}&ref=${encodeURIComponent(branch)}`);
  $('fileViewerWrap').classList.remove('hidden');
  $('fileViewerName').textContent = res.name || relPath;
  $('fileViewerMeta').textContent = `${formatNumber(res.size)} B · ${res.sha ? res.sha.slice(0, 7) : ''}`;
  const content = res.content || '';
  $('fileViewer').textContent = content.length > 200000
    ? content.slice(0, 200000) + '\n\n… file truncated at 200,000 characters …'
    : content;
  // v3.0: remember the open file so it can be edited / deleted.
  selectedFile = relPath;
  selectedFileSha = res.sha || '';
  $('fileEditWrap').classList.remove('hidden');
  $('fileEditArea').value = content;
}

/* ------------------------------------------------------------------ */
/* v3.0 — Repo actions: star / unstar / fork / edit description /      */
/* delete, releases, code search, file edit / create / delete / upload */
/* ------------------------------------------------------------------ */

function repoApiBase() {
  if (!currentRepo) throw new Error('Open a repository first');
  return `/repos/${currentRepo.owner}/${currentRepo.repo}`;
}

async function starRepo() {
  await gh(repoApiBase() + '/star', 'PUT', {});
  log(`Starred ${currentRepo.full_name} ★`);
  await openRepoRefreshCounts();
}

async function unstarRepo() {
  await gh(repoApiBase() + '/star', 'DELETE', {});
  log(`Unstarred ${currentRepo.full_name}`);
  await openRepoRefreshCounts();
}

async function forkRepo() {
  const res = await gh(repoApiBase() + '/fork', 'POST', {});
  log(`Forked ${currentRepo.full_name} → ${res.full_name || 'your account'}`);
  await loadRepos(true);
  return res;
}

async function editRepoDescription() {
  const current = $('detailDesc').textContent === 'No description.' ? '' : $('detailDesc').textContent;
  const desc = prompt('New description for ' + currentRepo.full_name + ':', current);
  if (desc === null) return; // cancelled
  const res = await gh(repoApiBase(), 'PATCH', { description: desc });
  $('detailDesc').textContent = (res && res.description) || desc || 'No description.';
  log('Repository description updated.');
  await loadRepos(false);
  return res;
}

async function deleteRepo() {
  if (!currentRepo) throw new Error('Open a repository first');
  const fullName = currentRepo.full_name;
  if (!confirm(`Delete the GitHub repository ${fullName}?\n\nThis cannot be undone. All code, issues and pull requests will be gone.`)) return;
  if (!confirm(`Really delete ${fullName}? Click OK to confirm the deletion.`)) return;
  await gh(repoApiBase(), 'DELETE', { confirm: true });
  log(`Repository ${fullName} deleted.`);
  currentRepo = null;
  showView('repos');
  await loadRepos(true);
}

/* --- Releases --- */

async function loadReleases() {
  if (!currentRepo) return;
  const res = await gh(repoApiBase() + '/releases');
  const container = $('releaseList');
  container.className = '';
  container.innerHTML = '';
  const releases = res.releases || [];
  if (!releases.length) {
    container.className = 'empty';
    container.textContent = 'No releases yet.';
    return;
  }
  for (const r of releases) {
    const row = document.createElement('div');
    row.className = 'commititem';
    const title = document.createElement('b');
    title.textContent = (r.tag_name || '') + (r.name ? ' — ' + r.name : '') +
      (r.draft ? ' (draft)' : '') + (r.prerelease ? ' (pre-release)' : '');
    const meta = document.createElement('small');
    meta.textContent = (r.body || '').slice(0, 200);
    row.append(title, meta);
    const assets = r.assets || [];
    for (const a of assets) {
      const assetBtn = document.createElement('button');
      assetBtn.className = 'mini';
      assetBtn.textContent = `⬇ ${a.name} (${formatNumber(a.size)} B · ${a.download_count || 0} downloads)`;
      assetBtn.onclick = () => run('Release asset downloaded', async () => {
        await downloadBlob(`${repoApiBase()}/releases/assets/${a.id}?name=${encodeURIComponent(a.name)}`, 'GET', undefined, a.name);
        log(`Downloaded asset ${a.name}`);
      });
      row.append(assetBtn);
    }
    container.append(row);
  }
}

async function createRelease() {
  const tag = $('releaseTag').value.trim();
  if (!tag) throw new Error('Enter a tag name for the release (e.g. v1.0.0)');
  const res = await gh(repoApiBase() + '/releases', 'POST', {
    tag_name: tag,
    name: $('releaseName').value.trim() || tag,
    body: $('releaseBody').value.trim(),
    draft: !!$('releaseDraft').checked,
    prerelease: !!$('releasePrerelease').checked,
  });
  $('releaseTag').value = '';
  $('releaseName').value = '';
  $('releaseBody').value = '';
  $('releaseDraft').checked = false;
  $('releasePrerelease').checked = false;
  log(`Release ${res.tag_name || tag} created.`);
  await loadReleases();
  return res;
}

/* --- Code search --- */

async function searchCode() {
  if (!currentRepo) return;
  const q = $('codeSearchInput').value.trim();
  if (!q) throw new Error('Enter text to search for in this repository');
  const res = await gh(`/search/code?q=${encodeURIComponent(q)}&repo=${encodeURIComponent(currentRepo.full_name)}`);
  const container = $('codeSearchResults');
  container.className = '';
  container.innerHTML = '';
  const items = res.items || [];
  $('codeSearchResults').classList.remove('hidden');
  if (!items.length) {
    container.className = 'empty';
    container.textContent = `No code matches "${q}" in ${currentRepo.full_name}.`;
    return;
  }
  for (const item of items) {
    const row = document.createElement('button');
    row.className = 'file-row';
    const icon = document.createElement('span');
    icon.textContent = '🔎';
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = item.name || item.path;
    const meta = document.createElement('span');
    meta.className = 'fmeta';
    meta.textContent = item.path || '';
    row.append(icon, name, meta);
    row.onclick = () => {
      showRepoTab('files');
      showFile(item.path).catch((err) => log('ERROR: ' + err.message));
    };
    container.append(row);
  }
  log(`${items.length} code result(s) for "${q}"`);
}

/* --- File edit / create / delete / upload --- */

async function saveEditedFile() {
  if (!currentRepo || !selectedFile) throw new Error('Open a file first');
  const branch = $('fileBranchSelect').value || currentRepo.default_branch;
  const content = $('fileEditArea').value;
  const res = await gh(repoApiBase() + '/contents', 'PUT', {
    path: selectedFile,
    message: `Update ${selectedFile} via PixiJS GitHub Sync`,
    content,
    sha: selectedFileSha || undefined,
    branch,
  });
  if (res && res.content && res.content.sha) selectedFileSha = res.content.sha;
  log(`Saved ${selectedFile} ✓`);
  await loadFileTree(currentPath);
  return res;
}

async function createNewFile() {
  if (!currentRepo) throw new Error('Open a repository first');
  const name = $('newFileName').value.trim();
  if (!name) throw new Error('Enter a name for the new file');
  const branch = $('fileBranchSelect').value || currentRepo.default_branch;
  const path = currentPath ? currentPath + '/' + name : name;
  const res = await gh(repoApiBase() + '/contents', 'PUT', {
    path,
    message: `Create ${path} via PixiJS GitHub Sync`,
    content: $('newFileContent').value,
    branch,
  });
  $('newFileName').value = '';
  $('newFileContent').value = '';
  log(`Created ${path} ✓`);
  await loadFileTree(currentPath);
  return res;
}

async function deleteCurrentFile() {
  if (!currentRepo || !selectedFile) throw new Error('Open a file first');
  if (!confirm(`Delete ${selectedFile} from ${currentRepo.full_name}?\n\nThis commits the deletion to the branch.`)) return;
  const branch = $('fileBranchSelect').value || currentRepo.default_branch;
  await gh(repoApiBase() + '/contents', 'DELETE', {
    path: selectedFile,
    message: `Delete ${selectedFile} via PixiJS GitHub Sync`,
    sha: selectedFileSha,
    branch,
  });
  log(`Deleted ${selectedFile} ✓`);
  $('fileViewerWrap').classList.add('hidden');
  $('fileEditWrap').classList.add('hidden');
  selectedFile = '';
  selectedFileSha = '';
  await loadFileTree(currentPath);
}

async function uploadFileToRepo(file) {
  if (!currentRepo) throw new Error('Open a repository first');
  if (!file) throw new Error('Choose a file to upload');
  if (typeof FileReader === 'undefined') throw new Error('File upload is not available in this environment');
  const branch = $('fileBranchSelect').value || currentRepo.default_branch;
  const path = currentPath ? currentPath + '/' + file.name : file.name;
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      resolve(dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl);
    };
    reader.onerror = () => reject(new Error('Could not read ' + file.name));
    reader.readAsDataURL(file);
  });
  const res = await gh(repoApiBase() + '/contents', 'PUT', {
    path,
    message: `Upload ${path} via PixiJS GitHub Sync`,
    contentBase64: base64,
    branch,
  });
  log(`Uploaded ${path} ✓`);
  await loadFileTree(currentPath);
  return res;
}

// Refresh the star/fork/issue counters in the repo header after an action.
async function openRepoRefreshCounts() {
  if (!currentRepo) return;
  try {
    const res = await gh('/repos/all?force=1');
    const match = (res.repos || []).find((r) => r.full_name === currentRepo.full_name);
    if (match) {
      $('detailStars').textContent = formatNumber(match.stargazers_count);
      $('detailForks').textContent = formatNumber(match.forks_count);
      $('detailIssues').textContent = formatNumber(match.open_issues_count);
    }
  } catch (_) { /* best-effort — the counts are cosmetic */ }
}

/* --- Issues: create / detail / comment / close-reopen --- */

async function createIssue() {
  if (!currentRepo) return;
  const title = $('issueTitle').value.trim();
  if (!title) throw new Error('Enter an issue title');
  const labels = $('issueLabels').value.split(',').map((s) => s.trim()).filter(Boolean);
  const res = await gh(repoApiBase() + '/issues', 'POST', {
    title,
    body: $('issueBody').value.trim(),
    labels,
  });
  $('issueTitle').value = '';
  $('issueBody').value = '';
  $('issueLabels').value = '';
  log(`Issue #${(res && res.number) || '?'} created.`);
  await loadRepoIssues();
  return res;
}

async function showIssueDetail(number) {
  if (!currentRepo) return;
  currentIssueNumber = number;
  const res = await gh(`${repoApiBase()}/issues/${number}`);
  const issue = res.issue || res;
  $('issueDetail').classList.remove('hidden');
  $('issueList').classList.add('hidden');
  $('issueDetailTitle').textContent = `#${issue.number || number} — ${issue.title || ''}`;
  $('issueDetailMeta').textContent = `${issue.user || ''} · ${issue.state || ''} · opened ${timeAgo(issue.created_at)} · ${issue.comments || 0} comments`;
  $('issueDetailBody').textContent = issue.body || '(No description)';
  const commentsBox = $('issueComments');
  commentsBox.innerHTML = '';
  const comments = res.comments || issue.commentsList || [];
  if (!comments.length) {
    commentsBox.className = 'empty';
    commentsBox.textContent = 'No comments yet.';
  } else {
    commentsBox.className = '';
    for (const c of comments) {
      const row = document.createElement('div');
      row.className = 'commititem';
      const title = document.createElement('b');
      title.textContent = (c.user || c.author || 'unknown');
      const meta = document.createElement('small');
      meta.textContent = (c.body || '') + (c.created_at ? ' · ' + timeAgo(c.created_at) : '');
      row.append(title, meta);
      commentsBox.append(row);
    }
  }
  $('issueCloseBtn').textContent = issue.state === 'closed' ? 'Reopen issue' : 'Close issue';
}

async function addIssueComment() {
  if (!currentRepo || currentIssueNumber == null) throw new Error('Open an issue first');
  const body = $('commentBody').value.trim();
  if (!body) throw new Error('Write the comment first');
  await gh(`${repoApiBase()}/issues/${currentIssueNumber}/comments`, 'POST', { body });
  $('commentBody').value = '';
  log('Comment added.');
  await showIssueDetail(currentIssueNumber);
}

async function toggleIssueState() {
  if (!currentRepo || currentIssueNumber == null) throw new Error('Open an issue first');
  const closing = $('issueCloseBtn').textContent.indexOf('Close') === 0;
  await gh(`${repoApiBase()}/issues/${currentIssueNumber}`, 'PATCH', { state: closing ? 'closed' : 'open' });
  log(`Issue #${currentIssueNumber} ${closing ? 'closed' : 'reopened'}.`);
  await showIssueDetail(currentIssueNumber);
  await loadRepoIssues();
}

/* --- Pull requests: create / merge / close --- */

async function createPullRequest() {
  if (!currentRepo) return;
  const title = $('prTitle').value.trim();
  const head = $('prHead').value.trim();
  const base = $('prBase').value.trim() || currentRepo.default_branch;
  if (!title || !head) throw new Error('Enter a PR title and the head branch');
  const res = await gh(repoApiBase() + '/pulls', 'POST', { title, head, base, body: $('prBody').value.trim() });
  $('prTitle').value = '';
  $('prHead').value = '';
  $('prBody').value = '';
  log(`Pull request #${(res && res.number) || '?'} created (${head} → ${base}).`);
  await loadRepoPulls();
  return res;
}

async function mergePullRequest(number) {
  if (!currentRepo) return;
  const method = $('prMergeMethod').value || 'merge';
  if (!confirm(`Merge pull request #${number} (${method})?`)) return;
  await gh(`${repoApiBase()}/pulls/${number}/merge`, 'PUT', { merge_method: method });
  log(`Pull request #${number} merged (${method}).`);
  await loadRepoPulls();
}

async function closePullRequest(number) {
  if (!currentRepo) return;
  if (!confirm(`Close pull request #${number} without merging?`)) return;
  await gh(`${repoApiBase()}/pulls/${number}`, 'PATCH', { state: 'closed' });
  log(`Pull request #${number} closed.`);
  await loadRepoPulls();
}

/* ------------------------------------------------------------------ */
/* Local Git (v1 behaviour, restyled)                                  */
/* ------------------------------------------------------------------ */

function statusLabel(file) {
  if (file.untracked) return 'NEW';
  if (file.status === 'MM') return 'MM';
  return file.status || '?';
}

async function status() {
  const data = await api('/api/git/status');
  const files = data.files || [];
  const container = $('changes');
  container.innerHTML = '';

  if (!files.length) {
    container.className = 'empty';
    container.textContent = 'Working tree clean';
    log('0 changed file(s)');
    return;
  }

  container.className = '';
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'file';

    const tag = document.createElement('span');
    tag.className = 'tag' + (file.staged ? ' staged' : '');
    tag.textContent = statusLabel(file);

    const pathEl = document.createElement('span');
    pathEl.className = 'path';
    pathEl.textContent = file.path;
    if (file.origPath) pathEl.title = 'Renamed from ' + file.origPath;

    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = file.staged ? 'STAGED' : 'UNSTAGED';

    const actions = document.createElement('span');
    actions.className = 'actions';

    const diffBtn = document.createElement('button');
    diffBtn.textContent = 'Diff';
    diffBtn.onclick = () => showDiff(file.path);

    const stageBtn = document.createElement('button');
    stageBtn.textContent = file.staged ? 'Unstage' : 'Stage';
    stageBtn.onclick = async () => {
      try {
        await api('/api/git/' + (file.staged ? 'unstage' : 'stage'), 'POST', { path: file.path });
        await status();
        log((file.staged ? 'Unstaged ' : 'Staged ') + file.path);
      } catch (err) {
        log('ERROR: ' + err.message);
      }
    };

    actions.append(diffBtn, stageBtn);
    row.append(tag, pathEl, state, actions);
    container.append(row);
  }

  log(files.length + ' changed file(s)');
  loadDiffSummary().catch(() => {});
}

function formatDiffEntries(entries) {
  const list = entries || [];
  if (!list.length) return '0 files';
  let ins = 0;
  let del = 0;
  for (const e of list) { ins += Number(e.insertions) || 0; del += Number(e.deletions) || 0; }
  return `${list.length} file(s) (+${ins}/−${del})`;
}

async function loadDiffSummary() {
  const data = await api('/api/git/diff/summary');
  const worktree = data.worktree || [];
  const staged = data.staged || [];
  const fmt = (entries) => (entries || []).map((e) =>
    `${e.path} (+${e.insertions || 0}/−${e.deletions || 0}${e.binary ? ' binary' : ''})`).join(' · ');
  $('diffSummary').textContent =
    `Unstaged (worktree): ${formatDiffEntries(worktree)}` + (worktree.length ? ' — ' + fmt(worktree) : '') +
    ` · Staged: ${formatDiffEntries(staged)}` + (staged.length ? ' — ' + fmt(staged) : '');
}

async function showDiff(path) {
  selectedFile = path;
  $('diffFile').textContent = path;
  $('diff').textContent = 'Loading…';
  try {
    const data = await api('/api/git/diff?path=' + encodeURIComponent(path));
    $('diff').textContent = data.diff || '(No text diff available)';
  } catch (err) {
    $('diff').textContent = err.message;
  }
}

async function branches() {
  const data = await api('/api/git/branches');
  const select = $('branchSelect');
  const previous = select.value;
  select.innerHTML = '';

  const list = data.branches || [];
  dbFillBranches(list);
  if (!list.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No branches';
    select.append(option);
  } else {
    for (const branch of list) {
      const option = document.createElement('option');
      option.value = branch.name;
      option.textContent = (branch.current ? '● ' : '') + branch.name;
      select.append(option);
    }
    if (previous && list.some((b) => b.name === previous)) select.value = previous;
  }

  // v2.1: remote branches (read-only list — delete via the Branch panel).
  const remoteList = $('remoteBranchList');
  const remoteBranches = data.remoteBranches || [];
  remoteList.innerHTML = '';
  if (!remoteBranches.length) {
    remoteList.className = 'empty';
    remoteList.textContent = 'No remote branches.';
  } else {
    remoteList.className = '';
    for (const name of remoteBranches) {
      const row = document.createElement('div');
      row.className = 'commititem';
      const title = document.createElement('b');
      title.textContent = name;
      row.append(title);
      remoteList.append(row);
    }
  }
}

async function history(page) {
  historyPage = Math.max(1, Number(page) || historyPage || 1);
  const data = await api('/api/git/log?page=' + historyPage + '&per_page=30');
  historyHasNext = !!data.has_next;
  const container = $('history');
  container.innerHTML = '';

  const commits = data.commits || [];
  if (!commits.length) {
    container.className = 'empty';
    container.textContent = historyPage > 1 ? 'No more commits on this page.' : 'No commits yet';
  } else {
    container.className = '';
    for (const commit of commits) {
      const item = document.createElement('div');
      item.className = 'commititem';

      const title = document.createElement('b');
      title.textContent = commit.hash + ' · ' + commit.subject;

      const meta = document.createElement('small');
      meta.textContent = commit.author + ' · ' + commit.date;

      item.append(title, meta);
      container.append(item);
    }
  }
  $('historyPageLabel').textContent = 'Page ' + historyPage;
  $('historyPrevBtn').disabled = historyPage <= 1;
  $('historyNextBtn').disabled = !historyHasNext;
}

/* ------------------------------------------------------------------ */
/* Local Git v2.1: ahead/behind, push/pull/sync, branches, merge,      */
/* stash, remotes, clone                                               */
/* ------------------------------------------------------------------ */

function syncTarget() {
  return {
    remote: $('syncRemote').value.trim() || 'origin',
    branch: $('syncBranch').value.trim() || null,
    mode: $('pullMode').value || 'merge',
  };
}

/* v3.1.0 — every pull/push option the panel exposes, in one place. */
function splitList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function pullOptions() {
  const t = syncTarget();
  const depth = Number($('pullDepth').value);
  return {
    mode: t.mode,
    remote: t.remote,
    branch: t.branch,
    autostash: !!$('autostashCheck').checked,
    prune: !!$('pruneCheck').checked,
    fetchTags: !!$('fetchTagsCheck').checked,
    squash: !!$('squashCheck').checked,
    noCommit: !!$('noCommitCheck').checked,
    allowUnrelated: !!$('allowUnrelatedCheck').checked,
    recurseSubmodules: !!$('submodulesCheck').checked,
    unshallow: !!$('unshallowCheck').checked,
    depth: Number.isInteger(depth) && depth > 0 ? depth : null,
    strategyOption: $('strategyOption').value || null,
    useGithubAuth: !!$('useGithubAuthCheck').checked,
  };
}

function pushOptions(extra) {
  const t = syncTarget();
  const force = !!$('forcePushCheck').checked;
  if (force && !$('forceConfirmCheck').checked) {
    throw new Error('Force-push needs the confirmation checkbox ticked first ("I understand force-push can overwrite the remote branch").');
  }
  const extraRemotes = splitList($('pushExtraRemotes').value);
  const body = {
    remote: t.remote,
    branch: t.branch,
    remoteBranch: $('pushRemoteBranch').value.trim() || null,
    upTo: $('pushUpTo').value.trim() || null,
    setUpstream: !!$('setUpstreamCheck').checked || !!(extra && extra.setUpstream),
    force,
    confirm: force, // only ever sent when the user ticked both checkboxes
    forceIfIncludes: force && !!$('forceIfIncludesCheck').checked,
    leaseSha: force ? ($('leaseSha').value.trim() || null) : null,
    followTags: !!$('followTagsCheck').checked,
    atomic: !!$('atomicCheck').checked,
    noVerify: !!$('noVerifyCheck').checked,
    pushOptions: splitList($('pushOptionsInput').value),
    useGithubAuth: !!$('useGithubAuthCheck').checked,
    pushAll: !!(extra && extra.pushAll),
    tags: !!(extra && extra.tags),
    dryRun: !!(extra && extra.dryRun),
  };
  if (extraRemotes.length) body.remotes = [t.remote].concat(extraRemotes);
  return body;
}

async function loadAheadBehind() {
  const data = await api('/api/git/ahead-behind');
  dbSetAheadBehind(data);
  const badge = $('aheadBehindBadge');
  if (!data.hasUpstream) {
    badge.textContent = 'No upstream';
    badge.title = 'This branch has no upstream branch yet — tick "Set upstream" on push.';
    return data;
  }
  const ahead = Number(data.ahead) || 0;
  const behind = Number(data.behind) || 0;
  badge.textContent = `↑${ahead} ↓${behind}`;
  badge.title = `ahead ${ahead}, behind ${behind} ${data.upstream || ''}`.trim();
  return data;
}

function showAheadBehind(data) {
  if (!data) return;
  dbSetAheadBehind(data);
  const badge = $('aheadBehindBadge');
  const ahead = Number(data.ahead) || 0;
  const behind = Number(data.behind) || 0;
  if (data.hasUpstream === false) {
    badge.textContent = 'No upstream';
    badge.title = 'This branch has no upstream branch yet — tick "Set upstream" on push.';
  } else {
    badge.textContent = `↑${ahead} ↓${behind}`;
    badge.title = `ahead ${ahead}, behind ${behind} ${data.upstream || ''}`.trim();
  }
}

/* ---- small safe DOM builders (textContent only, never innerHTML) ---- */
function mk(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function commitListEl(commits, max) {
  const ul = mk('ul');
  for (const c of (commits || []).slice(0, max || 20)) {
    const li = mk('li');
    li.append(mk('code', null, c.short || String(c.sha || '').slice(0, 7)), document.createTextNode(' ' + (c.subject || '') + ' — ' + (c.author || '') + ' · ' + timeAgo(c.date)));
    ul.append(li);
  }
  if ((commits || []).length > (max || 20)) ul.append(mk('li', 'hint', `… và ${(commits.length - (max || 20))} commit khác`));
  return ul;
}

function fileListEl(files, max) {
  const ul = mk('ul');
  for (const f of (files || []).slice(0, max || 15)) {
    ul.append(mk('li', null, `${f.path}  ${f.binary ? '(binary)' : `+${f.insertions || 0} −${f.deletions || 0}`}`));
  }
  if ((files || []).length > (max || 15)) ul.append(mk('li', 'hint', `… và ${files.length - (max || 15)} file khác`));
  return ul;
}

function showResult(builder) {
  const box = $('pullPushResult');
  box.textContent = '';
  builder(box);
  box.classList.toggle('hidden', !box.childNodes.length);
}

function renderPullResult(res) {
  showResult((box) => {
    if (res.conflict) {
      box.append(mk('h4', 'bad', `⚠ Conflict (${res.operation || 'merge'}) ở ${(res.conflicts || []).length} file`));
      box.append(fileListEl((res.conflicts || []).map((p) => ({ path: p, insertions: 0, deletions: 0 }))));
      if (res.hint) box.append(mk('div', 'hint', res.hint));
      return;
    }
    if (res.upToDate) { box.append(mk('h4', 'ok', '✓ Đã cập nhật — không có commit mới.')); return; }
    const s = res.stats || {};
    box.append(mk('h4', 'ok', `✓ Pull (${res.mode}) — ${res.commitsPulled || 0} commit, ${s.fileCount || 0} file, +${s.insertions || 0} −${s.deletions || 0}${res.fastForward ? ' · fast-forward' : ''}`));
    if (res.pendingCommit) box.append(mk('div', 'warn', 'Thay đổi đã được stage nhưng CHƯA commit (squash / no-commit) — viết message rồi Commit.'));
    if (res.commits && res.commits.length) box.append(commitListEl(res.commits));
    if (s.files && s.files.length) box.append(fileListEl(s.files));
    if (res.usedGithubAuth) box.append(mk('div', 'hint', 'Đã dùng tài khoản GitHub đang đăng nhập để xác thực.'));
  });
}

function renderPushResult(res) {
  showResult((box) => {
    if (res.multi) {
      box.append(mk('h4', res.ok ? 'ok' : 'bad', res.ok ? '✓ Push lên nhiều remote' : '✗ Push lên nhiều remote: có remote lỗi'));
      const ul = mk('ul');
      for (const r of res.results || []) ul.append(mk('li', r.ok ? 'ok' : 'bad', `${r.remote}: ${r.ok ? (r.upToDate ? 'đã cập nhật' : 'OK') : r.error}`));
      box.append(ul);
      return;
    }
    const title = res.dryRun ? '✓ Push thử (dry-run) — chưa gửi gì lên remote' : res.upToDate ? '✓ Remote đã cập nhật — không có gì để push' : `✓ Push lên ${res.remote}/${res.remoteBranch || res.branch}`;
    box.append(mk('h4', 'ok', title + (res.forced ? ' (forced)' : '')));
    const ul = mk('ul');
    for (const r of res.refs || []) ul.append(mk('li', r.status === 'rejected' ? 'bad' : null, `${r.status}: ${r.from || ''} → ${r.to || ''} ${r.summary ? '(' + r.summary + ')' : ''}`));
    if (ul.childNodes.length) box.append(ul);
    if (res.usedGithubAuth) box.append(mk('div', 'hint', 'Đã dùng tài khoản GitHub đang đăng nhập để xác thực.'));
  });
}

function renderPushError(err) {
  const d = err.data || {};
  showResult((box) => {
    box.append(mk('h4', 'bad', '✗ Push thất bại' + (d.reason && d.reason !== 'unknown' ? ` (${d.reason})` : '')));
    if (d.hint) box.append(mk('div', 'warn', d.hint));
    const ul = mk('ul');
    for (const r of d.refs || []) ul.append(mk('li', r.status === 'rejected' ? 'bad' : null, `${r.status}: ${r.from || ''} → ${r.to || ''} ${r.summary ? '(' + r.summary + ')' : ''}`));
    if (ul.childNodes.length) box.append(ul);
  });
}

// A pull/merge that conflicts returns HTTP 200 { ok:false, conflict:true }.
// Surface it in the Merge & Conflicts panel instead of a bare error.
async function handlePossibleConflict(res, what) {
  if (res && res.conflict) {
    log(`${what}: ${res.operation || 'merge'} conflict in ${(res.conflicts || []).length} file(s) — resolve below (Ours / Theirs), then ${res.operation === 'rebase' ? 'Rebase: Continue' : 'Commit merge'}.`);
    await loadConflicts();
    await loadOperation().catch(() => {});
    return true;
  }
  return false;
}

async function doFetch() {
  let res;
  try {
    res = await api('/api/git/fetch', 'POST', { useGithubAuth: !!$('useGithubAuthCheck').checked });
  } catch (err) {
    const d = err.data || {};
    showResult((box) => {
      box.append(mk('h4', 'bad', '✗ Fetch thất bại' + (d.reason && d.reason !== 'unknown' ? ` (${d.reason})` : '')));
      if (d.hint) box.append(mk('div', 'warn', d.hint));
    });
    throw err;
  }
  dbState.lastFetchAt = res.lastFetchAt || new Date().toISOString();
  showAheadBehind(res);
  const failed = (res.results || []).filter((r) => !r.ok);
  if (failed.length) log('Fetch: một số remote lỗi — ' + failed.map((r) => `${r.remote}: ${r.hint || r.error}`).join('; '));
  await loadAheadBehind().catch(() => {});
  await status();
  return res;
}

async function afterRemoteOp(res) {
  showAheadBehind(res);
  await loadAheadBehind().catch(() => {});
  await loadOperation().catch(() => {});
  await loadUndoState().catch(() => {});
  await loadSyncHistory().catch(() => {});
  await status();
  await history();
}

async function doPull() {
  const opts = pullOptions();
  let res;
  try {
    res = await api('/api/git/pull', 'POST', opts);
  } catch (err) {
    const d = err.data || {};
    showResult((box) => {
      box.append(mk('h4', 'bad', '✗ Pull thất bại' + (d.reason && d.reason !== 'unknown' ? ` (${d.reason})` : '')));
      if (d.hint) box.append(mk('div', 'warn', d.hint));
    });
    await loadOperation().catch(() => {});
    throw err;
  }
  renderPullResult(res);
  if (await handlePossibleConflict(res, 'Pull')) {
    await afterRemoteOp(res);
    return res;
  }
  if (!res.ok) throw new Error(res.error || res.result || 'Pull failed');
  log(`Pull (${res.mode || opts.mode}) ✓ — ${res.commitsPulled || 0} commit(s), ${((res.changedFiles || []).length)} file(s) changed${res.fastForward ? ' (fast-forward)' : ''}`);
  await afterRemoteOp(res);
  return res;
}

async function doPush(options) {
  const body = pushOptions(options);
  let res;
  try {
    res = await api('/api/git/push', 'POST', body);
  } catch (err) {
    renderPushError(err);
    throw err;
  }
  renderPushResult(res);
  await afterRemoteOp(res);
  if (res.ok === false) throw new Error('Một số remote push lỗi — xem chi tiết bên dưới.');
  return res;
}

async function doPullPreview() {
  const t = syncTarget();
  const res = await api('/api/git/pull/preview', 'POST', { remote: t.remote, branch: t.branch, useGithubAuth: !!$('useGithubAuthCheck').checked });
  showResult((box) => {
    box.append(mk('h4', res.upToDate ? 'ok' : res.diverged ? 'warn' : 'ok',
      `👁 Xem trước Pull từ ${res.remote}/${res.branch}: ${res.incomingCount} commit sẽ về, bạn đang hơn ${res.outgoingCount} commit`));
    box.append(mk('div', res.dirtyOverlap && res.dirtyOverlap.length ? 'warn' : 'hint', res.suggestion));
    if (res.possibleConflicts && res.possibleConflicts.length) box.append(mk('div', 'warn', 'Có thể conflict: ' + res.possibleConflicts.join(', ')));
    if (res.dirtyOverlap && res.dirtyOverlap.length) box.append(mk('div', 'warn', 'File đang sửa trùng: ' + res.dirtyOverlap.join(', ')));
    if (res.incoming && res.incoming.length) box.append(commitListEl(res.incoming));
    const s = res.stats || {};
    if (s.files && s.files.length) {
      box.append(mk('div', 'hint', `${s.fileCount} file · +${s.insertions} −${s.deletions}`));
      box.append(fileListEl(s.files));
    }
  });
  showAheadBehind(res);
  log(`Pull preview: ${res.incomingCount} incoming, ${res.outgoingCount} outgoing.`);
  return res;
}

async function doPushPreview() {
  const t = syncTarget();
  const res = await api('/api/git/push/preview', 'POST', {
    remote: t.remote, branch: t.branch,
    remoteBranch: $('pushRemoteBranch').value.trim() || null,
    useGithubAuth: !!$('useGithubAuthCheck').checked,
  });
  showResult((box) => {
    box.append(mk('h4', res.willBeRejected ? 'warn' : 'ok',
      `👁 Xem trước Push lên ${res.remote}/${res.remoteBranch}: ${res.outgoingCount} commit sẽ đi${res.newBranch ? ' (branch mới)' : ''}`));
    box.append(mk('div', res.willBeRejected ? 'warn' : 'hint', res.suggestion));
    if (res.outgoing && res.outgoing.length) box.append(commitListEl(res.outgoing));
    const s = res.stats || {};
    if (s.files && s.files.length) {
      box.append(mk('div', 'hint', `${s.fileCount} file · +${s.insertions} −${s.deletions}`));
      box.append(fileListEl(s.files));
    }
    if (res.tagsOnHead && res.tagsOnHead.length) box.append(mk('div', 'hint', 'Tag trên commit này: ' + res.tagsOnHead.join(', ') + ' — tích --follow-tags hoặc bấm Push tags để đẩy kèm.'));
  });
  log(`Push preview: ${res.outgoingCount} outgoing${res.willBeRejected ? ', would be REJECTED (remote ahead by ' + res.behindCount + ')' : ''}.`);
  return res;
}

async function doPullAllBranches() {
  const t = syncTarget();
  const res = await api('/api/git/pull/all-branches', 'POST', { remote: t.remote, useGithubAuth: !!$('useGithubAuthCheck').checked });
  const LABEL = { updated: '✓ đã fast-forward', 'up-to-date': 'đã cập nhật', ahead: 'đang hơn remote (chưa push)', diverged: '⚠ đã rẽ nhánh — bỏ qua, hãy pull riêng', 'no-upstream': 'không có upstream', 'other-remote': 'theo remote khác', 'upstream-gone': 'upstream đã bị xoá', failed: '✗ lỗi' };
  showResult((box) => {
    box.append(mk('h4', 'ok', `⇣ Pull tất cả branch từ ${res.remote}: ${res.updated} branch được cập nhật`));
    const ul = mk('ul');
    for (const r of res.results || []) {
      ul.append(mk('li', r.status === 'diverged' || r.status === 'failed' ? 'warn' : r.status === 'updated' ? 'ok' : null,
        `${r.branch}: ${LABEL[r.status] || r.status}${r.behind ? ` (↓${r.behind})` : ''}${r.error ? ' — ' + r.error : ''}`));
    }
    box.append(ul);
  });
  await afterRemoteOp(res);
  return res;
}

async function loadUndoState() {
  const res = await api('/api/git/pull/last');
  const btn = $('undoPullBtn');
  btn.disabled = !res.undoAvailable;
  btn.title = res.undoAvailable && res.lastPull
    ? `Đưa ${res.lastPull.branch} về ${String(res.lastPull.oldSha).slice(0, 7)} (trước lần pull lúc ${new Date(res.lastPull.at).toLocaleTimeString()})`
    : 'Không có lần pull nào để hoàn tác';
  return res;
}

async function doUndoPull() {
  if (!confirm('Hoàn tác lần pull gần nhất? Branch sẽ quay về commit trước khi pull (git reset --keep — không mất thay đổi chưa commit).')) return null;
  const res = await api('/api/git/pull/undo', 'POST', { confirm: true });
  showResult((box) => box.append(mk('h4', 'ok', `↶ Đã hoàn tác pull — ${res.branch} quay về ${String(res.restoredSha).slice(0, 7)}`)));
  await afterRemoteOp(res);
  return res;
}

async function loadOperation() {
  const res = await api('/api/git/operation');
  const bar = $('operationBar');
  const isRebase = res.state === 'rebase';
  bar.classList.toggle('hidden', !res.state);
  $('operationText').textContent = res.state
    ? `${res.hint || 'Đang có thao tác dở: ' + res.state}${res.conflicts && res.conflicts.length ? ` — còn ${res.conflicts.length} file conflict.` : ''}`
    : '';
  for (const id of ['rebaseContinueBtn', 'rebaseSkipBtn', 'rebaseAbortBtn']) $(id).classList.toggle('hidden', !isRebase);
  return res;
}

async function doRebase(action) {
  if (action === 'abort' && !confirm('Huỷ rebase và đưa branch về như trước khi pull?')) return null;
  const res = await api('/api/git/rebase/' + action, 'POST', {});
  if (res.conflict) {
    log(`Rebase ${action}: còn conflict ở ${(res.conflicts || []).length} file — xử lý tiếp rồi bấm Continue.`);
    await loadConflicts();
  } else {
    log(`Rebase ${action} ✓${res.done ? ' — rebase xong' : ''}`);
  }
  await afterRemoteOp(res);
  return res;
}

const HISTORY_LABEL = { pull: 'Pull', push: 'Push', sync: 'Sync', 'pull-all': 'Pull all', 'undo-pull': 'Undo pull', 'rebase-continue': 'Rebase ▶', 'rebase-abort': 'Rebase ✕', 'rebase-skip': 'Rebase ⤼' };

function historySummary(h) {
  if (h.error) return h.error;
  if (h.type === 'pull') return h.conflict ? `conflict ở ${h.conflicts} file (${h.mode})` : `${h.remote}/${h.branch} · ${h.commits || 0} commit · +${h.insertions || 0} −${h.deletions || 0} (${h.mode})`;
  if (h.type === 'push') return `${h.remote}/${h.remoteBranch || h.branch}${h.dryRun ? ' · dry-run' : ''}${h.force ? ' · force' : ''}${h.commits ? ` · ${h.commits} commit` : ''}`;
  if (h.type === 'sync') return `pull ${h.pulled || 0} commit · ${h.pushed ? 'đã push' : 'không push'}`;
  if (h.type === 'pull-all') return `${h.updated || 0} branch cập nhật · ${h.diverged || 0} rẽ nhánh`;
  if (h.type === 'undo-pull') return `${h.branch}: ${String(h.from || '').slice(0, 7)} → ${String(h.to || '').slice(0, 7)}`;
  return h.conflict ? `conflict ở ${h.conflicts} file` : '';
}

async function loadSyncHistory() {
  const res = await api('/api/git/sync-history?limit=20');
  const box = $('syncHistory');
  box.textContent = '';
  const items = res.history || [];
  box.classList.toggle('empty', !items.length);
  if (!items.length) {
    box.textContent = 'Chưa có thao tác pull/push nào trong phiên bridge này.';
    return res;
  }
  for (const h of items) {
    const row = mk('div', 'hist-row');
    row.append(mk('time', null, new Date(h.at).toLocaleTimeString()), mk('span', 't ' + (h.ok ? 'ok' : 'bad'), (h.ok ? '✓ ' : '✗ ') + (HISTORY_LABEL[h.type] || h.type)), mk('span', null, historySummary(h)));
    box.append(row);
  }
  return res;
}

let progressHideTimer = null;
function showGitProgress(payload) {
  if (dbState.busy) dbSetStatus(`${dbState.busyText || 'Đang chạy…'}\n${payload.op || 'git'}: ${payload.line || ''}`, 'busy');
  const line = $('gitProgress');
  line.textContent = `${payload.op || 'git'}: ${payload.line || ''}`;
  line.classList.remove('hidden');
  clearTimeout(progressHideTimer);
  progressHideTimer = setTimeout(() => line.classList.add('hidden'), 4000);
}

function renderSyncSteps(res) {
  const box = $('syncSteps');
  const steps = (res && res.steps) || [];
  if (!steps.length) {
    box.textContent = res && res.error ? 'Sync failed: ' + res.error : 'Sync finished.';
    return;
  }
  box.textContent = steps.map((s) =>
    `${s.step}: ${s.ok ? (s.skipped ? '–' : '✓') : '✗'}${s.conflict ? ' (conflict)' : ''}${s.result ? ' — ' + String(s.result).split('\n')[0] : ''}${s.error ? ' — ' + String(s.error).split('\n')[0] : ''}`
  ).join('  ·  ') + (res.hint ? '  →  ' + res.hint : '');
}

async function doSync() {
  const body = pullOptions();
  body.pushAfter = !!$('syncPushAfterCheck').checked;
  const p = pushOptions();
  Object.assign(body, {
    setUpstream: p.setUpstream, followTags: p.followTags, noVerify: p.noVerify, atomic: p.atomic,
    remoteBranch: p.remoteBranch, pushOptions: p.pushOptions,
    extraRemotes: splitList($('pushExtraRemotes').value),
  });
  let res;
  try {
    res = await api('/api/git/sync', 'POST', body);
  } catch (err) {
    // The bridge answers 400 when a step throws outright (e.g. no remote
    // configured) instead of a per-step report — show it in the panel too.
    $('syncSteps').textContent = `sync: ✗ — ${err.message}`;
    throw err;
  }
  renderSyncSteps(res);
  if (res.pulled) renderPullResult(res.pulled);
  if (await handlePossibleConflict(res, 'Sync')) {
    await afterRemoteOp(res);
    return res;
  }
  await afterRemoteOp(res);
  if (!res.ok) throw new Error(res.error || 'Sync failed at the ' + ((res.steps || []).find((s) => !s.ok) || {}).step + ' step');
  const pushStep = (res.steps || []).find((s) => s.step === 'push') || {};
  log(`Sync ✓ — pulled ${((res.pulled || {}).commitsPulled) || 0} commit(s), ${pushStep.skipped ? 'push skipped' : 'pushed'}.`);
  return res;
}

async function createBranch() {
  const name = $('newBranchName').value.trim();
  if (!name) throw new Error('Enter a name for the new branch');
  const res = await api('/api/git/branch/create', 'POST', {
    name,
    from: $('newBranchFrom').value.trim() || undefined,
    checkout: $('newBranchCheckout').checked,
  });
  $('newBranchName').value = '';
  $('newBranchFrom').value = '';
  log(`Branch ${res.branch} created${res.current === res.branch ? ' and checked out' : ''}.`);
  await refreshAllLocal();
}

async function renameBranch() {
  const oldName = $('renameBranchOld').value.trim();
  const newName = $('renameBranchNew').value.trim();
  if (!oldName || !newName) throw new Error('Enter both the old and the new branch name');
  const res = await api('/api/git/branch/rename', 'POST', { old: oldName, new: newName });
  $('renameBranchOld').value = '';
  $('renameBranchNew').value = '';
  log(`Branch renamed: ${res.old} → ${res.new}.`);
  await refreshAllLocal();
}

async function deleteBranch() {
  const name = $('deleteBranchName').value.trim();
  if (!name) throw new Error('Enter the branch to delete');
  const res = await api('/api/git/branch/delete', 'POST', {
    name,
    remote: !!$('deleteBranchRemoteCheck').checked,
    deleteRemote: !!$('deleteBranchRemoteCheck').checked,
    remoteName: $('syncRemote').value.trim() || 'origin',
    force: !!$('deleteBranchForceCheck').checked,
  });
  $('deleteBranchName').value = '';
  log(`Branch ${res.branch} deleted${res.remoteDeleted ? ' locally and on the remote' : ' locally'}.`);
  await refreshAllLocal();
}

async function loadConflicts() {
  const data = await api('/api/git/conflicts');
  const container = $('conflictList');
  const conflicts = data.conflicts || [];
  container.innerHTML = '';
  if (!conflicts.length) {
    container.className = 'empty';
    container.textContent = data.merging ? 'Merging — no conflicted files left. Commit the merge when ready.' : 'No merge conflicts.';
    return data;
  }
  container.className = 'conflict-list';
  for (const path of conflicts) {
    const row = document.createElement('div');
    row.className = 'conflict-row';
    const name = document.createElement('span');
    name.className = 'path';
    name.textContent = path;
    const oursBtn = document.createElement('button');
    oursBtn.textContent = 'Ours';
    oursBtn.title = 'Keep our version of ' + path;
    oursBtn.onclick = () => run('Resolved ' + path + ' (ours)', async () => {
      const res = await api('/api/git/conflict/resolve', 'POST', { path, side: 'ours' });
      await loadConflicts();
      await status();
      if (res.allResolved) log('All conflicts resolved — click "Commit merge" to finish.');
    });
    const theirsBtn = document.createElement('button');
    theirsBtn.textContent = 'Theirs';
    theirsBtn.title = 'Keep their version of ' + path;
    theirsBtn.onclick = () => run('Resolved ' + path + ' (theirs)', async () => {
      const res = await api('/api/git/conflict/resolve', 'POST', { path, side: 'theirs' });
      await loadConflicts();
      await status();
      if (res.allResolved) log('All conflicts resolved — click "Commit merge" to finish.');
    });
    row.append(name, oursBtn, theirsBtn);
    container.append(row);
  }
  return data;
}

async function mergeBranch() {
  const branch = $('mergeBranchInput').value.trim();
  if (!branch) throw new Error('Enter the branch to merge');
  const res = await api('/api/git/merge', 'POST', { branch, noFF: $('mergeNoFFCheck').checked });
  if (await handlePossibleConflict(res, 'Merge')) {
    await status();
    await history();
    return res;
  }
  if (!res.ok) throw new Error(res.error || res.result || 'Merge failed');
  log(`Merged ${branch} ✓`);
  await status();
  await history();
  return res;
}

async function commitMerge() {
  const summary = $('summary').value.trim() ||
    `Merge branch '${$('mergeBranchInput').value.trim() || 'unknown'}'`;
  await api('/api/git/commit', 'POST', { summary, description: $('description').value.trim() });
  $('summary').value = '';
  $('description').value = '';
  log('Merge committed ✓');
  await status();
  await history();
  await loadConflicts();
}

async function createStash() {
  const res = await api('/api/git/stash/create', 'POST', { message: $('stashMessage').value.trim() || undefined });
  $('stashMessage').value = '';
  log('Stash created ✓ — ' + (res.result || '').split('\n')[0]);
  await loadStashList();
  await status();
}

async function loadStashList() {
  const data = await api('/api/git/stash/list');
  const container = $('stashList');
  const stashes = data.stashes || [];
  container.innerHTML = '';
  if (!stashes.length) {
    container.className = 'empty';
    container.textContent = 'No stashes.';
    return data;
  }
  container.className = '';
  for (const stash of stashes) {
    const row = document.createElement('div');
    row.className = 'stash-row';
    const label = document.createElement('span');
    label.className = 'path';
    label.textContent = `stash@{${stash.index}} — ${stash.message || '(no message)'}`;
    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply';
    applyBtn.onclick = () => run('Stash applied', async () => {
      await api('/api/git/stash/apply', 'POST', { index: stash.index });
      await loadStashList();
      await status();
    });
    const popBtn = document.createElement('button');
    popBtn.textContent = 'Pop';
    popBtn.title = 'Apply and remove this stash';
    popBtn.onclick = () => run('Stash popped', async () => {
      await api('/api/git/stash/apply', 'POST', { index: stash.index, pop: true });
      await loadStashList();
      await status();
    });
    const dropBtn = document.createElement('button');
    dropBtn.textContent = 'Drop';
    dropBtn.onclick = () => run('Stash dropped', async () => {
      await api('/api/git/stash/drop', 'POST', { index: stash.index });
      await loadStashList();
    });
    row.append(label, applyBtn, popBtn, dropBtn);
    container.append(row);
  }
  return data;
}

async function loadRemotes() {
  const data = await api('/api/git/remotes');
  const container = $('remoteList');
  const remotes = data.remotes || [];
  container.innerHTML = '';
  if (!remotes.length) {
    container.className = 'empty';
    container.textContent = 'No remotes configured.';
    return data;
  }
  container.className = '';
  for (const remote of remotes) {
    const row = document.createElement('div');
    row.className = 'remote-row';
    const name = document.createElement('b');
    name.textContent = remote.name;
    const url = document.createElement('span');
    url.className = 'path';
    url.textContent = remote.fetchUrl || remote.pushUrl || '';
    url.title = 'fetch: ' + (remote.fetchUrl || '') + ' · push: ' + (remote.pushUrl || '');
    const setUrlBtn = document.createElement('button');
    setUrlBtn.textContent = 'Edit URL';
    setUrlBtn.onclick = () => {
      $('setUrlRemoteName').value = remote.name;
      $('setUrlRemoteUrl').value = remote.fetchUrl || remote.pushUrl || '';
      $('setUrlRemoteUrl').focus();
    };
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = () => run('Remote removed', async () => {
      await api('/api/git/remote/remove', 'POST', { name: remote.name });
      await loadRemotes();
      await loadAheadBehind().catch(() => {});
    });
    row.append(name, url, setUrlBtn, removeBtn);
    container.append(row);
  }
  return data;
}

async function cloneRepo() {
  const url = $('cloneUrl').value.trim();
  const target = $('clonePath').value.trim();
  if (!url) throw new Error('Enter the repository URL to clone');
  if (!target) throw new Error('Enter the destination folder for the clone');
  const res = await api('/api/git/clone', 'POST', {
    url,
    path: target,
    branch: $('cloneBranch').value.trim() || undefined,
  });
  $('cloneUrl').value = '';
  $('cloneBranch').value = '';
  if (res.repository) $('repoPath').value = res.repository.path;
  log('Cloned ✓ — ' + (res.result || '').split('\n')[0]);
  await refreshAllLocal();
}

async function run(label, fn) {
  try {
    await fn();
    log(label + ' ✓');
  } catch (err) {
    log('ERROR: ' + err.message);
  }
}

async function refreshAllLocal() {
  await health();
  if (!localConnected) return;
  await status();
  await branches();
  await history();
  // v2.1 panels: each is best-effort so one failing endpoint (e.g. no
  // remote yet) never blocks the rest of the refresh.
  await loadAheadBehind().catch(() => {});
  await loadConflicts().catch(() => {});
  await loadStashList().catch(() => {});
  await loadRemotes().catch(() => {});
  await loadDiffSummary().catch(() => {});
  await loadTags().catch(() => {});
  await loadOperation().catch(() => {});
  await loadUndoState().catch(() => {});
  await loadSyncHistory().catch(() => {});
  await loadPullOriginPanel().catch(() => {}); // v3.5.0
}

/* ------------------------------------------------------------------ */
/* v3.0 — Notifications, profile, settings                             */
/* ------------------------------------------------------------------ */

async function loadNotifications() {
  let data;
  try {
    data = await gh('/notifications');
  } catch (err) {
    $('notifList').className = 'empty';
    $('notifList').textContent = 'Could not load notifications: ' + err.message +
      ' (needs bridge v3.0 — older bridges do not have this route).';
    return null;
  }
  const list = (data && data.notifications) || [];
  notifUnreadCount = list.filter((n) => n.unread).length;
  updateNotifBadge();
  const container = $('notifList');
  container.innerHTML = '';
  if (!list.length) {
    container.className = 'empty';
    container.textContent = 'No notifications.';
    return data;
  }
  container.className = '';
  for (const n of list) {
    const row = document.createElement('div');
    row.className = 'commititem';
    const title = document.createElement('b');
    title.textContent = (n.unread ? '● ' : '') + ((n.subject && n.subject.title) || 'Notification');
    const meta = document.createElement('small');
    meta.textContent = `${(n.repository && n.repository.full_name) || ''} · ${n.reason || ''} · ${timeAgo(n.updated_at)}`;
    row.append(title, meta);
    container.append(row);
  }
  return data;
}

function updateNotifBadge() {
  const badge = $('notifBadge');
  if (!settingsNotifications || notifUnreadCount <= 0) {
    badge.classList.add('hidden');
    badge.textContent = '';
    return;
  }
  badge.classList.remove('hidden');
  badge.textContent = String(notifUnreadCount);
}

async function markAllNotificationsRead() {
  await gh('/notifications/read', 'POST', {});
  notifUnreadCount = 0;
  updateNotifBadge();
  log('All notifications marked as read.');
  await loadNotifications();
}

async function loadProfile() {
  let data;
  try {
    data = await gh('/profile');
  } catch (err) {
    $('profileStats').textContent = 'Could not load profile: ' + err.message +
      ' (needs bridge v3.0 — older bridges do not have this route).';
    return null;
  }
  const p = (data && data.profile) || {};
  $('profileAvatar').src = p.avatar_url || '';
  $('profileAvatar').alt = p.login || '';
  $('profileName').textContent = p.name || p.login || '—';
  $('profileLogin').textContent = p.login ? '@' + p.login : '—';
  $('profileEmail').textContent = p.email || '—';
  $('profileBio').textContent = p.bio || '—';
  $('profileCompany').textContent = p.company || '—';
  $('profileBlog').textContent = p.blog || '—';
  $('profileLocation').textContent = p.location || '—';
  $('profileStats').textContent =
    `${p.public_repos != null ? p.public_repos + ' public repos' : ''}` +
    `${p.followers != null ? ' · ' + p.followers + ' followers' : ''}` +
    `${p.following != null ? ' · following ' + p.following : ''}` +
    `${p.created_at ? ' · joined ' + new Date(p.created_at).toLocaleDateString() : ''}`;
  const link = $('profileLink');
  if (p.html_url) {
    link.textContent = p.html_url;
    link.href = p.html_url;
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }
  return data;
}

function applySettingsToUI() {
  $('settingsInterval').value = String($('autoUpdateInterval').value || '60');
  $('settingsDefaultBranch').value = settingsDefaultBranch;
  $('settingsAutoSync').checked = $('autoSyncToggle').checked;
  $('settingsNotifications').checked = settingsNotifications;
  $('themeSetting').value = currentTheme; // v3.5.0
  updateNotifBadge();
}

async function saveSettings() {
  const intervalSeconds = Number($('settingsInterval').value) || 60;
  settingsDefaultBranch = $('settingsDefaultBranch').value.trim();
  settingsNotifications = !!$('settingsNotifications').checked;
  const autoSync = !!$('settingsAutoSync').checked;
  await chrome.storage.local.set({
    settingsDefaultBranch,
    settingsNotifications,
    autoUpdateInterval: intervalSeconds,
  });
  // v3.5.0: the theme select lives in Settings too.
  await setTheme($('themeSetting').value || 'light');
  $('autoUpdateInterval').value = String(intervalSeconds);
  $('settingsStatus').textContent = 'Settings saved ✓' +
    (settingsDefaultBranch ? ` — default branch for new file trees: ${settingsDefaultBranch}.` : '');
  updateNotifBadge();
  // Push interval + auto-sync to the bridge (same endpoint as the
  // auto-update bar); a missing bridge route just logs the error.
  try {
    await setAutoUpdateUI($('autoUpdateToggle').checked, intervalSeconds, autoSync);
  } catch (err) {
    log('Settings saved locally; could not push auto-update to the bridge: ' + err.message);
  }
}

/* ------------------------------------------------------------------ */
/* v3.0 — Local Git: cherry-pick / revert / reset, tags, local .zip   */
/* ------------------------------------------------------------------ */

async function cherryPickCommit() {
  const sha = $('cpSha').value.trim();
  if (!sha) throw new Error('Enter the commit SHA to cherry-pick');
  const res = await api('/api/git/cherry-pick', 'POST', { sha });
  $('cpSha').value = '';
  log('Cherry-picked ' + sha.slice(0, 7) + ' ✓');
  await status();
  await history();
  return res;
}

async function revertCommit() {
  const sha = $('cpSha').value.trim();
  if (!sha) throw new Error('Enter the commit SHA to revert');
  const res = await api('/api/git/revert', 'POST', { sha });
  $('cpSha').value = '';
  log('Reverted ' + sha.slice(0, 7) + ' ✓');
  await status();
  await history();
  return res;
}

async function resetBranch() {
  const mode = $('resetMode').value || 'mixed';
  const ref = $('resetRef').value.trim() || 'HEAD';
  if (mode === 'hard' && !$('resetHardConfirm').checked) {
    throw new Error('Hard reset discards uncommitted changes — tick the confirmation checkbox first.');
  }
  const res = await api('/api/git/reset', 'POST', { mode, ref, confirm: mode === 'hard' });
  $('resetHardConfirm').checked = false;
  log(`Reset (${mode}) to ${ref} ✓`);
  await status();
  await history();
  return res;
}

async function loadTags() {
  const data = await api('/api/git/tags');
  const container = $('tagList');
  const tags = data.tags || [];
  container.innerHTML = '';
  if (!tags.length) {
    container.className = 'empty';
    container.textContent = 'No tags yet.';
    return data;
  }
  container.className = '';
  for (const tag of tags) {
    const row = document.createElement('div');
    row.className = 'tag-row';
    const name = document.createElement('b');
    name.textContent = tag.name;
    const meta = document.createElement('span');
    meta.className = 'path';
    meta.textContent = tag.sha ? tag.sha.slice(0, 7) : '';
    const pushBtn = document.createElement('button');
    pushBtn.textContent = 'Push';
    pushBtn.onclick = () => run('Tag pushed', async () => {
      await api('/api/git/tag/push', 'POST', { name: tag.name });
      await loadTags();
    });
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.onclick = () => run('Tag deleted', async () => {
      if (!confirm(`Delete local tag ${tag.name}?`)) return;
      await api('/api/git/tag/delete', 'POST', { name: tag.name });
      await loadTags();
    });
    row.append(name, meta, pushBtn, delBtn);
    container.append(row);
  }
  return data;
}

async function createTag() {
  const name = $('newTagName').value.trim();
  if (!name) throw new Error('Enter a name for the new tag');
  const res = await api('/api/git/tag/create', 'POST', {
    name,
    message: $('newTagMessage').value.trim() || undefined,
    ref: $('newTagRef').value.trim() || undefined,
  });
  $('newTagName').value = '';
  $('newTagMessage').value = '';
  $('newTagRef').value = '';
  log(`Tag ${name} created ✓`);
  await loadTags();
  return res;
}

async function deleteTag() {
  const name = $('deleteTagName').value.trim();
  if (!name) throw new Error('Enter the tag to delete');
  if (!confirm(`Delete local tag ${name}?`)) return;
  await api('/api/git/tag/delete', 'POST', { name });
  $('deleteTagName').value = '';
  log(`Tag ${name} deleted ✓`);
  await loadTags();
}

async function pushTag() {
  const name = $('pushTagName').value.trim();
  if (!name) throw new Error('Enter the tag to push');
  const res = await api('/api/git/tag/push', 'POST', {
    name,
    remote: $('syncRemote').value.trim() || 'origin',
  });
  $('pushTagName').value = '';
  log(`Tag ${name} pushed ✓`);
  return res;
}

async function exportLocalZip() {
  const branch = $('branch').textContent && $('branch').textContent !== '—' ? $('branch').textContent : undefined;
  const repoName = $('repoName').textContent && $('repoName').textContent !== 'Not connected' ? $('repoName').textContent : 'repo';
  const filename = `${repoName}-${branch || 'HEAD'}.zip`;
  log(`Exporting local repository as ${filename}…`);
  const res = await downloadBlob('/api/git/archive-zip', 'POST', { ref: branch }, filename);
  log(`Exported ${res.filename} (${formatNumber(res.size)} B)`);
  return res;
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

$('navRepos').onclick = () => { showView(currentRepo ? 'repo' : 'repos'); };
$('navLocal').onclick = () => {
  showView('local');
  if (localConnected) {
    loadAheadBehind().catch(() => {});
    loadConflicts().catch(() => {});
    loadStashList().catch(() => {});
    loadRemotes().catch(() => {});
    loadDiffSummary().catch(() => {});
    loadTags().catch(() => {});
    loadPullOriginPanel().catch(() => {}); // v3.5.0
  }
};
// v3.5.0: Actions tab + theme toggle + command palette + real-login check.
$('navActions').onclick = () => {
  showView('actions');
  if (!currentRepo) {
    $('actionsRunsList').className = 'empty';
    $('actionsRunsList').textContent = 'Mở một repository để xem các lần chạy Actions.';
    return;
  }
  loadActionsWorkflows().then(() => loadActionsRuns()).catch((err) => log('ERROR: ' + err.message));
};
$('themeToggleBtn').onclick = () => run('Giao diện đã đổi', toggleTheme);
$('realLoginBtn').onclick = () => run('Kiểm tra đăng nhập thật', runRealLoginCheck);
$('paletteBtn').onclick = () => openPalette();
$('paletteCloseBtn').onclick = () => closePalette();
$('paletteInput').oninput = () => { paletteSelected = 0; renderPalette(); };
$('paletteInput').onkeydown = (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteSelected = Math.min(paletteItems.length - 1, paletteSelected + 1); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteSelected = Math.max(0, paletteSelected - 1); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); paletteRunSelected(); }
  else if (e.key === 'Escape') { closePalette(); }
};
$('paletteOverlay').onclick = (e) => { if (e.target === $('paletteOverlay')) closePalette(); };
if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('paletteOverlay').classList.contains('hidden')) openPalette();
    else closePalette();
  } else if (e.key === 'Escape' && !$('paletteOverlay').classList.contains('hidden')) {
    closePalette();
  }
});
// v3.5.0: Actions view wiring.
$('actionsRefreshBtn').onclick = () => run('Actions refreshed', async () => {
  await loadActionsWorkflows();
  await loadActionsRuns();
});
$('actionsWorkflowSelect').onchange = () => run('Actions refreshed', loadActionsRuns);
$('actionsStatusSelect').onchange = () => run('Actions refreshed', loadActionsRuns);
$('actionsBackBtn').onclick = () => {
  $('actionsRunDetail').classList.add('hidden');
  $('actionsRunsList').classList.remove('hidden');
  currentActionsRun = null;
};
$('actionsRerunBtn').onclick = () => run('Rerun requested', rerunActionsRun);
$('actionsCancelBtn').onclick = () => run('Cancel requested', cancelActionsRun);
$('actionsLogBtn').onclick = () => run('Log loaded', loadActionsLog);
// v3.5.0: repo pages wiring.
$('commitDetailBackBtn').onclick = () => { $('commitDetail').classList.add('hidden'); $('commitList').classList.remove('hidden'); };
$('compareBtn').onclick = () => run('Compare completed', runCompare);
$('fileBlameBtn').onclick = () => run('Blame loaded', () => showBlame(selectedFile));
$('fileHistoryBtn').onclick = () => run('File history loaded', () => showFileHistory(selectedFile));
$('blameBackBtn').onclick = () => { $('blameView').classList.add('hidden'); $('fileViewerWrap').classList.remove('hidden'); };
$('fileHistoryBackBtn').onclick = () => { $('fileHistoryView').classList.add('hidden'); $('fileViewerWrap').classList.remove('hidden'); };
$('prDetailBackBtn').onclick = () => { $('prDetail').classList.add('hidden'); $('pullList').classList.remove('hidden'); };
// v3.5.0: Pull Origin panel wiring.
$('pullOriginBtn').onclick = () => run('Pull Origin completed', doPullOrigin);
$('pullOriginAllBtn').onclick = () => run('Pull all remotes completed', doPullAllRemotes);
$('pullOriginRefreshBtn').onclick = () => run('Pull Origin refreshed', loadPullOriginPanel);
$('navProfile').onclick = () => {
  showView('profile');
  loadProfile().catch((err) => log('ERROR: ' + err.message));
};
$('navSettings').onclick = () => {
  showView('settings');
  applySettingsToUI();
};
$('backToRepos').onclick = () => { currentRepo = null; showView('repos'); };
$('reconnectBtn').onclick = () => run('Reconnect', reconnectNow);

// v3.6.0: one-click bridge start + auto-start preference. The manual
// flow (paste token, CONNECT BRIDGE) is untouched and keeps working
// when the host is not installed.
$('startBridgeBtn').onclick = () => run('Bridge started', startBridgeOnce);
$('autoStartBridge').onchange = async () => {
  await chrome.storage.local.set({ autoStartBridge: $('autoStartBridge').checked });
};

$('saveConnection').onclick = () => run('Connection saved', async () => {
  await chrome.storage.local.set({
    bridgeUrl: normalizeBase($('bridgeUrl').value),
    token: $('token').value.trim(),
  });
  stopEventStream();
  const ok = await health();
  if (!ok) throw new Error('Bridge not reachable at ' + normalizeBase($('bridgeUrl').value));
  startEventStream();
  await refreshGithubState();
  if (localConnected) await refreshAllLocal();
});

$('logoutBtn').onclick = () => run('Signed out', logoutGithub);

$('oauthConnectBtn').onclick = () => run('GitHub sign-in (OAuth Web)', startOAuthWeb);
$('oauthSaveBtn').onclick = () => run('OAuth App saved', saveOAuthConfig);
$('oauthCopyCallbackBtn').onclick = () => run('Callback URL copied', async () => {
  const url = $('oauthCallbackUrl').textContent.trim();
  if (!url || url === '—') throw new Error('Callback URL is not available yet — is the bridge reachable?');
  await navigator.clipboard.writeText(url);
});

$('loginPatBtn').onclick = () => run('GitHub sign-in', loginWithPat);
$('deviceFlowBtn').onclick = () => run('Device Flow started', startDeviceFlow);

// v3.0: live token-shape feedback while typing — an email or password
// pasted here gets the red warning immediately, before any request.
$('patInput').oninput = () => {
  const v = $('patInput').value.trim();
  if (!v) { $('patWarning').classList.add('hidden'); return; }
  if (looksLikeGithubToken(v)) {
    $('patWarning').classList.add('hidden');
  } else {
    $('patWarning').textContent = TOKEN_FORMAT_HINT;
    $('patWarning').classList.remove('hidden');
  }
};
$('diagBtn').onclick = () => run('Login diagnostics', loadLoginDiagnostics);
$('connDiagBtn').onclick = () => run('Connection diagnostics', runConnectionDiagnostics);
$('bridgeRetryBtn').onclick = () => run('Reconnect', reconnectNow);

$('globalSearch').oninput = () => { if (allRepos.length) renderRepos(); };
$('repoSearch').oninput = () => renderRepos();
$('repoFilter').onchange = () => renderRepos();
$('repoSort').onchange = () => renderRepos();

$('refreshRepos').onclick = () => run('Repositories refreshed', async () => {
  await loadRepos(false);
});
$('refreshReposForce').onclick = () => run('Repositories force-refreshed', async () => {
  await loadRepos(true);
});

$('autoUpdateToggle').onchange = () => run('Auto-update setting saved', async () => {
  const enabled = $('autoUpdateToggle').checked;
  const intervalSeconds = Number($('autoUpdateInterval').value) || 60;
  await setAutoUpdateUI(enabled, intervalSeconds);
});
$('autoSyncToggle').onchange = () => run('Auto-sync setting saved', async () => {
  if (!$('autoUpdateToggle').checked) throw new Error('Enable Auto-update first — auto-sync only runs as part of it.');
  const intervalSeconds = Number($('autoUpdateInterval').value) || 60;
  await setAutoUpdateUI(true, intervalSeconds, $('autoSyncToggle').checked);
});
$('autoUpdateInterval').onchange = () => run('Auto-update interval saved', async () => {
  const intervalSeconds = Number($('autoUpdateInterval').value) || 60;
  await setAutoUpdateUI($('autoUpdateToggle').checked, intervalSeconds);
});
$('manualRefresh').onclick = () => run('Manual refresh', async () => {
  const res = await gh('/refresh', 'POST', {});
  if (res.updated && res.updated.length) {
    log(`Manual refresh: ${res.updated.length} repo(s) updated — ${res.updated.map((u) => u.repo + '@' + u.newSha).join(', ')}`);
    await loadRepos(false);
  } else {
    log(`Manual refresh: ${res.checked || 0} repo(s) checked, no new commits.`);
  }
  await loadAutoUpdateStatus();
});

document.querySelectorAll('.tabs button').forEach((button) => {
  button.onclick = () => {
    const tab = button.dataset.tab;
    showRepoTab(tab);
    if (tab === 'commits') loadRepoCommits().catch((err) => log('ERROR: ' + err.message));
    if (tab === 'branches') loadRepoBranches().catch((err) => log('ERROR: ' + err.message));
    if (tab === 'issues') loadRepoIssues().catch((err) => log('ERROR: ' + err.message));
    if (tab === 'pulls') loadRepoPulls().catch((err) => log('ERROR: ' + err.message));
    if (tab === 'releases') loadReleases().catch((err) => log('ERROR: ' + err.message));
    if (tab === 'files') loadFileTree(currentPath).catch((err) => log('ERROR: ' + err.message));
    if (tab === 'overview') loadReadme().catch((err) => log('ERROR: ' + err.message));
  };
});

// v3.0 — repo detail actions + create repo + releases + code search.
$('createRepoBtn').onclick = () => run('Repository created', createRepo);
$('repoZipBtn').onclick = () => run('Repository .zip downloaded', downloadCurrentRepoZip);
$('repoStarBtn').onclick = () => run('Repository starred', starRepo);
$('repoUnstarBtn').onclick = () => run('Repository unstarred', unstarRepo);
$('repoForkBtn').onclick = () => run('Repository forked', forkRepo);
$('repoEditDescBtn').onclick = () => run('Description updated', editRepoDescription);
$('repoDeleteBtn').onclick = () => run('Repository deleted', deleteRepo);
$('reloadReleases').onclick = () => run('Releases refreshed', loadReleases);
$('createReleaseBtn').onclick = () => run('Release created', createRelease);
$('codeSearchBtn').onclick = () => run('Code search', searchCode);
$('fileSaveBtn').onclick = () => run('File saved', saveEditedFile);
$('newFileBtn').onclick = () => run('File created', createNewFile);
$('fileDeleteBtn').onclick = () => run('File deleted', deleteCurrentFile);
$('fileUploadInput').onchange = () => run('File uploaded', async () => {
  const input = $('fileUploadInput');
  const file = input.files && input.files[0];
  await uploadFileToRepo(file);
  input.value = '';
});
$('createIssueBtn').onclick = () => run('Issue created', createIssue);
$('issueDetailBackBtn').onclick = () => { $('issueDetail').classList.add('hidden'); $('issueList').classList.remove('hidden'); };
$('addCommentBtn').onclick = () => run('Comment added', addIssueComment);
$('issueCloseBtn').onclick = () => run('Issue state changed', toggleIssueState);
$('createPrBtn').onclick = () => run('Pull request created', createPullRequest);

// v3.0 — notifications bell + profile + settings.
$('notifBtn').onclick = () => {
  const panel = $('notifPanel');
  const willShow = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !willShow);
  if (willShow) loadNotifications().catch((err) => log('ERROR: ' + err.message));
};
$('notifMarkReadBtn').onclick = () => run('Notifications marked as read', markAllNotificationsRead);
$('notifCloseBtn').onclick = () => $('notifPanel').classList.add('hidden');
$('reloadProfile').onclick = () => run('Profile refreshed', loadProfile);
$('saveSettingsBtn').onclick = () => run('Settings saved', saveSettings);

// v3.0 — local git: cherry-pick / revert / reset, tags, local .zip.
$('localZipBtn').onclick = () => run('Local repository exported as .zip', exportLocalZip);
$('cherryPickBtn').onclick = () => run('Cherry-pick completed', cherryPickCommit);
$('revertBtn').onclick = () => run('Revert completed', revertCommit);
$('resetBtn').onclick = () => run('Reset completed', resetBranch);
$('refreshTagsBtn').onclick = () => run('Tags refreshed', loadTags);
$('createTagBtn').onclick = () => run('Tag created', createTag);
$('deleteTagBtn').onclick = () => run('Tag deleted', deleteTag);
$('pushTagBtn').onclick = () => run('Tag pushed', pushTag);

$('reloadCommits').onclick = () => run('Commits refreshed', loadRepoCommits);
$('reloadBranches').onclick = () => run('Branches refreshed', loadRepoBranches);
$('reloadIssues').onclick = () => run('Issues refreshed', loadRepoIssues);
$('reloadPulls').onclick = () => run('Pull requests refreshed', loadRepoPulls);
$('fileBranchSelect').onchange = () => run('Branch file tree', () => loadFileTree(''));
$('fileUpBtn').onclick = () => run('Up one folder', () => {
  const parts = currentPath.split('/').filter(Boolean);
  parts.pop();
  return loadFileTree(parts.join('/'));
});

$('connectRepo').onclick = () => run('Repository connected', async () => {
  const path = $('repoPath').value.trim();
  if (!path) throw new Error('Enter the full path to a local Git repository');
  const data = await api('/api/repo/select', 'POST', { path });
  if (data.repository) $('repoPath').value = data.repository.path;
  await refreshAllLocal();
});

$('refreshStatus').onclick = () => run('Status refreshed', status);

$('stageAll').onclick = () => run('All changes staged', async () => {
  await api('/api/git/stage-all', 'POST', {});
  await status();
});

$('unstageAll').onclick = () => run('All changes unstaged', async () => {
  const data = await api('/api/git/status');
  const staged = (data.files || []).filter((f) => f.staged);
  if (!staged.length) throw new Error('Nothing is staged');
  for (const file of staged) {
    await api('/api/git/unstage', 'POST', { path: file.path });
  }
  await status();
});

$('commit').onclick = () => run('Commit created', async () => {
  const summary = $('summary').value.trim();
  if (!summary) throw new Error('Commit summary is required');
  await api('/api/git/commit', 'POST', {
    summary,
    description: $('description').value.trim(),
    amend: $('amendCommit').checked,
    all: $('commitAll').checked,
  });
  $('summary').value = '';
  $('description').value = '';
  $('amendCommit').checked = false;
  await status();
  await history();
});

// v2.1: full Push / Pull / Sync — the old loop only sent {} and Pull was
// fast-forward only. Pull now honours the selected mode; Push honours
// set-upstream / force (double opt-in) / push-all / tags.
$('fetch').onclick = () => run('Fetch completed', doFetch);
$('pull').onclick = () => run('Pull completed', doPull);
$('push').onclick = () => run('Push completed', doPush);
$('syncBtn').onclick = () => run('Sync completed', doSync);
$('pushAllBtn').onclick = () => run('Push all branches completed', () => doPush({ pushAll: true }));
$('pushTagsBtn').onclick = () => run('Push tags completed', () => doPush({ tags: true }));
$('pushDryRunBtn').onclick = () => run('Push dry-run completed', () => doPush({ dryRun: true }));
$('pullPreviewBtn').onclick = () => run('Pull preview ready', doPullPreview);
$('pushPreviewBtn').onclick = () => run('Push preview ready', doPushPreview);
$('pullAllBtn').onclick = () => run('Pull all branches completed', doPullAllBranches);
$('undoPullBtn').onclick = () => run('Undo pull completed', doUndoPull);
$('rebaseContinueBtn').onclick = () => run('Rebase continue', () => doRebase('continue'));
$('rebaseSkipBtn').onclick = () => run('Rebase skip', () => doRebase('skip'));
$('rebaseAbortBtn').onclick = () => run('Rebase abort', () => doRebase('abort'));
$('historyReloadBtn').onclick = () => run('History refreshed', loadSyncHistory);
$('historyClearBtn').onclick = () => run('History cleared', async () => { await api('/api/git/sync-history/clear', 'POST', {}); await loadSyncHistory(); });
$('forcePushCheck').onchange = () => {
  $('forceConfirmCheck').disabled = !$('forcePushCheck').checked;
  if (!$('forcePushCheck').checked) $('forceConfirmCheck').checked = false;
};

$('switchBranch').onclick = () => run('Branch switched', async () => {
  const branch = $('branchSelect').value;
  if (!branch) throw new Error('Select a branch first');
  await api('/api/git/checkout', 'POST', { branch });
  await refreshAllLocal();
});

$('loadHistory').onclick = () => run('History refreshed', () => history(1));
$('historyPrevBtn').onclick = () => run('History refreshed', () => history(historyPage - 1));
$('historyNextBtn').onclick = () => run('History refreshed', () => history(historyPage + 1));

$('refreshBranchesBtn').onclick = () => run('Branches refreshed', branches);
$('createBranchBtn').onclick = () => run('Branch created', createBranch);
$('renameBranchBtn').onclick = () => run('Branch renamed', renameBranch);
$('deleteBranchBtn').onclick = () => run('Branch deleted', deleteBranch);

$('mergeBtn').onclick = () => run('Merge completed', mergeBranch);
$('refreshConflictsBtn').onclick = () => run('Conflicts refreshed', loadConflicts);
$('abortMergeBtn').onclick = () => run('Merge aborted', async () => {
  await api('/api/git/merge/abort', 'POST', {});
  await loadConflicts();
  await status();
});
$('commitMergeBtn').onclick = () => run('Merge committed', commitMerge);

$('createStashBtn').onclick = () => run('Stash created', createStash);
$('refreshStashBtn').onclick = () => run('Stash list refreshed', loadStashList);

$('refreshRemotesBtn').onclick = () => run('Remotes refreshed', loadRemotes);
$('addRemoteBtn').onclick = () => run('Remote added', async () => {
  const name = $('newRemoteName').value.trim();
  const url = $('newRemoteUrl').value.trim();
  if (!name || !url) throw new Error('Enter both a remote name and a URL');
  await api('/api/git/remote/add', 'POST', { name, url });
  $('newRemoteName').value = '';
  $('newRemoteUrl').value = '';
  await loadRemotes();
});
$('setUrlRemoteBtn').onclick = () => run('Remote URL updated', async () => {
  const name = $('setUrlRemoteName').value.trim();
  const url = $('setUrlRemoteUrl').value.trim();
  if (!name || !url) throw new Error('Enter both a remote name and the new URL');
  await api('/api/git/remote/set-url', 'POST', { name, url });
  $('setUrlRemoteName').value = '';
  $('setUrlRemoteUrl').value = '';
  await loadRemotes();
});

$('cloneBtn').onclick = () => run('Clone completed', cloneRepo);

$('copyPath').onclick = () => run('Repository path copied', async () => {
  const path = $('repoPath').value.trim();
  if (!path) throw new Error('Connect a repository first');
  await navigator.clipboard.writeText(path);
});

/* ------------------------------------------------------------------ */
/* v3.5.0 — Dashboard: Actions tab, repo pages, command palette,      */
/* Primer dark theme toggle, Pull Origin panel, real-login check.      */
/* API contract (bridge workstream, do not change the paths):          */
/*   GET  /api/github/actions/workflows?owner=&repo=                   */
/*   GET  /api/github/actions/runs?owner=&repo=&workflow_id=&status=  */
/*        &branch=                                                     */
/*   GET  /api/github/actions/runs/:id?owner=&repo=                    */
/*   POST /api/github/actions/runs/:id/rerun {owner,repo}              */
/*   POST /api/github/actions/runs/:id/cancel {owner,repo}             */
/*   GET  /api/github/actions/runs/:id/jobs?owner=&repo=               */
/*   GET  /api/github/actions/runs/:id/logs?owner=&repo= -> {ok, log}  */
/*   GET  /api/github/repos/:o/:r/commits/:sha                         */
/*   GET  /api/git/blame?path=&ref=                                    */
/*   GET  /api/git/file-history?path=                                  */
/*   GET  /api/github/repos/:o/:r/compare/:base...:head                 */
/*   GET  /api/github/repos/:o/:r/languages, /contributors, /topics    */
/*   GET  /api/github/repos/:o/:r/issues/:n -> {issue, comments}       */
/*   POST /api/github/repos/:o/:r/issues/:n/comments {body}            */
/*   GET  /api/github/repos/:o/:r/pulls/:n, /files, /reviews           */
/*   GET  /api/git/pull/remotes (POST {mode, autostash})               */
/*   GET  /api/git/upstream, /api/git/worktrees,                       */
/*        POST /api/git/worktree/add|remove, GET /api/git/graph?limit= */
/*   GET  /api/github/user/emails -> {ok, emails:[{email, primary,    */
/*        verified}]}                                                  */
/* All errors are shown in Vietnamese inside the view, never alert(). */
/* ------------------------------------------------------------------ */

const EXPECTED_ACCOUNT_EMAIL = 'nguyenvu16592b@gmail.com';
let currentTheme = 'light'; // 'light' (default) | 'dark'
let actionsWorkflows = [];
let actionsRuns = [];
let currentActionsRun = null; // { id, owner, repo }
let currentCommitSha = null;
let paletteItems = [];
let paletteSelected = 0;

/* ---------------- Theme (Primer dark toggle) ---------------- */

// Apply a theme: data-theme="dark" on <html> (the base stylesheet is
// the Primer dark palette); anything else means the light theme.
// Persists in chrome.storage.local under key `theme`.
function applyTheme(theme) {
  currentTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', currentTheme);
  const toggle = $('themeToggleBtn');
  if (toggle) toggle.textContent = currentTheme === 'dark' ? '☀️' : '🌙';
  const sel = $('themeSetting');
  if (sel) sel.value = currentTheme;
}

async function loadStoredTheme() {
  try {
    const s = await chrome.storage.local.get({ theme: 'light' });
    applyTheme(s.theme || 'light');
  } catch (_) {
    applyTheme('light');
  }
}

async function setTheme(theme) {
  applyTheme(theme);
  try { await chrome.storage.local.set({ theme: currentTheme }); } catch (_) {}
  log('Giao diện: ' + (currentTheme === 'dark' ? 'tối (Primer dark)' : 'sáng') + '.');
}

function toggleTheme() {
  return setTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

// Apply the stored theme as early as the load order allows (the inline
// <script> in dashboard.html <head> already tried before first paint).
loadStoredTheme().catch(() => {});

/* ---------------- Safe markdown renderer (no external libs) ---------------- */

// escapeHtml: every bit of user/markdown text goes through this first,
// so a README containing <script> can never become live markup.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeLinkUrl(url) {
  const u = String(url || '').trim();
  if (/^https?:\/\//i.test(u) || u.startsWith('#') || u.startsWith('/')) return u;
  return '#';
}

// Inline markup on already-escaped text: `code`, **bold**, *italic*,
// [text](url). The inserted tags are ours; the text inside was escaped.
function mdInline(escapedText) {
  let out = escapedText;
  out = out.replace(/`([^`]+)`/g, (m, code) => '<code>' + code + '</code>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+(?:\([^)\s]*\)[^)\s]*)*)\)/g, (m, text, url) =>
    '<a href="' + escapeHtml(safeLinkUrl(url)) + '" target="_blank" rel="noopener">' + text + '</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return out;
}

// Block markdown: headings, fenced code blocks, lists, tables, paragraphs.
function renderMarkdown(md) {
  const text = String(md || '');
  const lines = text.split('\n');
  const codeBlocks = [];
  // Pull fenced code blocks out first so nothing inside is parsed.
  let body = '';
  let inFence = false;
  let fenceBuf = [];
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (!inFence) { inFence = true; fenceBuf = []; }
      else {
        inFence = false;
        codeBlocks.push(fenceBuf.join('\n'));
        body += '\n@@CODE' + (codeBlocks.length - 1) + '@@\n';
      }
      continue;
    }
    if (inFence) fenceBuf.push(line);
    else body += line + '\n';
  }
  if (inFence) { // unterminated fence — treat the rest as a code block
    codeBlocks.push(fenceBuf.join('\n'));
    body += '\n@@CODE' + (codeBlocks.length - 1) + '@@\n';
  }

  const out = [];
  const bl = body.split('\n');
  let i = 0;
  while (i < bl.length) {
    const line = bl[i];
    if (!line.trim()) { i += 1; continue; }
    const codeMatch = line.match(/^@@CODE(\d+)@@$/);
    if (codeMatch) {
      out.push('<pre><code>' + escapeHtml(codeBlocks[Number(codeMatch[1])] || '') + '</code></pre>');
      i += 1;
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      out.push('<h' + h[1].length + '>' + mdInline(escapeHtml(h[2].trim())) + '</h' + h[1].length + '>');
      i += 1;
      continue;
    }
    // Table: header row + separator row (| --- |) + body rows.
    if (/^\|.*\|$/.test(line.trim()) && bl[i + 1] && /^\|[\s:|-]+\|$/.test(bl[i + 1].trim())) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      let html = '<table><thead><tr>' + head.map((c) => '<th>' + mdInline(escapeHtml(c)) + '</th>').join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < bl.length && /^\|.*\|$/.test(bl[i].trim())) {
        html += '<tr>' + cells(bl[i]).map((c) => '<td>' + mdInline(escapeHtml(c)) + '</td>').join('') + '</tr>';
        i += 1;
      }
      out.push(html + '</tbody></table>');
      continue;
    }
    // Unordered / ordered list (consecutive lines).
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const tag = ordered ? 'ol' : 'ul';
      let html = '<' + tag + '>';
      while (i < bl.length && (ordered ? /^\s*\d+\.\s+/.test(bl[i]) : /^\s*[-*]\s+/.test(bl[i]))) {
        const item = bl[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, '');
        html += '<li>' + mdInline(escapeHtml(item)) + '</li>';
        i += 1;
      }
      out.push(html + '</' + tag + '>');
      continue;
    }
    out.push('<p>' + mdInline(escapeHtml(line.trim())) + '</p>');
    i += 1;
  }
  return out.join('\n') || '<p>(README trống)</p>';
}

/* ---------------- Real-login check ---------------- */

// Runs login/diagnostics + /api/github/user + /api/github/user/emails
// and shows login, avatar and the primary email. Warns clearly when
// the primary email is NOT nguyenvu16592b@gmail.com. Never asks for or
// displays any password / token / secret.
async function runRealLoginCheck() {
  const statusEl = $('realLoginStatus');
  const resultEl = $('realLoginResult');
  const warnEl = $('realLoginWarning');
  const okEl = $('realLoginOk');
  resultEl.classList.add('hidden');
  warnEl.classList.add('hidden');
  okEl.classList.add('hidden');
  statusEl.textContent = 'Đang kiểm tra…';
  try {
    await loadLoginDiagnostics().catch(() => {});
    let me;
    try { me = await gh('/user'); } catch (_) { me = await gh('/me'); }
    const user = (me && me.user) || me || null;
    if (!me || (me.authed === false) || !user || !user.login) {
      statusEl.textContent = 'Chưa đăng nhập GitHub — đăng nhập bằng 1 trong 3 cách bên dưới rồi bấm kiểm tra lại.';
      return null;
    }
    let emails = [];
    try {
      const res = await gh('/user/emails');
      emails = (res && res.emails) || [];
    } catch (err) {
      statusEl.textContent = 'Đã đăng nhập nhưng không lấy được danh sách email (' + err.message + '). Bridge cần bản v3.5.0 cho route /user/emails.';
    }
    const primary = emails.find((e) => e.primary) || emails.find((e) => e.verified) || emails[0] || null;
    const primaryEmail = (primary && primary.email) || user.email || '';
    $('realLoginAvatar').src = user.avatar_url || '';
    $('realLoginAvatar').alt = user.login;
    $('realLoginName').textContent = user.login + (user.name && user.name !== user.login ? ' (' + user.name + ')' : '');
    $('realLoginEmail').textContent = primaryEmail ? 'Email chính: ' + primaryEmail : 'Không lấy được email chính.';
    resultEl.classList.remove('hidden');
    if (!primaryEmail) {
      statusEl.textContent = 'Đã đăng nhập với tên ' + user.login + ' nhưng chưa xác định được email chính.';
      return { user, emails };
    }
    if (primaryEmail.toLowerCase() !== EXPECTED_ACCOUNT_EMAIL.toLowerCase()) {
      warnEl.textContent = '⚠️ CẢNH BÁO: email chính của tài khoản đang đăng nhập là ' + primaryEmail +
        ' — KHÔNG phải ' + EXPECTED_ACCOUNT_EMAIL + '. Bạn đang đăng nhập sai tài khoản GitHub. Hãy đăng xuất rồi đăng nhập lại bằng tài khoản có email ' + EXPECTED_ACCOUNT_EMAIL + '.';
      warnEl.classList.remove('hidden');
      statusEl.textContent = 'Đã kiểm tra xong — thấy email khác với tài khoản mong đợi, xem cảnh báo bên dưới.';
    } else {
      okEl.classList.remove('hidden');
      statusEl.textContent = 'Đã kiểm tra xong — đúng tài khoản ' + EXPECTED_ACCOUNT_EMAIL + '.';
    }
    return { user, emails };
  } catch (err) {
    statusEl.textContent = 'Không kiểm tra được: ' + err.message;
    return null;
  }
}

/* ---------------- GitHub Actions ---------------- */

function actionsRepo() {
  return currentRepo; // { owner, repo, full_name, default_branch } or null
}

function runStatusBadge(conclusion, status) {
  const key = String(conclusion || status || '').toLowerCase();
  const label = conclusion || status || '—';
  const cls = key === 'success' ? 'success'
    : key === 'failure' || key === 'failed' ? 'failure'
    : key === 'cancelled' || key === 'skipped' ? 'cancelled'
    : 'pending'; // pending / in_progress / queued / waiting → vàng
  const badge = document.createElement('span');
  badge.className = 'run-badge ' + cls;
  badge.textContent = label;
  return badge;
}

async function loadActionsWorkflows() {
  const repo = actionsRepo();
  const select = $('actionsWorkflowSelect');
  select.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'Tất cả workflow';
  select.append(all);
  if (!repo) { actionsWorkflows = []; return []; }
  try {
    const res = await gh(`/actions/workflows?owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}`);
    actionsWorkflows = res.workflows || [];
    for (const w of actionsWorkflows) {
      const opt = document.createElement('option');
      opt.value = String(w.id);
      opt.textContent = w.name || w.path || ('workflow ' + w.id);
      select.append(opt);
    }
  } catch (err) {
    log('ERROR: ' + err.message);
    throw err;
  }
  return actionsWorkflows;
}

async function loadActionsRuns() {
  const repo = actionsRepo();
  const list = $('actionsRunsList');
  const detail = $('actionsRunDetail');
  detail.classList.add('hidden');
  currentActionsRun = null;
  if (!repo) {
    list.className = 'empty';
    list.textContent = 'Mở một repository để xem các lần chạy Actions.';
    return [];
  }
  list.className = '';
  list.textContent = 'Đang tải các lần chạy…';
  let res;
  try {
    const workflowId = $('actionsWorkflowSelect').value;
    const status = $('actionsStatusSelect').value;
    let path = `/actions/runs?owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}`;
    if (workflowId) path += '&workflow_id=' + encodeURIComponent(workflowId);
    if (status) path += '&status=' + encodeURIComponent(status);
    res = await gh(path);
  } catch (err) {
    list.className = 'empty';
    list.textContent = 'Không tải được các lần chạy Actions: ' + err.message + ' (cần bridge v3.5.0 cho route /actions/runs).';
    return [];
  }
  actionsRuns = res.runs || res.workflow_runs || [];
  list.textContent = '';
  if (!actionsRuns.length) {
    list.className = 'empty';
    list.textContent = 'Chưa có lần chạy Actions nào cho repo này.';
    return [];
  }
  for (const run of actionsRuns) {
    const row = document.createElement('button');
    row.className = 'run-row';
    const name = document.createElement('span');
    name.className = 'rname';
    name.textContent = (run.name || run.display_title || run.workflow_name || 'run') + ' #' + (run.run_number || run.id);
    const meta = document.createElement('span');
    meta.className = 'rmeta';
    meta.textContent = (run.head_branch || run.branch || '') + ' · ' + timeAgo(run.created_at || run.updated_at);
    row.append(name, runStatusBadge(run.conclusion, run.status), meta);
    row.onclick = () => showActionsRun(run.id).catch((err) => log('ERROR: ' + err.message));
    list.append(row);
  }
  return actionsRuns;
}

async function showActionsRun(id) {
  const repo = actionsRepo();
  if (!repo) return;
  const list = $('actionsRunsList');
  const detail = $('actionsRunDetail');
  list.classList.add('hidden');
  detail.classList.remove('hidden');
  $('actionsLogWrap').classList.add('hidden');
  $('actionsLogPre').textContent = 'Chưa tải log.';
  $('actionsJobsList').className = 'empty';
  $('actionsJobsList').textContent = 'Đang tải jobs…';
  currentActionsRun = { id, owner: repo.owner, repo: repo.repo };
  let run;
  try {
    const res = await gh(`/actions/runs/${encodeURIComponent(id)}?owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}`);
    run = res.run || res;
  } catch (err) {
    $('actionsRunTitle').textContent = 'Run #' + id;
    $('actionsRunMeta').textContent = 'Không tải được chi tiết run: ' + err.message;
    return null;
  }
  $('actionsRunTitle').textContent = (run.name || run.display_title || 'Run') + ' #' + (run.run_number || run.id);
  $('actionsRunMeta').textContent =
    `${run.head_branch || run.branch || ''} · ${run.head_sha ? String(run.head_sha).slice(0, 7) : ''} · ${run.event || ''} · ` +
    `tạo ${timeAgo(run.created_at)} · ${run.actor ? run.actor.login || run.actor : ''}`;
  const jobsBox = $('actionsJobsList');
  try {
    const res = await gh(`/actions/runs/${encodeURIComponent(id)}/jobs?owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}`);
    const jobs = res.jobs || [];
    jobsBox.textContent = '';
    if (!jobs.length) {
      jobsBox.className = 'empty';
      jobsBox.textContent = 'Run này chưa có job nào.';
    } else {
      jobsBox.className = '';
      for (const job of jobs) {
        const row = document.createElement('div');
        row.className = 'job-row';
        const name = document.createElement('span');
        name.className = 'path';
        name.textContent = job.name || ('job ' + job.id);
        row.append(name, runStatusBadge(job.conclusion, job.status));
        jobsBox.append(row);
      }
    }
  } catch (err) {
    jobsBox.className = 'empty';
    jobsBox.textContent = 'Không tải được jobs: ' + err.message;
  }
  return run;
}

async function rerunActionsRun() {
  if (!currentActionsRun) return;
  const { id, owner, repo } = currentActionsRun;
  const res = await gh(`/actions/runs/${encodeURIComponent(id)}/rerun`, 'POST', { owner, repo });
  log('Đã yêu cầu rerun cho run #' + id + '.');
  await showActionsRun(id);
  return res;
}

async function cancelActionsRun() {
  if (!currentActionsRun) return;
  if (!confirm('Huỷ run Actions này?')) return null;
  const { id, owner, repo } = currentActionsRun;
  const res = await gh(`/actions/runs/${encodeURIComponent(id)}/cancel`, 'POST', { owner, repo });
  log('Đã yêu cầu huỷ run #' + id + '.');
  await showActionsRun(id);
  return res;
}

async function loadActionsLog() {
  if (!currentActionsRun) return;
  const { id, owner, repo } = currentActionsRun;
  const wrap = $('actionsLogWrap');
  const pre = $('actionsLogPre');
  wrap.classList.remove('hidden');
  pre.textContent = 'Đang tải log…';
  try {
    const res = await gh(`/actions/runs/${encodeURIComponent(id)}/logs?owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}`);
    const text = res.log || '';
    const MAX_LOG = 200000;
    pre.textContent = text.length > MAX_LOG
      ? text.slice(0, MAX_LOG) + '\n\n… log đã cắt ở ' + MAX_LOG + ' ký tự …'
      : (text || '(Log trống)');
  } catch (err) {
    pre.textContent = 'Không tải được log: ' + err.message;
  }
}

/* ---------------- Repo pages (extend the existing repo view) ---------------- */

// README rendered (markdown) below the file list, root folder only.
async function renderFileReadme() {
  const wrap = $('fileReadmeWrap');
  if (!currentRepo || currentPath) { wrap.classList.add('hidden'); return; }
  try {
    const res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/readme`);
    $('fileReadmeName').textContent = res.name || '';
    $('fileReadmeRendered').innerHTML = renderMarkdown(res.content || '');
    wrap.classList.remove('hidden');
  } catch (_) {
    wrap.classList.add('hidden');
  }
}

// Commit detail: sha, message, author, stats, changed files with +/-.
async function showCommitDetail(sha) {
  if (!currentRepo) return;
  currentCommitSha = sha;
  const detail = $('commitDetail');
  const list = $('commitList');
  list.classList.add('hidden');
  detail.classList.remove('hidden');
  $('commitDetailTitle').textContent = 'Commit ' + String(sha).slice(0, 7);
  $('commitDetailMeta').textContent = 'Đang tải…';
  $('commitDetailStats').textContent = '';
  const filesBox = $('commitDetailFiles');
  filesBox.className = 'empty';
  filesBox.textContent = 'Đang tải file thay đổi…';
  let res;
  try {
    res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/commits/${encodeURIComponent(sha)}`);
  } catch (err) {
    $('commitDetailMeta').textContent = 'Không tải được commit: ' + err.message;
    filesBox.textContent = 'Không tải được file thay đổi: ' + err.message;
    return null;
  }
  const c = res.commit || res;
  $('commitDetailTitle').textContent = String(c.sha || sha).slice(0, 7) + ' · ' + (c.message || c.commitMessage || '').split('\n')[0];
  $('commitDetailMeta').textContent =
    `${c.author || (c.authorInfo && c.authorInfo.name) || 'unknown'} · ` +
    `${c.date ? new Date(c.date).toLocaleString() : ''} · SHA ${c.sha || sha}`;
  const stats = c.stats || {};
  $('commitDetailStats').textContent =
    `Tổng: +${stats.additions || 0} −${stats.deletions || 0} · ${(c.files || []).length} file thay đổi`;
  const files = c.files || [];
  filesBox.textContent = '';
  if (!files.length) {
    filesBox.className = 'empty';
    filesBox.textContent = 'Commit này không đổi file nào (hoặc bridge chưa trả về danh sách file).';
  } else {
    filesBox.className = '';
    for (const f of files) {
      const row = document.createElement('div');
      row.className = 'commititem';
      const title = document.createElement('b');
      title.textContent = f.filename || f.path || '';
      const meta = document.createElement('small');
      meta.textContent = `+${f.additions || 0} −${f.deletions || 0} · ${f.status || ''}`;
      row.append(title, meta);
      filesBox.append(row);
    }
  }
  return c;
}

// Compare base...head: files changed + diff stats.
async function runCompare() {
  const base = $('compareBase').value.trim();
  const head = $('compareHead').value.trim();
  const box = $('compareResult');
  box.classList.remove('hidden');
  if (!currentRepo) { box.textContent = 'Mở một repository trước.'; return; }
  if (!base || !head) { box.textContent = 'Nhập cả Base và Head để so sánh.'; return; }
  box.className = 'empty';
  box.textContent = 'Đang so sánh…';
  let res;
  try {
    res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  } catch (err) {
    box.textContent = 'Không so sánh được: ' + err.message;
    return null;
  }
  const files = res.files || [];
  const ahead = res.ahead_by != null ? res.ahead_by : (res.aheadBy || 0);
  const behind = res.behind_by != null ? res.behind_by : (res.behindBy || 0);
  box.className = '';
  box.textContent = '';
  const headEl = document.createElement('div');
  headEl.className = 'commititem';
  const title = document.createElement('b');
  title.textContent = `${base}...${head} — ahead ${ahead} · behind ${behind} · ${files.length} file thay đổi`;
  const meta = document.createElement('small');
  meta.textContent = res.status || '';
  headEl.append(title, meta);
  box.append(headEl);
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'commititem';
    const t = document.createElement('b');
    t.textContent = f.filename || f.path || '';
    const m = document.createElement('small');
    m.textContent = `+${f.additions || 0} −${f.deletions || 0} · ${f.status || ''}`;
    row.append(t, m);
    box.append(row);
  }
  return res;
}

// Blame view: per-line author + date + line number.
async function showBlame(relPath) {
  if (!currentRepo && !localConnected) return;
  const branch = $('fileBranchSelect').value || (currentRepo && currentRepo.default_branch) || '';
  const box = $('blameContent');
  $('fileViewerWrap').classList.add('hidden');
  $('fileHistoryView').classList.add('hidden');
  $('blameView').classList.remove('hidden');
  $('blameFileName').textContent = 'Blame — ' + relPath;
  box.textContent = 'Đang tải blame…';
  let res;
  try {
    res = await api('/api/git/blame?path=' + encodeURIComponent(relPath) + (branch ? '&ref=' + encodeURIComponent(branch) : ''));
  } catch (err) {
    box.textContent = 'Không tải được blame: ' + err.message + ' (cần repo local đã kết nối và bridge v3.5.0).';
    return null;
  }
  const lines = res.lines || res.blame || [];
  box.textContent = '';
  if (!lines.length) {
    box.textContent = 'Không có dòng blame nào cho file này.';
    return res;
  }
  for (const ln of lines) {
    const row = document.createElement('div');
    row.className = 'blame-line';
    const num = document.createElement('span');
    num.className = 'bl-num';
    num.textContent = String(ln.line || ln.number || '');
    const author = document.createElement('span');
    author.className = 'bl-author';
    author.textContent = ln.author || ln.name || '—';
    const date = document.createElement('span');
    date.className = 'bl-date';
    date.textContent = ln.date ? timeAgo(ln.date) : '';
    const content = document.createElement('span');
    content.textContent = ln.content || ln.text || '';
    row.append(num, author, date, content);
    box.append(row);
  }
  return res;
}

// File history view (local git).
async function showFileHistory(relPath) {
  const box = $('fileHistoryList');
  $('fileViewerWrap').classList.add('hidden');
  $('blameView').classList.add('hidden');
  $('fileHistoryView').classList.remove('hidden');
  $('fileHistoryName').textContent = 'Lịch sử — ' + relPath;
  box.className = 'empty';
  box.textContent = 'Đang tải lịch sử file…';
  let res;
  try {
    res = await api('/api/git/file-history?path=' + encodeURIComponent(relPath));
  } catch (err) {
    box.textContent = 'Không tải được lịch sử file: ' + err.message + ' (cần repo local đã kết nối và bridge v3.5.0).';
    return null;
  }
  const commits = res.commits || res.history || [];
  box.textContent = '';
  if (!commits.length) {
    box.className = 'empty';
    box.textContent = 'File này chưa có lịch sử commit nào.';
    return res;
  }
  box.className = '';
  for (const c of commits) {
    const row = document.createElement('div');
    row.className = 'commititem';
    const title = document.createElement('b');
    title.textContent = (c.sha || c.hash || '').slice(0, 7) + ' · ' + (c.subject || c.message || '');
    const meta = document.createElement('small');
    meta.textContent = (c.author || 'unknown') + ' · ' + (c.date ? new Date(c.date).toLocaleString() : timeAgo(c.date));
    row.append(title, meta);
    box.append(row);
  }
  return res;
}

// PR detail: title, state, author, files, reviews.
async function showPrDetail(number) {
  if (!currentRepo) return;
  const detail = $('prDetail');
  const list = $('pullList');
  list.classList.add('hidden');
  detail.classList.remove('hidden');
  $('prDetailTitle').textContent = 'PR #' + number;
  $('prDetailMeta').textContent = 'Đang tải…';
  $('prDetailBody').textContent = '(No description)';
  const filesBox = $('prDetailFiles');
  const reviewsBox = $('prDetailReviews');
  filesBox.className = 'empty';
  filesBox.textContent = 'Đang tải file thay đổi…';
  reviewsBox.className = 'empty';
  reviewsBox.textContent = 'Đang tải reviews…';
  let pr;
  try {
    const res = await gh(`${repoApiBase()}/pulls/${number}`);
    pr = res.pull || res.pr || res;
  } catch (err) {
    $('prDetailMeta').textContent = 'Không tải được PR: ' + err.message;
    return null;
  }
  $('prDetailTitle').textContent = '#' + (pr.number || number) + ' — ' + (pr.title || '');
  $('prDetailMeta').textContent =
    `${pr.user || ''} · ${pr.state || ''} · ${pr.head || ''} → ${pr.base || ''} · mở ${timeAgo(pr.created_at)}`;
  $('prDetailBody').textContent = pr.body || '(No description)';
  try {
    const res = await gh(`${repoApiBase()}/pulls/${number}/files`);
    const files = res.files || [];
    filesBox.textContent = '';
    if (!files.length) {
      filesBox.className = 'empty';
      filesBox.textContent = 'PR này không đổi file nào.';
    } else {
      filesBox.className = '';
      for (const f of files) {
        const row = document.createElement('div');
        row.className = 'commititem';
        const t = document.createElement('b');
        t.textContent = f.filename || f.path || '';
        const m = document.createElement('small');
        m.textContent = `+${f.additions || 0} −${f.deletions || 0} · ${f.status || ''}`;
        row.append(t, m);
        filesBox.append(row);
      }
    }
  } catch (err) {
    filesBox.textContent = 'Không tải được file thay đổi: ' + err.message;
  }
  try {
    const res = await gh(`${repoApiBase()}/pulls/${number}/reviews`);
    const reviews = res.reviews || [];
    reviewsBox.textContent = '';
    if (!reviews.length) {
      reviewsBox.className = 'empty';
      reviewsBox.textContent = 'Chưa có review nào.';
    } else {
      reviewsBox.className = '';
      for (const r of reviews) {
        const row = document.createElement('div');
        row.className = 'commititem';
        const t = document.createElement('b');
        t.textContent = (r.user || 'unknown') + ' · ' + (r.state || '');
        const m = document.createElement('small');
        m.textContent = (r.body || '') + (r.submitted_at ? ' · ' + timeAgo(r.submitted_at) : '');
        row.append(t, m);
        reviewsBox.append(row);
      }
    }
  } catch (err) {
    reviewsBox.textContent = 'Không tải được reviews: ' + err.message;
  }
  return pr;
}

/* ---------------- Pull Origin panel (Local Git) ---------------- */

let pullOriginRemotes = [];

async function loadPullOriginPanel() {
  const remoteSel = $('pullOriginRemote');
  const branchSel = $('pullOriginBranch');
  const upstreamEl = $('pullOriginUpstream');
  // Remotes (from /api/git/remotes).
  try {
    const data = await api('/api/git/remotes');
    pullOriginRemotes = (data.remotes || []).map((r) => r.name);
    const prev = remoteSel.value;
    remoteSel.innerHTML = '';
    if (!pullOriginRemotes.length) pullOriginRemotes = ['origin'];
    for (const name of pullOriginRemotes) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      remoteSel.append(opt);
    }
    if (prev && pullOriginRemotes.includes(prev)) remoteSel.value = prev;
  } catch (_) { /* offline — keep the default origin option */ }
  // Branches (from the existing branch list).
  try {
    const data = await api('/api/git/branches');
    const prev = branchSel.value;
    branchSel.innerHTML = '';
    const cur = document.createElement('option');
    cur.value = '';
    cur.textContent = '— branch hiện tại —';
    branchSel.append(cur);
    for (const b of data.branches || []) {
      const opt = document.createElement('option');
      opt.value = b.name;
      opt.textContent = (b.current ? '● ' : '') + b.name;
      branchSel.append(opt);
    }
    if (prev) branchSel.value = prev;
  } catch (_) { /* offline — keep the current-branch option */ }
  // Upstream info.
  try {
    const up = await api('/api/git/upstream');
    if (up.hasUpstream === false || !up.upstream) {
      upstreamEl.textContent = 'Chưa có upstream — branch này chưa gắn với remote nào (tick "Set upstream" khi push).';
    } else {
      upstreamEl.textContent = `Upstream: ${up.upstream} • ahead ${Number(up.ahead) || 0} behind ${Number(up.behind) || 0}`;
    }
  } catch (err) {
    upstreamEl.textContent = 'Không lấy được upstream: ' + err.message;
  }
}

function renderPullOriginResult(box, res, label) {
  box.textContent = '';
  box.classList.remove('hidden');
  if (res && res.conflict) {
    box.append(mk('h4', 'bad', `⚠ Conflict (${res.operation || 'merge'}) ở ${(res.conflicts || []).length} file — xem panel Merge & Conflicts bên dưới.`));
    if (res.hint) box.append(mk('div', 'hint', res.hint));
    return;
  }
  if (res && res.upToDate) {
    box.append(mk('h4', 'ok', '✓ Đã cập nhật — không có commit mới.'));
    return;
  }
  const s = (res && res.stats) || {};
  box.append(mk('h4', 'ok', `✓ ${label} — ${res.commitsPulled || 0} commit, ${s.fileCount || 0} file, +${s.insertions || 0} −${s.deletions || 0}${res.fastForward ? ' · fast-forward' : ''}`));
  if (res.commits && res.commits.length) box.append(commitListEl(res.commits));
  if (s.files && s.files.length) box.append(fileListEl(s.files));
}

async function doPullOrigin() {
  const box = $('pullOriginResults');
  box.classList.remove('hidden');
  box.textContent = 'Đang pull…';
  const body = {
    remote: $('pullOriginRemote').value || 'origin',
    branch: $('pullOriginBranch').value || null,
    mode: $('pullOriginMode').value || 'merge',
    autostash: !!$('pullOriginAutostash').checked,
    useGithubAuth: !!$('useGithubAuthCheck').checked,
  };
  let res;
  try {
    res = await api('/api/git/pull', 'POST', body);
  } catch (err) {
    const d = err.data || {};
    box.textContent = '';
    box.append(mk('h4', 'bad', '✗ Pull thất bại' + (d.reason && d.reason !== 'unknown' ? ` (${d.reason})` : '')));
    if (d.hint) box.append(mk('div', 'warn', d.hint));
    throw err;
  }
  renderPullOriginResult(box, res, `Pull (${body.mode}) từ ${body.remote}${body.branch ? '/' + body.branch : ''}`);
  await handlePossibleConflict(res, 'Pull Origin').catch(() => {});
  await afterRemoteOp(res);
  await loadPullOriginPanel().catch(() => {});
  return res;
}

async function doPullAllRemotes() {
  const box = $('pullOriginResults');
  box.classList.remove('hidden');
  box.textContent = 'Đang pull từ tất cả remote…';
  const body = {
    mode: $('pullOriginMode').value || 'merge',
    autostash: !!$('pullOriginAutostash').checked,
  };
  let res;
  try {
    res = await api('/api/git/pull/remotes', 'POST', body);
  } catch (err) {
    const d = err.data || {};
    box.textContent = '';
    box.append(mk('h4', 'bad', '✗ Pull tất cả remote thất bại' + (d.reason && d.reason !== 'unknown' ? ` (${d.reason})` : '')));
    if (d.hint) box.append(mk('div', 'warn', d.hint));
    throw err;
  }
  box.textContent = '';
  const results = res.results || [];
  box.append(mk('h4', res.ok === false ? 'bad' : 'ok',
    `✓ Pull tất cả remote (${body.mode}) — ${results.filter((r) => r.ok).length}/${results.length} remote ok`));
  const ul = mk('ul');
  for (const r of results) {
    ul.append(mk('li', r.ok ? 'ok' : 'bad',
      `${r.remote}: ${r.ok ? `${r.commitsPulled || 0} commit${r.upToDate ? ' (đã cập nhật)' : ''}` : (r.error || 'lỗi')}`));
  }
  if (ul.childNodes.length) box.append(ul);
  await afterRemoteOp(res).catch(() => {});
  await loadPullOriginPanel().catch(() => {});
  return res;
}

/* ---------------- Command palette (Ctrl+K) ---------------- */

function paletteActionList() {
  const items = [];
  const go = (label, hint, runFn) => items.push({ label, hint, run: runFn });
  go('Đi tới: Repositories', 'Mở tab danh sách repo', () => showView('repos'));
  go('Đi tới: Local Git', 'Mở tab Git local', () => { showView('local'); if (localConnected) loadPullOriginPanel().catch(() => {}); });
  go('Đi tới: Actions', 'Mở tab GitHub Actions', () => { showView('actions'); loadActionsWorkflows().then(() => loadActionsRuns()).catch((e) => log('ERROR: ' + e.message)); });
  go('Đi tới: Hồ sơ', 'Mở tab hồ sơ GitHub', () => { showView('profile'); loadProfile().catch((e) => log('ERROR: ' + e.message)); });
  go('Đi tới: Cài đặt', 'Mở tab cài đặt', () => { showView('settings'); applySettingsToUI(); });
  go('Fetch', 'git fetch — lấy thông tin mới từ remote', () => run('Fetch completed', doFetch));
  go('Pull', 'git pull — kéo commit mới về máy', () => run('Pull completed', doPull));
  go('Push', 'git push — đẩy commit lên remote', () => run('Push completed', doPush));
  go('Đổi giao diện sáng / tối', 'Chuyển giữa giao diện sáng và tối', () => toggleTheme());
  for (const repo of allRepos.slice(0, 50)) {
    go('Mở repo: ' + repo.full_name, repo.description || '', () => openRepo(repo));
  }
  if (currentRepo) {
    go('Mở issue #… (repo hiện tại)', 'Gõ số issue, ví dụ "issue 12"', (q) => openPaletteNumber(q, 'issue'));
    go('Mở PR #… (repo hiện tại)', 'Gõ số PR, ví dụ "pr 5"', (q) => openPaletteNumber(q, 'pr'));
  }
  return items;
}

function openPaletteNumber(query, kind) {
  const m = String(query || '').match(/(\d+)/);
  if (!m) {
    log('Nhập số ' + (kind === 'issue' ? 'issue' : 'PR') + ' — ví dụ "' + kind + ' 12".');
    return;
  }
  const n = Number(m[1]);
  if (kind === 'issue') {
    showView('repo');
    showRepoTab('issues');
    loadRepoIssues().then(() => showIssueDetail(n)).catch((e) => log('ERROR: ' + e.message));
  } else {
    showView('repo');
    showRepoTab('pulls');
    loadRepoPulls().then(() => showPrDetail(n)).catch((e) => log('ERROR: ' + e.message));
  }
}

function paletteFilter(query) {
  const q = String(query || '').trim().toLowerCase();
  const all = paletteActionList();
  if (!q) return all;
  // "issue 12" / "pr 5" / "#12" → open by number in the current repo.
  const numMatch = q.match(/^(?:issue|pr|#)\s*(\d+)$/) || q.match(/^#(\d+)$/);
  if (numMatch && currentRepo) {
    const kind = q.startsWith('pr') ? 'pr' : 'issue';
    return [{ label: `Mở ${kind === 'issue' ? 'issue' : 'PR'} #${numMatch[1]} trong ${currentRepo.full_name}`, hint: 'Enter để mở', run: () => openPaletteNumber(numMatch[1], kind) }];
  }
  return all.filter((it) =>
    it.label.toLowerCase().includes(q) || (it.hint || '').toLowerCase().includes(q));
}

function renderPalette() {
  const list = $('paletteList');
  const q = $('paletteInput').value;
  paletteItems = paletteFilter(q);
  if (paletteSelected >= paletteItems.length) paletteSelected = 0;
  list.textContent = '';
  if (!paletteItems.length) {
    list.className = 'empty';
    list.textContent = 'Không có lệnh nào khớp "' + q + '".';
    return;
  }
  list.className = 'palette-list';
  paletteItems.forEach((item, idx) => {
    const btn = document.createElement('button');
    btn.className = 'palette-item' + (idx === paletteSelected ? ' selected' : '');
    btn.textContent = item.label;
    if (item.hint) {
      const hint = document.createElement('small');
      hint.textContent = item.hint;
      btn.append(hint);
    }
    btn.onclick = () => {
      closePalette();
      try { item.run($('paletteInput').value); } catch (err) { log('ERROR: ' + err.message); }
    };
    list.append(btn);
  });
}

function openPalette() {
  $('paletteOverlay').classList.remove('hidden');
  $('paletteInput').value = '';
  paletteSelected = 0;
  renderPalette();
  $('paletteInput').focus();
}

function closePalette() {
  $('paletteOverlay').classList.add('hidden');
}

function paletteRunSelected() {
  const item = paletteItems[paletteSelected];
  if (!item) return;
  const q = $('paletteInput').value;
  closePalette();
  try { item.run(q); } catch (err) { log('ERROR: ' + err.message); }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* v3.1.1 — GitHub-Desktop toolbar: Repository / Branch / Fetch origin  */
/* / Pull origin / Push origin, visible on every tab.                  */
/* ------------------------------------------------------------------ */

const dbState = { bridge: false, repoPath: null, ab: null, lastFetchAt: null, busy: false, busyText: '', branchList: [] };

function dbRemote() {
  return ($('syncRemote') && $('syncRemote').value.trim()) || 'origin';
}

function dbSetStatus(text, cls) {
  const el = $('dbStatus');
  el.textContent = text;
  el.className = 'db-status' + (cls ? ' ' + cls : '');
  el.dataset.state = cls || 'info';
}

function viAgo(iso) {
  if (!iso) return null;
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(sec)) return null;
  if (sec < 60) return 'vừa xong';
  if (sec < 3600) return Math.floor(sec / 60) + ' phút trước';
  if (sec < 86400) return Math.floor(sec / 3600) + ' giờ trước';
  return Math.floor(sec / 86400) + ' ngày trước';
}

function dbNeedsPublish() {
  const ab = dbState.ab;
  return !!(dbState.repoPath && ab && ab.hasUpstream === false && ab.branch && !String(ab.branch).startsWith('('));
}

function dbRender() {
  const remote = dbRemote();
  const ab = dbState.ab || {};
  const behind = Number(ab.behind) || 0;
  const ahead = Number(ab.ahead) || 0;
  const publish = dbNeedsPublish();
  for (const id of ['dbFetchBtn', 'dbPullBtn', 'dbPushBtn']) {
    $(id).disabled = !dbState.bridge || dbState.busy;
    $(id).classList.remove('suggest');
  }
  $('dbRepoSelect').disabled = !dbState.bridge || dbState.busy;
  $('dbBranchSelect').disabled = !dbState.bridge || dbState.busy || !dbState.repoPath;
  $('dbFetchText').textContent = 'Fetch ' + remote;
  $('dbPullText').textContent = 'Pull ' + remote;
  $('dbPushText').textContent = publish ? 'Publish branch' : 'Push ' + remote;
  $('dbBehind').textContent = behind > 0 ? String(behind) : '';
  $('dbAhead').textContent = ahead > 0 ? String(ahead) : '';
  const ago = viAgo(dbState.lastFetchAt);
  $('dbFetchSub').textContent = ago ? 'Fetch lần cuối ' + ago : 'Chưa fetch lần nào';
  $('dbPullSub').textContent = behind > 0 ? `${behind} commit mới trên remote` : 'Kéo commit mới về';
  $('dbPushSub').textContent = publish ? 'Đưa branch này lên remote' : (ahead > 0 ? `${ahead} commit chưa đẩy lên` : 'Đẩy commit lên remote');
  if (!dbState.bridge || !dbState.repoPath) return;
  if (behind > 0) $('dbPullBtn').classList.add('suggest');
  else if (ahead > 0 || publish) $('dbPushBtn').classList.add('suggest');
  else $('dbFetchBtn').classList.add('suggest');
}

function dbSetAheadBehind(data) {
  if (!data) return;
  dbState.ab = data;
  if (data.lastFetchAt) dbState.lastFetchAt = data.lastFetchAt;
  dbRender();
}

function dbOpt(text, value) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
}

function dbFillBranches(list) {
  dbState.branchList = list || [];
  const sel = $('dbBranchSelect');
  sel.textContent = '';
  if (!dbState.branchList.length) {
    sel.append(dbOpt('(chưa có branch)', ''));
    return;
  }
  let current = '';
  for (const b of dbState.branchList) {
    sel.append(dbOpt(b.name, b.name));
    if (b.current) current = b.name;
  }
  if (current) sel.value = current;
}

async function dbLoadRecent() {
  const sel = $('dbRepoSelect');
  let data = { repos: [] };
  try { data = await api('/api/repo/recent'); } catch (_) { /* older bridge */ }
  sel.textContent = '';
  const repos = data.repos || [];
  if (!dbState.repoPath) sel.append(dbOpt('— Chưa chọn repo —', ''));
  for (const r of repos) sel.append(dbOpt(`${r.name}  (${r.path})`, r.path));
  if (dbState.repoPath && !repos.some((r) => r.path === dbState.repoPath)) sel.append(dbOpt(dbState.repoPath, dbState.repoPath));
  sel.append(dbOpt('＋ Thêm repo có sẵn trên máy…', '__add'));
  sel.append(dbOpt('＋ Clone repo từ GitHub…', '__clone'));
  sel.value = dbState.repoPath || '';
}

function dbOnHealth(data) {
  const wasBridge = dbState.bridge;
  dbState.bridge = true;
  const repo = data && data.repository;
  const newPath = repo ? repo.path : null;
  const changed = newPath !== dbState.repoPath;
  dbState.repoPath = newPath;
  if (!newPath) {
    dbState.ab = null;
    dbFillBranches([]);
    if (!dbState.busy) dbSetStatus('Chưa chọn repo local. Chọn ở ô "Repository hiện tại", hoặc mở một repo trong tab Repositories rồi bấm "Clone / Mở bằng Git local".');
  } else if (repo && repo.branch && !dbState.branchList.length) {
    dbFillBranches([{ name: repo.branch, current: true }]);
  }
  if (changed || !wasBridge) {
    dbLoadRecent().catch(() => {});
    if (newPath) {
      loadAheadBehind().catch(() => {});
      if (!dbState.busy) dbSetStatus(`Repo: ${newPath}`);
    }
  }
  dbRender();
}

function dbOnOffline() {
  dbState.bridge = false;
  dbRender();
  dbSetStatus('Bridge chưa kết nối — chạy bridge (start-windows.bat / start-mac-linux.sh) rồi dán token.', 'bad');
}

async function dbRun(btnId, busyText, fn) {
  if (!dbState.bridge) { dbSetStatus('Bridge chưa kết nối — chạy bridge trước.', 'bad'); return; }
  if (!dbState.repoPath) {
    dbSetStatus('Chưa chọn repo local nên chưa Fetch/Pull/Push được. Chọn repo ở ô "Repository hiện tại" (hoặc "＋ Clone repo từ GitHub…").', 'bad');
    if (typeof $('dbRepoSelect').focus === 'function') $('dbRepoSelect').focus();
    return;
  }
  dbState.busy = true;
  const btn = btnId ? $(btnId) : null;
  if (btn) btn.classList.add('busy');
  dbState.busyText = busyText;
  dbRender();
  dbSetStatus(busyText, 'busy');
  try {
    const msg = await fn();
    dbSetStatus(msg || 'Xong.', 'ok');
    log(msg || 'Xong.');
  } catch (err) {
    const d = err.data || {};
    const text = String(err.message || err).split('\n→')[0];
    dbSetStatus('✗ ' + text + (d.hint ? '\n→ ' + d.hint : ''), 'bad');
    log('ERROR: ' + text);
  } finally {
    dbState.busy = false;
    if (btn) btn.classList.remove('busy');
    await loadAheadBehind().catch(() => {});
    dbRender();
  }
}

async function dbFetch() {
  const res = await doFetch();
  const ab = dbState.ab || res || {};
  const failed = (res.results || []).filter((r) => !r.ok);
  let msg = `Fetch xong — remote có ${Number(ab.behind) || 0} commit mới, bạn có ${Number(ab.ahead) || 0} commit chưa đẩy.`;
  if (ab.hasUpstream === false) msg = 'Fetch xong — branch này chưa có trên remote (bấm Publish branch để đưa lên).';
  if (failed.length) msg += '\nMột số remote lỗi: ' + failed.map((r) => `${r.remote}: ${r.hint || r.error}`).join('; ');
  return msg;
}

async function dbPull() {
  if (dbNeedsPublish()) throw new Error('Branch này chưa có trên remote nên chưa có gì để pull. Bấm "Publish branch" để đưa branch lên trước.');
  const res = await doPull();
  if (res && res.conflict) {
    showView('local');
    return `Pull có conflict ở ${(res.conflicts || []).length} file — đã mở tab Local Git để xử lý (Ours / Theirs).`;
  }
  const n = res.commitsPulled || 0;
  return n ? `Pull xong — nhận ${n} commit, ${(res.changedFiles || []).length} file thay đổi.` : 'Pull xong — máy bạn đã mới nhất, không có commit mới.';
}

async function dbPush() {
  const publish = dbNeedsPublish();
  const res = await doPush(publish ? { setUpstream: true } : undefined);
  const refs = [];
  for (const r of (res.results || [res])) for (const ref of (r.refs || [])) refs.push(ref);
  if (refs.length && refs.every((r) => r.status === 'up-to-date')) return 'Không có gì để push — remote đã có đủ commit.';
  return publish ? 'Đã publish branch lên remote và đặt upstream.' : 'Push xong — commit đã lên remote.';
}

async function dbSelectRepoPath(p) {
  const data = await api('/api/repo/select', 'POST', { path: p });
  if (data.repository) $('repoPath').value = data.repository.path;
  dbState.repoPath = data.repository ? data.repository.path : p;
  dbState.branchList = [];
  await refreshAllLocal();
  await dbLoadRecent();
  dbRender();
  return data;
}

async function dbCloneFlow(fullNameOrUrl) {
  let input = fullNameOrUrl;
  if (!input) {
    input = prompt('Nhập repo cần clone: owner/repo hoặc URL (https://github.com/owner/repo.git)', currentRepo ? currentRepo.full_name : '');
    if (!input) return null;
  }
  input = input.trim();
  const m = input.match(/^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/i.test(input);
  const fullName = m ? `${m[1]}/${m[2]}` : null;
  const url = fullName && !/^(git@|ssh:\/\/)/i.test(input) ? `https://github.com/${fullName}.git` : input;
  if (!fullName && !isUrl) throw new Error('Không hiểu repo cần clone — nhập dạng owner/repo hoặc URL đầy đủ.');
  let suggested = '';
  if (fullName) {
    const f = await api('/api/repo/find?fullName=' + encodeURIComponent(fullName));
    if (f.found) {
      await dbSelectRepoPath(f.path);
      return `Đã mở repo có sẵn trên máy: ${f.path}`;
    }
    suggested = f.suggestedPath;
  }
  const dest = prompt('Clone về thư mục nào trên máy? (thư mục phải chưa có hoặc đang rỗng — thư mục cha sẽ được tạo nếu thiếu)', suggested);
  if (!dest) return null;
  dbState.busy = true;
  dbState.busyText = `Đang clone ${fullName || url}… (repo lớn có thể mất vài phút)`;
  dbRender();
  dbSetStatus(dbState.busyText, 'busy');
  try {
    const res = await api('/api/git/clone', 'POST', { url, path: dest.trim(), useGithubAuth: true });
    if (res.repository) $('repoPath').value = res.repository.path;
    dbState.repoPath = res.repository ? res.repository.path : dest.trim();
    dbState.branchList = [];
  } finally {
    dbState.busy = false;
  }
  await refreshAllLocal();
  await dbLoadRecent();
  dbRender();
  return `Clone xong: ${dbState.repoPath}`;
}

async function dbOpenCurrentRepoLocally() {
  if (!currentRepo) throw new Error('Mở một repo trong danh sách trước.');
  if (!dbState.bridge) throw new Error('Bridge chưa kết nối — chạy bridge trước.');
  const msg = await dbCloneFlow(currentRepo.full_name);
  if (msg) {
    dbSetStatus(msg + '\nGiờ dùng được Fetch / Pull / Push ở thanh trên cùng.', 'ok');
    log(msg);
  }
}

$('dbFetchBtn').onclick = () => dbRun('dbFetchBtn', `Đang fetch ${dbRemote()}…`, dbFetch);
$('dbPullBtn').onclick = () => dbRun('dbPullBtn', `Đang pull từ ${dbRemote()}…`, dbPull);
$('dbPushBtn').onclick = () => dbRun('dbPushBtn', `Đang push lên ${dbRemote()}…`, dbPush);
$('repoLocalBtn').onclick = () => dbOpenCurrentRepoLocally().catch((err) => {
  dbState.busy = false;
  dbRender();
  const d = err.data || {};
  dbSetStatus('✗ ' + String(err.message).split('\n→')[0] + (d.hint ? '\n→ ' + d.hint : ''), 'bad');
  log('ERROR: ' + err.message);
});

$('dbRepoSelect').onchange = async () => {
  const v = $('dbRepoSelect').value;
  try {
    if (v === '__add') {
      const p = prompt('Đường dẫn đầy đủ tới thư mục repo Git trên máy (ví dụ C:\\Users\\ban\\Projects\\game hoặc /home/ban/game)', '');
      if (p && p.trim()) {
        await dbSelectRepoPath(p.trim());
        dbSetStatus('Đã chọn repo: ' + dbState.repoPath, 'ok');
      }
    } else if (v === '__clone') {
      const msg = await dbCloneFlow(null);
      if (msg) dbSetStatus(msg, 'ok');
    } else if (v && v !== dbState.repoPath) {
      await dbSelectRepoPath(v);
      dbSetStatus('Đã chọn repo: ' + dbState.repoPath, 'ok');
    }
  } catch (err) {
    dbState.busy = false;
    const d = err.data || {};
    dbSetStatus('✗ ' + String(err.message).split('\n→')[0] + (d.hint ? '\n→ ' + d.hint : ''), 'bad');
  }
  await dbLoadRecent().catch(() => {});
  dbRender();
};

$('dbBranchSelect').onchange = () => {
  const branch = $('dbBranchSelect').value;
  const current = (dbState.branchList.find((b) => b.current) || {}).name;
  if (!branch || branch === current) return;
  dbRun(null, `Đang chuyển sang branch ${branch}…`, async () => {
    await api('/api/git/checkout', 'POST', { branch });
    dbState.branchList = [];
    await refreshAllLocal();
    return `Đã chuyển sang branch ${branch}.`;
  }).then(() => branches().catch(() => {}));
};

setInterval(() => { if (dbState.bridge) dbRender(); }, 30000);
dbRender();

(async () => {
  await loadStoredTheme().catch(() => {}); // v3.5.0: theme before first paint
  const c = await cfg();
  $('bridgeUrl').value = c.bridgeUrl;
  $('token').value = c.token;
  $('autoStartBridge').checked = !!c.autoStartBridge; // v3.6.0
  $('autoUpdateToggle').checked = !!c.autoUpdateEnabled;
  if (c.autoUpdateInterval) $('autoUpdateInterval').value = String(c.autoUpdateInterval);
  // v3.0 settings from storage.
  settingsDefaultBranch = c.settingsDefaultBranch;
  settingsNotifications = c.settingsNotifications;
  $('settingsInterval').value = String(c.autoUpdateInterval);
  $('settingsDefaultBranch').value = settingsDefaultBranch;
  $('settingsNotifications').checked = settingsNotifications;
  updateNotifBadge();

  showView('repos');
  // v3.0.1: the dashboard only works inside the extension. Opened as a
  // plain file (file://) or a normal web page, the browser enforces
  // CORS against the bridge and every sign-in fails with "Failed to
  // fetch" — say so clearly instead of letting the user guess. The
  // toggle sets the state explicitly both ways (not just "remove when
  // outside") so the banner can never be stuck in the wrong state.
  $('outsideExtensionNotice').classList.toggle('hidden', isExtensionContext());
  // v3.0.1: sign-in stays disabled until the first health check proves
  // the bridge is up.
  setLoginEnabled(false);
  startHealthPoll();
  let ok = await health();
  // v3.6.0: auto-start at most ONCE per dashboard open, only when the
  // user enabled it and the bridge is still down. The health poll
  // itself never auto-starts (no loop, no spam).
  if (!ok && c.autoStartBridge) {
    const started = await tryAutoStartBridge();
    if (started) ok = await health();
  }
  if (!ok) {
    log('Bridge offline. ' + BRIDGE_START_SHORT + ' Trang này sẽ tự kết nối lại khi bridge chạy.');
    return;
  }
  startEventStream();
  if (!c.token) {
    log('Bridge online. Paste the token printed by the bridge, then click Connect Bridge.');
    return;
  }
  try {
    await refreshGithubState();
  } catch (err) {
    log('ERROR: ' + err.message);
  }
  if (localConnected) {
    try {
      await refreshAllLocal();
    } catch (err) {
      log('ERROR: ' + err.message);
    }
  }
})();
