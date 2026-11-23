// E2E: real Chromium + unpacked extension + real bridge + real git remotes.
'use strict';
/*
 * Optional end-to-end test (v3.1.1): launches a real Chromium with the
 * unpacked extension, a real bridge, a local bare remote and a mock
 * GitHub API, then clicks Fetch origin / Pull origin / Push origin /
 * Publish branch / branch switcher / repo switcher / Clone in the
 * toolbar. Also clones the real public repo from github.com.
 *
 * Needs Playwright:  npm i playwright && npx playwright install chromium
 * (or PLAYWRIGHT_PATH=/path/to/node_modules/playwright). Skips if absent.
 * Usage: node tests/e2e-toolbar.js   (NODE_BIN=... picks the bridge's Node)
 */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch (_) {
  console.log('e2e-toolbar: SKIPPED (playwright not installed — npm i playwright)');
  process.exit(0);
}
const ROOT = process.env.REPO_ROOT || path.join(__dirname, '..');
const NODE = process.env.NODE_BIN || process.execPath;
const SHOTS = process.env.E2E_SHOTS || path.join(os.tmpdir(), 'e2e-toolbar-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const GOOD = 'ghp_e2etoken000000000000000000';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, d === undefined ? '' : '-> ' + d); } };
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO = { id: 1, name: 'Extention-github-desktop', full_name: 'nguyenvu133/Extention-github-desktop', owner: { login: 'nguyenvu133', avatar_url: '' }, private: false, description: 'e2e', default_branch: 'main', html_url: 'https://github.com/nguyenvu133/Extention-github-desktop', clone_url: 'https://github.com/nguyenvu133/Extention-github-desktop.git', stargazers_count: 0, forks_count: 0, open_issues_count: 0, updated_at: new Date().toISOString(), pushed_at: new Date().toISOString(), permissions: { admin: true, push: true, pull: true } };
function mock(req, res) {
  const u = new URL(req.url, 'http://x');
  const j = (c, b, h) => { res.writeHead(c, Object.assign({ 'Content-Type': 'application/json' }, h || {})); res.end(JSON.stringify(b)); };
  if (req.headers.authorization !== `Bearer ${GOOD}`) return j(401, { message: 'Bad credentials' });
  if (u.pathname === '/user') return j(200, { login: 'nguyenvu133', id: 9, name: 'Vu', avatar_url: '', html_url: 'https://github.com/nguyenvu133' }, { 'X-OAuth-Scopes': 'repo, read:user' });
  if (u.pathname === '/user/repos') return j(200, [REPO]);
  if (u.pathname === '/user/emails') return j(200, []);
  if (u.pathname === '/notifications') return j(200, []);
  if (u.pathname === '/rate_limit') return j(200, { resources: { core: { limit: 5000, remaining: 4999, reset: 0 } } });
  if (/\/readme$/.test(u.pathname)) return j(404, { message: 'Not Found' });
  if (/\/branches$|\/issues$|\/pulls$|\/releases$|\/commits$/.test(u.pathname)) return j(200, []);
  if (u.pathname.startsWith('/repos/nguyenvu133/Extention-github-desktop')) return j(200, REPO);
  return j(404, { message: 'Not Found' });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const data = path.join(tmp, 'data'); fs.mkdirSync(data);
  const remote = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const A = path.join(tmp, 'work-a'), B = path.join(tmp, 'work-b');
  execFileSync('git', ['clone', '-q', remote, A], { env: GIT_ENV, stdio: 'ignore' });
  git(A, 'checkout', '-q', '-b', 'main'); fs.writeFileSync(path.join(A, 'a.txt'), '1\n'); git(A, 'add', '.'); git(A, 'commit', '-qm', 'init'); git(A, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remote, B], { env: GIT_ENV, stdio: 'ignore' });

  const ms = http.createServer(mock); await new Promise((r) => ms.listen(17499, '127.0.0.1', r));
  const bridge = spawn(NODE, [path.join(ROOT, 'bridge/bridge-server.js')], { env: { ...GIT_ENV, HOME: tmp, USERPROFILE: tmp, BRIDGE_PORT: '17321', BRIDGE_DATA_DIR: data, GITHUB_API_BASE: 'http://127.0.0.1:17499' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let blog = ''; bridge.stdout.on('data', (d) => blog += d); bridge.stderr.on('data', (d) => blog += d);
  for (let i = 0; i < 100 && !blog.includes('Listening'); i++) await sleep(100);
  ok('bridge started (' + execFileSync(NODE, ['-v']).toString().trim() + ')', blog.includes('Listening'), blog.slice(-500));
  const token = fs.readFileSync(path.join(data, '.bridge-token'), 'utf8').trim();
  const api = (p, m = 'GET', b) => new Promise((resolve, reject) => { const r = http.request('http://127.0.0.1:17321' + p, { method: m, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, (res) => { let t = ''; res.on('data', (d) => t += d); res.on('end', () => { try { resolve(JSON.parse(t)); } catch (e) { resolve(t); } }); }); r.on('error', reject); if (b) r.write(JSON.stringify(b)); r.end(); });
  await api('/api/github/auth', 'POST', { token: GOOD });

  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'prof'), { headless: true, args: [`--disable-extensions-except=${ROOT}/extension`, `--load-extension=${ROOT}/extension`], viewport: { width: 1440, height: 900 } });
  let sw = ctx.serviceWorkers()[0]; if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const prompts = []; page.on('dialog', async (d) => { const v = prompts.shift(); if (v === undefined) await d.dismiss(); else await d.accept(v); });
  await page.goto(`chrome-extension://${extId}/dashboard.html`);
  await page.evaluate((t) => chrome.storage.local.set({ token: t, bridgeUrl: 'http://127.0.0.1:17321' }), token);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('bridgeStatus').textContent.includes('CONNECTED') && !document.getElementById('bridgeStatus').textContent.includes('DIS'), null, { timeout: 15000 }).catch(() => {});
  const st = async () => (await page.textContent('#dbStatus')).trim();
  const vis = async (sel) => page.isVisible(sel);

  // 1. toolbar visible on the default Repositories tab
  ok('toolbar visible on Repositories tab', await vis('#desktopBar'));
  for (const id of ['#dbFetchBtn', '#dbPullBtn', '#dbPushBtn']) ok(`${id} visible`, await vis(id));
  ok('Fetch label = "Fetch origin"', (await page.textContent('#dbFetchText')).trim() === 'Fetch origin', await page.textContent('#dbFetchText'));
  await page.screenshot({ path: SHOTS + '/1-no-repo.png' });
  // 2. click without repo -> clear message
  await page.click('#dbFetchBtn'); await sleep(300);
  ok('no-repo message', /Chưa chọn repo/.test(await st()), await st());

  // 3. add existing repo through the select
  prompts.push(A);
  await page.selectOption('#dbRepoSelect', '__add');
  await page.waitForFunction(() => /Đã chọn repo/.test(document.getElementById('dbStatus').textContent), null, { timeout: 15000 }).catch(() => {});
  ok('repo selected via toolbar', /Đã chọn repo/.test(await st()), await st());
  ok('branch select shows main', (await page.inputValue('#dbBranchSelect')) === 'main', await page.inputValue('#dbBranchSelect'));

  // 4. remote gets a new commit -> Fetch -> Pull suggested with count 1
  fs.writeFileSync(path.join(B, 'b.txt'), 'b\n'); git(B, 'add', '.'); git(B, 'commit', '-qm', 'from B'); git(B, 'push', '-q');
  await page.click('#dbFetchBtn');
  await page.waitForFunction(() => /Fetch xong|✗/.test(document.getElementById('dbStatus').textContent), null, { timeout: 20000 }).catch(() => {});
  ok('fetch ok', /Fetch xong/.test(await st()), await st());
  ok('behind badge = 1', (await page.textContent('#dbBehind')).trim() === '1', await page.textContent('#dbBehind'));
  ok('pull button suggested', await page.$eval('#dbPullBtn', (e) => e.classList.contains('suggest')));
  ok('fetch subtitle updated', /Fetch lần cuối/.test(await page.textContent('#dbFetchSub')), await page.textContent('#dbFetchSub'));
  await page.screenshot({ path: SHOTS + '/2-after-fetch.png' });

  // 5. Pull
  await page.click('#dbPullBtn');
  await page.waitForFunction(() => /Pull xong|✗|conflict/.test(document.getElementById('dbStatus').textContent), null, { timeout: 20000 }).catch(() => {});
  ok('pull ok, 1 commit', /Pull xong — nhận 1 commit/.test(await st()), await st());
  ok('b.txt arrived in A', fs.existsSync(path.join(A, 'b.txt')));
  ok('behind badge cleared', (await page.textContent('#dbBehind')).trim() === '', await page.textContent('#dbBehind'));

  // 6. local commit -> Push suggested with ahead 1 -> Push
  fs.writeFileSync(path.join(A, 'c.txt'), 'c\n'); git(A, 'add', '.'); git(A, 'commit', '-qm', 'from A');
  await page.click('#dbFetchBtn');
  await page.waitForFunction(() => /Fetch xong|✗/.test(document.getElementById('dbStatus').textContent) && document.getElementById('dbStatus').dataset.state !== 'busy', null, { timeout: 20000 }).catch(() => {});
  ok('ahead badge = 1', (await page.textContent('#dbAhead')).trim() === '1', await page.textContent('#dbAhead'));
  ok('push suggested', await page.$eval('#dbPushBtn', (e) => e.classList.contains('suggest')));
  await page.click('#dbPushBtn');
  await page.waitForFunction(() => /Push xong|✗|Không có gì/.test(document.getElementById('dbStatus').textContent), null, { timeout: 20000 }).catch(() => {});
  ok('push ok', /Push xong/.test(await st()), await st());
  ok('remote has A commit', git(remote, 'log', '--format=%s', '-1', 'main').trim() === 'from A');
  // push again -> nothing to push
  await page.click('#dbPushBtn');
  await page.waitForFunction(() => document.getElementById('dbStatus').dataset.state !== 'busy', null, { timeout: 20000 }).catch(() => {});
  ok('push again -> nothing to push', /Không có gì để push|Push xong/.test(await st()), await st());

  // 7. rejected push (remote ahead) -> clear error hint
  fs.writeFileSync(path.join(B, 'd.txt'), 'd\n'); git(B, 'pull', '-q'); git(B, 'add', '.'); git(B, 'commit', '-qm', 'B2'); git(B, 'push', '-q');
  fs.writeFileSync(path.join(A, 'e.txt'), 'e\n'); git(A, 'add', '.'); git(A, 'commit', '-qm', 'A2');
  await page.click('#dbPushBtn');
  await page.waitForFunction(() => document.getElementById('dbStatus').dataset.state !== 'busy', null, { timeout: 20000 }).catch(() => {});
  ok('rejected push shows error + hint', /✗/.test(await st()) && /Pull/.test(await st()), await st());
  await page.screenshot({ path: SHOTS + '/3-rejected.png' });
  // pull (merge) then push succeeds
  await page.click('#dbPullBtn');
  await page.waitForFunction(() => document.getElementById('dbStatus').dataset.state !== 'busy', null, { timeout: 20000 }).catch(() => {});
  ok('pull merge after divergence', /Pull xong/.test(await st()), await st());
  await page.click('#dbPushBtn');
  await page.waitForFunction(() => document.getElementById('dbStatus').dataset.state !== 'busy', null, { timeout: 20000 }).catch(() => {});
  ok('push after merge', /Push xong/.test(await st()), await st());

  // 8. conflict -> Local Git view opens
  fs.writeFileSync(path.join(B, 'a.txt'), 'B side\n'); git(B, 'pull', '-q'); git(B, 'commit', '-qam', 'Bc'); git(B, 'push', '-q');
  fs.writeFileSync(path.join(A, 'a.txt'), 'A side\n'); git(A, 'commit', '-qam', 'Ac');
  await page.click('#dbPullBtn');
  await page.waitForFunction(() => document.getElementById('dbStatus').dataset.state !== 'busy', null, { timeout: 20000 }).catch(() => {});
  ok('conflict reported', /conflict/i.test(await st()), await st());
  ok('Local Git view shown', await vis('#view-local'));
  await page.screenshot({ path: SHOTS + '/4-conflict.png' });
  git(A, 'merge', '--abort');

  // 9. new branch -> Publish branch
  git(A, 'checkout', '-q', '-b', 'feature/x');
  await page.click('#navLocal'); await page.click('#refreshBranchesBtn'); await sleep(800);
  await page.click('#dbFetchBtn');
  await page.waitForFunction(() => document.getElementById('dbStatus').dataset.state !== 'busy', null, { timeout: 20000 }).catch(() => {});
  ok('Publish branch label', (await page.textContent('#dbPushText')).trim() === 'Publish branch', await page.textContent('#dbPushText'));
  await page.click('#dbPushBtn');
  await page.waitForFunction(() => document.getElementById('dbStatus').dataset.state !== 'busy', null, { timeout: 20000 }).catch(() => {});
  ok('publish ok', /publish/i.test(await st()), await st());
  ok('remote has feature/x', /feature\/x/.test(git(remote, 'branch')));
  ok('label back to Push origin', (await page.textContent('#dbPushText')).trim() === 'Push origin', await page.textContent('#dbPushText'));

  // 10. branch switch from toolbar
  await page.selectOption('#dbBranchSelect', 'main');
  await page.waitForFunction(() => document.getElementById('dbStatus').dataset.state !== 'busy', null, { timeout: 20000 }).catch(() => {});
  ok('checkout main via toolbar', git(A, 'branch', '--show-current').trim() === 'main', await st());

  // 11. Repositories tab -> open repo -> Clone / Open locally (real github.com public clone)
  await page.click('#navRepos');
  await page.waitForSelector('#repoList .repo, #repoList [data-full-name], #repoList a, #repoList div', { timeout: 15000 }).catch(() => {});
  await sleep(1500);
  const clicked = await page.evaluate(() => { const el = [...document.querySelectorAll('#repoList *')].find((e) => e.textContent.trim() === 'Extention-github-desktop' || e.textContent.trim() === 'nguyenvu133/Extention-github-desktop'); if (el) { el.click(); return true; } return false; });
  ok('repo listed + opened', clicked);
  await sleep(800);
  ok('toolbar still visible in repo view', await vis('#desktopBar') && await vis('#repoLocalBtn'));
  const dest = path.join(tmp, 'GitHub', 'Extention-github-desktop');
  prompts.push(dest);
  await page.click('#repoLocalBtn');
  await page.waitForFunction(() => /Clone xong|✗|Đã mở/.test(document.getElementById('dbStatus').textContent), null, { timeout: 120000 }).catch(() => {});
  ok('clone from github.com ok', /Clone xong/.test(await st()), await st());
  ok('clone dir exists', fs.existsSync(path.join(dest, '.git')));
  ok('token NOT written into cloned .git/config', !/BRIDGE_GIT_TOKEN|credential/.test(fs.readFileSync(path.join(dest, '.git/config'), 'utf8')));
  await page.screenshot({ path: SHOTS + '/5-cloned.png' });
  // fetch on real github remote
  await page.click('#dbFetchBtn');
  await page.waitForFunction(() => /Fetch xong|✗/.test(document.getElementById('dbStatus').textContent) && document.getElementById('dbStatus').dataset.state !== 'busy', null, { timeout: 60000 }).catch(() => {});
  ok('fetch github.com remote', /Fetch xong/.test(await st()), await st());
  await page.click('#dbPullBtn');
  await page.waitForFunction(() => document.getElementById('dbStatus').dataset.state !== 'busy', null, { timeout: 60000 }).catch(() => {});
  ok('pull github.com remote', /Pull xong/.test(await st()), await st());
  // second click -> opens existing
  prompts.length = 0;
  await page.click('#repoLocalBtn');
  await page.waitForFunction(() => /Đã mở|✗/.test(document.getElementById('dbStatus').textContent), null, { timeout: 15000 }).catch(() => {});
  ok('second click opens existing clone', /Đã mở repo có sẵn/.test(await st()), await st());
  // repo switcher lists both
  const opts = await page.$$eval('#dbRepoSelect option', (o) => o.map((x) => x.value));
  ok('switcher lists both repos', opts.includes(A) && opts.includes(dest), JSON.stringify(opts));
  await page.selectOption('#dbRepoSelect', A);
  await page.waitForFunction(() => /Đã chọn repo/.test(document.getElementById('dbStatus').textContent), null, { timeout: 15000 }).catch(() => {});
  ok('switch back to work-a', /work-a/.test(await st()), await st());

  // 12. narrow window layout
  await page.setViewportSize({ width: 820, height: 900 }); await sleep(300);
  await page.screenshot({ path: SHOTS + '/6-narrow.png' });
  await page.setViewportSize({ width: 1440, height: 900 });

  // 12b. popup buttons (Fetch / Pull / Push) — start from a clean state
  git(A, 'fetch', '-q', 'origin'); git(A, 'reset', '-q', '--hard', 'origin/main');
  fs.writeFileSync(path.join(A, 'p.txt'), 'popup\n'); git(A, 'add', '.'); git(A, 'commit', '-qm', 'popup commit');
  const pop = await ctx.newPage();
  pop.on('pageerror', (e) => errors.push('popup: ' + e.message));
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await sleep(1200);
  for (const [action, re] of [['fetch', /Fetch ✓/], ['pull', /Pull ✓|conflict/], ['push', /Push ✓/]]) {
    await pop.click(`[data-action="${action}"]`);
    await pop.waitForFunction((r) => new RegExp(r).test(document.getElementById('message').textContent) || /ERROR|✗|lỗi/i.test(document.getElementById('message').textContent), re.source, { timeout: 20000 }).catch(() => {});
    const m = await pop.textContent('#message');
    ok(`popup ${action}`, re.test(m), m);
  }
  ok('popup push reached remote', git(remote, 'log', '--format=%s', '-1', 'main').trim() === 'popup commit');
  await pop.close();

  // 13. bridge goes down -> buttons disabled + message
  const exited = new Promise((r) => bridge.once('exit', r));
  bridge.kill('SIGTERM');
  await Promise.race([exited, sleep(8000)]);
  ok('bridge process exited', bridge.exitCode !== null || bridge.signalCode !== null);
  for (let i = 0; i < 6; i++) { await page.evaluate(() => health()).catch(() => {}); if (await page.$eval('#dbFetchBtn', (e) => e.disabled)) break; await sleep(500); }
  ok('offline -> fetch disabled', await page.$eval('#dbFetchBtn', (e) => e.disabled));
  ok('offline message', /Bridge chưa kết nối/.test(await st()), await st());
  await page.screenshot({ path: SHOTS + '/7-offline.png' });

  const realErrors = errors.filter((e) => !/Failed to load resource|ERR_CONNECTION_REFUSED|net::/.test(e));
  ok('no page JS errors', realErrors.length === 0, realErrors.join(' | '));
  await ctx.close(); ms.close();
  if (fail) console.log(blog.split('\n').slice(-30).join('\n'));
  console.log(`\ne2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
