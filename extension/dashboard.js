'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULTS = { bridgeUrl: 'http://127.0.0.1:17321', token: '' };

let selectedFile = '';
let connected = false;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '') || DEFAULTS.bridgeUrl;
}

async function cfg() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return { bridgeUrl: normalizeBase(s.bridgeUrl), token: String(s.token || '').trim() };
}

function log(message) {
  const time = new Date().toLocaleTimeString();
  $('log').textContent = time + ' · ' + message;
}

function setLamp(state) {
  $('lamp').className = state;
}

async function api(path, method = 'GET', body) {
  const c = await cfg();
  if (!c.token) throw new Error('Missing bridge token. Start the bridge and paste its token.');

  const res = await fetch(c.bridgeUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

/* ------------------------------------------------------------------ */
/* Bridge / repository state                                           */
/* ------------------------------------------------------------------ */

async function health() {
  const c = await cfg();
  try {
    const res = await fetch(c.bridgeUrl + '/health');
    if (!res.ok) throw new Error('offline');
    const data = await res.json();

    $('bridgeStatus').textContent = 'LOCAL BRIDGE CONNECTED';
    setLamp('ok');

    const repo = data.repository;
    if (repo) {
      $('repoName').textContent = repo.name;
      $('branch').textContent = repo.branch || '—';
      $('remote').textContent = repo.remote || 'No remote';
      // Only fill the path field when it is empty, so typing is never clobbered.
      if (!$('repoPath').value.trim()) $('repoPath').value = repo.path;
      connected = true;
    } else {
      $('repoName').textContent = 'Not connected';
      $('branch').textContent = '—';
      $('remote').textContent = '—';
      connected = false;
    }
    return true;
  } catch (_) {
    $('bridgeStatus').textContent = 'BRIDGE DISCONNECTED';
    setLamp('off');
    connected = false;
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Changes / staging                                                   */
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

/* ------------------------------------------------------------------ */
/* Branches / history                                                  */
/* ------------------------------------------------------------------ */

async function branches() {
  const data = await api('/api/git/branches');
  const select = $('branchSelect');
  const previous = select.value;
  select.innerHTML = '';

  const list = data.branches || [];
  if (!list.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No branches';
    select.append(option);
    return;
  }

  for (const branch of list) {
    const option = document.createElement('option');
    option.value = branch.name;
    option.textContent = (branch.current ? '● ' : '') + branch.name;
    select.append(option);
  }

  if (previous && list.some((b) => b.name === previous)) select.value = previous;
}

async function history() {
  const data = await api('/api/git/log');
  const container = $('history');
  container.innerHTML = '';

  const commits = data.commits || [];
  if (!commits.length) {
    container.className = 'empty';
    container.textContent = 'No commits yet';
    return;
  }

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

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

async function run(label, fn) {
  try {
    await fn();
    log(label + ' ✓');
  } catch (err) {
    log('ERROR: ' + err.message);
  }
}

async function refreshAll() {
  await health();
  if (!connected) return;
  await status();
  await branches();
  await history();
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

$('saveConnection').onclick = () => run('Connection saved', async () => {
  await chrome.storage.local.set({
    bridgeUrl: normalizeBase($('bridgeUrl').value),
    token: $('token').value.trim(),
  });
  const ok = await health();
  if (!ok) throw new Error('Bridge not reachable at ' + normalizeBase($('bridgeUrl').value));
  if (connected) await refreshAll();
});

$('connectRepo').onclick = () => run('Repository connected', async () => {
  const path = $('repoPath').value.trim();
  if (!path) throw new Error('Enter the full path to a local Git repository');
  const data = await api('/api/repo/select', 'POST', { path });
  if (data.repository) $('repoPath').value = data.repository.path;
  await refreshAll();
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
  await api('/api/git/commit', 'POST', { summary, description: $('description').value.trim() });
  $('summary').value = '';
  $('description').value = '';
  await status();
  await history();
});

for (const action of ['fetch', 'pull', 'push']) {
  $(action).onclick = () => run(action.toUpperCase() + ' completed', async () => {
    await api('/api/git/' + action, 'POST', {});
    await status();
    await history();
  });
}

$('switchBranch').onclick = () => run('Branch switched', async () => {
  const branch = $('branchSelect').value;
  if (!branch) throw new Error('Select a branch first');
  await api('/api/git/checkout', 'POST', { branch });
  await refreshAll();
});

$('loadHistory').onclick = () => run('History refreshed', history);

$('copyPath').onclick = () => run('Repository path copied', async () => {
  const path = $('repoPath').value.trim();
  if (!path) throw new Error('Connect a repository first');
  await navigator.clipboard.writeText(path);
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  const c = await cfg();
  $('bridgeUrl').value = c.bridgeUrl;
  $('token').value = c.token;

  const ok = await health();
  if (!ok) {
    log('Bridge offline. Start it with: node bridge/bridge-server.js');
    return;
  }
  if (!c.token) {
    log('Bridge online. Paste the token printed by the bridge, then click Connect Bridge.');
    return;
  }
  if (connected) {
    try {
      await refreshAll();
    } catch (err) {
      log('ERROR: ' + err.message);
    }
  } else {
    log('Bridge online. Enter a repository path and click Connect Repository.');
  }
})();
