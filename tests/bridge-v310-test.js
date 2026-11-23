'use strict';
require('./_node16-fetch'); // v3.1.0: Node 16.13 has no global fetch

/*
 * Bridge v3.1.0 functional test harness — extended pull / push.
 *
 * Starts the REAL bridge on a test port (fake GitHub on another port,
 * no real network) and drives the v3.1.0 features against REAL local
 * git repositories (a bare "remote" + clone A driven by the bridge +
 * clone B playing "someone else"):
 *
 *   - pull preview (incoming commits, fast-forward, dirty overlap)
 *   - pull autostash, dirty-tree failure reason + Vietnamese hint
 *   - pull result: commit list + insertions/deletions
 *   - undo last pull (confirm gate, reset --keep)
 *   - pull --rebase conflict → operation state → continue blocked while
 *     conflicted → resolve "ours" (= MY version, even in a rebase) →
 *     rebase continue; rebase abort
 *   - pull squash (pendingCommit), pull all branches (fast-forward
 *     non-current branches, skip diverged)
 *   - push preview (outgoing, willBeRejected), non-fast-forward
 *     rejection reason + hint + porcelain refs, dry-run, push to a
 *     different remote branch name, push up to a commit, multi-remote
 *     push, push option validation
 *   - sync: pushAfter=false, skip empty push
 *   - history endpoint + SSE `git-history` event
 *   - GitHub token credential helper is used ONLY for https://github.com
 *     remotes when signed in (url.insteadOf keeps it offline)
 *
 * Usage: node tests/bridge-v310-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_ENTRY = path.join(ROOT, 'bridge', 'bridge-server.js');
const MOCK_PORT = 17412;
const BRIDGE_PORT = 17386;
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const GOOD_TOKEN = 'ghp_v310testtoken1234567890';

let failures = 0;
let passes = 0;
function check(name, condition, detail) {
  if (condition) { passes += 1; console.log(`  PASS  ${name}`); }
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@example.com',
};
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }); }
function write(dir, file, text) { fs.writeFileSync(path.join(dir, file), text); }
function read(dir, file) { return fs.readFileSync(path.join(dir, file), 'utf8'); }
function commitFile(dir, file, text, msg) { write(dir, file, text); git(dir, 'add', file); git(dir, 'commit', '-q', '-m', msg); }
function sha(dir, ref = 'HEAD') { return git(dir, 'rev-parse', ref).trim(); }

function mockHandler(req, res) {
  const url = new URL(req.url, MOCK_BASE);
  if (url.pathname === '/user') {
    if (req.headers.authorization !== `Bearer ${GOOD_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Bad credentials' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-OAuth-Scopes': 'repo, read:user' });
    return res.end(JSON.stringify({ login: 'octocat', id: 1, name: 'The Octocat', avatar_url: '', html_url: 'https://github.com/octocat' }));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Not Found' }));
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v310-test-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const mock = http.createServer(mockHandler);
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const remote = path.join(tmp, 'remote.git');
  const backup = path.join(tmp, 'backup.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '--bare', backup]);
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const A = path.join(tmp, 'a');
  const B = path.join(tmp, 'b');
  execFileSync('git', ['clone', '-q', remote, A], { env: GIT_ENV, stdio: 'ignore' });
  git(A, 'checkout', '-q', '-b', 'main');
  git(A, 'config', 'user.name', 'Test User');
  git(A, 'config', 'user.email', 'test@example.com');
  commitFile(A, 'f.txt', 'line1\nline2\nline3\n', 'c1');
  git(A, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remote, B], { env: GIT_ENV, stdio: 'ignore' });
  git(B, 'config', 'user.name', 'Other');
  git(B, 'config', 'user.email', 'other@example.com');

  const bridge = spawn(process.execPath, [BRIDGE_ENTRY], {
    env: { ...GIT_ENV, BRIDGE_PORT: String(BRIDGE_PORT), BRIDGE_DATA_DIR: dataDir, GITHUB_API_BASE: MOCK_BASE, GITHUB_OAUTH_BASE: MOCK_BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bridgeOut = '';
  bridge.stdout.on('data', (d) => { bridgeOut += d; });
  bridge.stderr.on('data', (d) => { bridgeOut += d; });
  const sseEvents = [];
  let sseReq = null;
  const cleanup = (code) => {
    try { if (sseReq) sseReq.destroy(); } catch (_) {}
    try { bridge.kill('SIGTERM'); } catch (_) {}
    try { mock.close(); } catch (_) {}
    if (failures) console.log('\n--- bridge log ---\n' + bridgeOut.split('\n').slice(-40).join('\n'));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nbridge-v310: ${passes} passed, ${failures} failed`);
    process.exit(code);
  };

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('bridge did not start: ' + bridgeOut)), 15000);
      const iv = setInterval(() => { if (bridgeOut.includes('Listening:')) { clearTimeout(t); clearInterval(iv); resolve(); } }, 100);
    });
  } catch (err) { console.log('  FAIL  bridge starts -> ' + err.message); return cleanup(1); }
  check('bridge v3.1.0 starts on Node ' + process.version, /v3\.1\.0/.test(bridgeOut));

  const token = fs.readFileSync(path.join(dataDir, '.bridge-token'), 'utf8').trim();
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  async function call(method, p, body) {
    const res = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }
  const j = (r) => JSON.stringify(r).slice(0, 300);

  // SSE listener for git-history / git-progress.
  sseReq = http.get(`${BASE}/api/events?token=${encodeURIComponent(token)}`, (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (block.match(/^event: (.+)$/m) || [])[1];
        if (ev) sseEvents.push(ev);
      }
    });
  });
  sseReq.on('error', () => {});

  let r = await call('POST', '/api/repo/select', { path: A });
  check('select repo A', r.ok === true, j(r));

  /* ---------- 1. pull preview ---------- */
  console.log('\n[1] pull preview / autostash / stats / undo');
  commitFile(B, 'f.txt', 'LINE1-from-B\nline2\nline3\n', 'c2 from B');
  git(B, 'push', '-q');
  const beforePreview = sha(A);
  r = await call('POST', '/api/git/pull/preview', {});
  check('pull preview: 1 incoming commit, fast-forward possible', r.ok === true && r.incomingCount === 1 && r.canFastForward === true && r.incoming[0].subject === 'c2 from B', j(r));
  check('pull preview does not move HEAD', sha(A) === beforePreview);
  check('pull preview has stats + suggestion', r.stats && r.stats.fileCount === 1 && typeof r.suggestion === 'string', j(r));

  write(A, 'f.txt', 'line1\nline2\nline3-local-edit\n');
  r = await call('POST', '/api/git/pull/preview', {});
  check('pull preview reports dirty overlap', Array.isArray(r.dirtyOverlap) && r.dirtyOverlap.includes('f.txt'), j(r));
  r = await call('POST', '/api/git/pull', { mode: 'merge' });
  check('pull without autostash fails with reason dirty-tree + hint', r.status === 400 && r.reason === 'dirty-tree' && /Autostash/.test(r.hint || ''), j(r));
  r = await call('POST', '/api/git/pull', { mode: 'merge', autostash: true });
  check('pull with autostash succeeds', r.ok === true && r.commitsPulled === 1, j(r));
  check('autostash kept the local edit AND got the remote change', read(A, 'f.txt') === 'LINE1-from-B\nline2\nline3-local-edit\n', JSON.stringify(read(A, 'f.txt')));
  check('pull result lists commits + insertions/deletions', Array.isArray(r.commits) && r.commits[0].subject === 'c2 from B' && r.stats.insertions === 1 && r.stats.deletions === 1, j(r));
  check('pull result says undo is available', r.undoAvailable === true && r.previousSha === beforePreview, j(r));

  git(A, 'checkout', '--', 'f.txt');
  r = await call('GET', '/api/git/pull/last');
  check('pull/last: undo available', r.undoAvailable === true, j(r));
  r = await call('POST', '/api/git/pull/undo', {});
  check('undo pull without confirm rejected', r.status === 400, j(r));
  r = await call('POST', '/api/git/pull/undo', { confirm: true });
  check('undo pull restores the previous HEAD', r.ok === true && sha(A) === beforePreview, j(r));
  r = await call('POST', '/api/git/pull/undo', { confirm: true });
  check('second undo refused (nothing to undo)', r.status === 400, j(r));
  r = await call('POST', '/api/git/pull', { mode: 'ff-only' });
  check('pull ff-only after undo', r.ok === true && r.fastForward === true && sha(A) === sha(B), j(r));

  /* ---------- 2. push preview / rejection / dry-run / refspecs ---------- */
  console.log('\n[2] push preview / rejection / dry-run / remote branch / up-to / multi-remote');
  commitFile(A, 'a.txt', 'a\n', 'c3 from A');
  r = await call('POST', '/api/git/push/preview', {});
  check('push preview: 1 outgoing, not rejected', r.ok === true && r.outgoingCount === 1 && r.willBeRejected === false && r.outgoing[0].subject === 'c3 from A', j(r));
  git(B, 'pull', '-q', '--no-rebase');
  commitFile(B, 'b.txt', 'b\n', 'c4 from B');
  git(B, 'push', '-q');
  r = await call('POST', '/api/git/push/preview', {});
  check('push preview: remote ahead -> willBeRejected', r.willBeRejected === true && r.behindCount === 1, j(r));
  r = await call('POST', '/api/git/push', {});
  check('non-fast-forward push: 400 + reason + hint + porcelain refs', r.status === 400 && r.reason === 'non-fast-forward' && /Pull/.test(r.hint || '') && Array.isArray(r.refs) && r.refs.some((x) => x.status === 'rejected'), j(r));

  r = await call('POST', '/api/git/sync', { mode: 'rebase', pushAfter: false });
  check('sync pushAfter=false: pull only, push step skipped', r.ok === true && r.steps.find((s) => s.step === 'push').skipped === true, j(r));
  const remoteMainBefore = git(A, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
  r = await call('POST', '/api/git/push', { dryRun: true });
  check('dry-run push reports ok but changes nothing', r.ok === true && r.dryRun === true && r.pushed === false &&
    git(A, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0] === remoteMainBefore, j(r));
  r = await call('POST', '/api/git/push', {});
  check('normal push ok, porcelain ref = fast-forward', r.ok === true && r.refs.length === 1 && r.refs[0].status === 'fast-forward', j(r));
  r = await call('POST', '/api/git/sync', {});
  check('sync with nothing to push skips the push step', r.ok === true && /Nothing to push/.test(r.steps.find((s) => s.step === 'push').result || ''), j(r));

  r = await call('POST', '/api/git/push', { remoteBranch: 'feature-x' });
  check('push to a different remote branch name', r.ok === true && r.remoteBranch === 'feature-x' &&
    git(A, 'ls-remote', 'origin', 'refs/heads/feature-x').split('\t')[0] === sha(A), j(r));

  commitFile(A, 'c5.txt', '5\n', 'c5');
  const c5 = sha(A);
  commitFile(A, 'c6.txt', '6\n', 'c6');
  r = await call('POST', '/api/git/push', { upTo: c5 });
  check('push up to a commit (c5, not c6)', r.ok === true && git(A, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0] === c5, j(r));
  r = await call('POST', '/api/git/push', { upTo: 'deadbeef' });
  check('push up to an unknown commit rejected', r.status === 400, j(r));

  git(A, 'remote', 'add', 'backup', backup);
  r = await call('POST', '/api/git/push', { remotes: ['origin', 'backup'] });
  check('multi-remote push: both ok', r.ok === true && r.multi === true && r.results.length === 2 && r.results.every((x) => x.ok), j(r));
  check('backup remote received main', git(A, 'ls-remote', 'backup', 'refs/heads/main').split('\t')[0] === sha(A));
  r = await call('POST', '/api/git/push', { pushOptions: ['ci.skip\nevil'] });
  check('push option with newline rejected', r.status === 400, j(r));
  r = await call('POST', '/api/git/push', { followTags: true, noVerify: true, atomic: true });
  check('push with --follow-tags --no-verify --atomic accepted', r.ok === true && r.upToDate === true, j(r));

  /* ---------- 3. rebase conflict flow ---------- */
  console.log('\n[3] pull --rebase conflict -> continue / abort');
  git(B, 'pull', '-q', '--no-rebase');
  commitFile(B, 'f.txt', 'CONFLICT-B\nline2\nline3\n', 'B edits line1');
  git(B, 'push', '-q');
  commitFile(A, 'f.txt', 'CONFLICT-A\nline2\nline3\n', 'A edits line1');
  r = await call('POST', '/api/git/pull', { mode: 'rebase' });
  check('rebase pull conflict reported (200, ok:false, operation=rebase)', r.status === 200 && r.conflict === true && r.operation === 'rebase' && r.conflicts.includes('f.txt'), j(r));
  r = await call('GET', '/api/git/operation');
  check('operation endpoint: rebase in progress + hint', r.state === 'rebase' && /Continue/.test(r.hint || ''), j(r));
  r = await call('POST', '/api/git/pull', {});
  check('pull while rebasing refused (OPERATION_IN_PROGRESS)', r.status === 400 && r.code === 'OPERATION_IN_PROGRESS', j(r));
  r = await call('POST', '/api/git/rebase/continue', {});
  check('rebase continue blocked while conflicts remain', r.status === 400 && r.code === 'UNRESOLVED_CONFLICTS', j(r));
  r = await call('POST', '/api/git/conflict/resolve', { path: 'f.txt', side: 'ours' });
  check('resolve "ours" during rebase = MY version', r.ok === true && r.gitSide === 'theirs' && read(A, 'f.txt').startsWith('CONFLICT-A'), j(r) + ' ' + read(A, 'f.txt'));
  r = await call('POST', '/api/git/rebase/continue', {});
  check('rebase continue finishes', r.ok === true && r.done === true, j(r));
  check('my commit now sits on top of B\'s', git(A, 'log', '-2', '--format=%s').trim() === 'A edits line1\nB edits line1');
  r = await call('POST', '/api/git/push', {});
  check('push after rebase ok', r.ok === true, j(r));

  git(B, 'pull', '-q', '--no-rebase');
  commitFile(B, 'f.txt', 'AGAIN-B\nline2\nline3\n', 'B again');
  git(B, 'push', '-q');
  commitFile(A, 'f.txt', 'AGAIN-A\nline2\nline3\n', 'A again');
  const beforeAbort = sha(A);
  r = await call('POST', '/api/git/pull', { mode: 'rebase' });
  check('second rebase conflict', r.conflict === true, j(r));
  r = await call('POST', '/api/git/rebase/abort', {});
  check('rebase abort restores HEAD', r.ok === true && sha(A) === beforeAbort, j(r));
  r = await call('POST', '/api/git/pull', { mode: 'merge', strategyOption: 'ours' });
  check('merge pull with -X ours resolves automatically', r.ok === true && read(A, 'f.txt').startsWith('AGAIN-A'), j(r));
  r = await call('POST', '/api/git/pull', { strategyOption: 'rm -rf' });
  check('invalid strategyOption rejected', r.status === 400, j(r));
  await call('POST', '/api/git/push', {});

  /* ---------- 4. squash + all branches ---------- */
  console.log('\n[4] squash pull / pull all branches');
  git(B, 'pull', '-q', '--no-rebase');
  commitFile(B, 's.txt', 's\n', 'squash me');
  git(B, 'push', '-q');
  r = await call('POST', '/api/git/pull', { squash: true });
  check('squash pull leaves changes staged (pendingCommit)', r.ok === true && r.pendingCommit === true && git(A, 'diff', '--cached', '--name-only').trim() === 's.txt', j(r));
  // A squash pull records no merge parent, so throw the squash commit
  // away again and fast-forward to the real remote history.
  git(A, 'reset', '-q', '--hard', 'HEAD');
  git(A, 'merge', '-q', '--ff-only', 'origin/main');

  git(A, 'checkout', '-q', '-b', 'dev');
  await call('POST', '/api/git/push', { setUpstream: true });
  git(A, 'checkout', '-q', '-b', 'side');
  await call('POST', '/api/git/push', { setUpstream: true });
  git(A, 'checkout', '-q', 'main');
  git(B, 'fetch', '-q');
  git(B, 'checkout', '-q', '-b', 'dev', 'origin/dev');
  commitFile(B, 'dev.txt', 'd\n', 'dev work');
  git(B, 'push', '-q');
  git(B, 'checkout', '-q', '-b', 'side', 'origin/side');
  commitFile(B, 'side.txt', 'remote side\n', 'side remote');
  git(B, 'push', '-q');
  git(A, 'checkout', '-q', 'side');
  commitFile(A, 'side2.txt', 'local side\n', 'side local');
  git(A, 'checkout', '-q', 'main');
  r = await call('POST', '/api/git/pull/all-branches', {});
  const dev = (r.results || []).find((x) => x.branch === 'dev');
  const side = (r.results || []).find((x) => x.branch === 'side');
  check('pull all branches: dev fast-forwarded (not checked out)', dev && dev.status === 'updated' && sha(A, 'dev') === sha(B, 'dev'), j(r));
  check('pull all branches: diverged branch skipped', side && side.status === 'diverged', j(r));

  /* ---------- 5. history + SSE ---------- */
  console.log('\n[5] history / SSE');
  r = await call('GET', '/api/git/sync-history?limit=50');
  const types = new Set((r.history || []).map((h) => h.type));
  check('history records pull, push, undo-pull, sync, rebase, pull-all', ['pull', 'push', 'undo-pull', 'sync', 'rebase-continue', 'pull-all'].every((t) => types.has(t)), Array.from(types).join(','));
  check('SSE delivered git-history events', sseEvents.includes('git-history'), sseEvents.slice(0, 10).join(','));
  r = await call('POST', '/api/git/sync-history/clear', {});
  check('history clear', r.ok === true && r.history.length === 0, j(r));

  /* ---------- 6. GitHub token for https://github.com remotes ---------- */
  console.log('\n[6] GitHub token credential helper');
  r = await call('POST', '/api/git/push', {});
  check('local remote: GitHub auth NOT used (not signed in)', r.ok === true && r.usedGithubAuth === false, j(r));
  r = await call('POST', '/api/github/auth', { token: GOOD_TOKEN });
  check('sign in with PAT (fake GitHub)', r.ok === true, j(r));
  git(A, 'remote', 'add', 'gh', 'https://github.com/octocat/alpha.git');
  git(A, 'config', `url.${remote}.insteadOf`, 'https://github.com/octocat/alpha.git');
  r = await call('POST', '/api/git/push/preview', { remote: 'gh' });
  check('https://github.com remote + signed in: token helper used', r.ok === true && r.usedGithubAuth === true, j(r));
  r = await call('POST', '/api/git/push/preview', { remote: 'gh', useGithubAuth: false });
  check('useGithubAuth=false turns it off', r.ok === true && r.usedGithubAuth === false, j(r));
  r = await call('POST', '/api/git/push/preview', { remote: 'origin' });
  check('non-GitHub remote never gets the token', r.ok === true && r.usedGithubAuth === false, j(r));
  check('token never written to the bridge log', !bridgeOut.includes(GOOD_TOKEN));

  // The helper itself answers git's credential protocol from the env.
  const helper = '!f() { echo username=x-access-token; echo "password=$BRIDGE_GIT_TOKEN"; }; f';
  const out = execFileSync('git', ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, 'credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', env: { ...process.env, BRIDGE_GIT_TOKEN: 'tok123', GIT_TERMINAL_PROMPT: '0' },
  });
  check('credential helper returns x-access-token + token', /username=x-access-token/.test(out) && /password=tok123/.test(out), out);

  cleanup(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
