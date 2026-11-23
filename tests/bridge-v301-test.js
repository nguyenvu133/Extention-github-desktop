'use strict';
require('./_node16-fetch'); // v3.1.0: Node 16.13 has no global fetch

/*
 * Bridge v3.0.1 functional test harness — fix "ERROR: Failed to fetch"
 * when clicking sign-in.
 *
 * Starts the REAL bridge (bridge/bridge-server.js) as a child process
 * on a test port, pointed at a FAKE GitHub (a local HTTP server in this
 * file — no call to api.github.com or github.com is ever made), then:
 *
 *   - bridge-client.js: translateBridgeError() turns every network
 *     failure (TypeError "Failed to fetch", ECONNREFUSED, timeout)
 *     into BRIDGE_UNREACHABLE / BRIDGE_TIMEOUT with a Vietnamese
 *     message that NEVER contains "Failed to fetch"
 *   - bridgeFetch() against a DEAD port (nothing listening) rejects
 *     with BRIDGE_UNREACHABLE (a real kill, not a mocked fetch)
 *   - CORS preflight: raw OPTIONS from a chrome-extension:// origin,
 *     a http://localhost:3000 origin and a null (file://) origin are
 *     allowed; an unrelated https origin gets NO Access-Control-
 *     Allow-Origin header
 *   - GET /api/connection-test: 200 with the bridge token, 401
 *     without it
 *   - checkConnectionSteps(): all steps pass on the live bridge;
 *     against the dead port step 1 fails with "Bridge chưa chạy"
 *   - kill the bridge mid-test -> BRIDGE_UNREACHABLE; restart it
 *     (same data dir) -> healthy again
 *   - dashboard.js + popup.js in a vm with a DEAD bridge URL: login
 *     buttons are disabled, the log/message shows the Vietnamese
 *     guide, and clicking CONNECT GITHUB logs "Bridge chưa chạy" —
 *     never "Failed to fetch"
 *   - start scripts: start-mac-linux.sh with node hidden from PATH
 *     exits 1 with a clear "Node.js chua duoc cai dat" message;
 *     with node present it starts a real bridge; start-windows.bat
 *     contains the node check + pause + v3.0.1
 *   - login diagnostics still pass when the bridge is up
 *
 * Usage:
 *   node tests/bridge-v301-test.js
 *
 * The bridge under test writes its token/config into a temp directory
 * (BRIDGE_DATA_DIR), so nothing in bridge/ is touched (except the
 * start-script test, which runs a COPY of the bridge in a temp dir).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const BRIDGE_ENTRY = path.join(ROOT, 'bridge', 'bridge-server.js');
const MOCK_PORT = 17404;
const BRIDGE_PORT = 17395;
const DEAD_PORT = 17499; // nothing ever listens here
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
const DEAD_BASE = `http://127.0.0.1:${DEAD_PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

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
/* Fake GitHub (reachability only — diagnostics fetches /)             */
/* ------------------------------------------------------------------ */

function mockHandler(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

/* ------------------------------------------------------------------ */
/* Bridge spawner                                                      */
/* ------------------------------------------------------------------ */

function startBridge(port, dataDir, extraEnv) {
  const proc = spawn(process.execPath, [BRIDGE_ENTRY], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_DATA_DIR: dataDir,
      GITHUB_API_BASE: MOCK_BASE,
      GITHUB_OAUTH_BASE: MOCK_BASE,
      GITHUB_CODELOAD_BASE: MOCK_BASE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const box = { proc, out: '' };
  proc.stdout.on('data', (d) => { box.out += d.toString('utf8'); });
  proc.stderr.on('data', (d) => { box.out += d.toString('utf8'); });
  return box;
}

async function waitListening(box) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (box.out.includes('Listening:')) return true;
    if (box.proc.exitCode !== null) return false;
    await sleep(100);
  }
  return false;
}

async function waitExit(proc) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return true;
    await sleep(50);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Minimal DOM + chrome shim (same shape as tests/extension-test.js)   */
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
    this.disabled = false;
    this.src = '';
    this.alt = '';
    this.href = '';
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

function makeDocument() {
  const map = new Map();
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
      },
    },
    runtime: {
      getManifest: () => ({ version: '3.6.0' }),
      getURL: (p) => 'chrome-extension://test/' + p,
      id: 'test-extension-id',
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    tabs: { create: async () => ({}) },
  };
}

function runScripts(files, store, opts) {
  const document = makeDocument();
  const chrome = makeChrome(store);
  // opts.noRuntimeId simulates opening dashboard.html outside the
  // extension (no chrome.runtime.id) — for the outside-extension test.
  if (opts && opts.noRuntimeId) delete chrome.runtime.id;
  const sandbox = {
    document,
    chrome,
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
    window: { close() {}, open: () => ({}) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of files) {
    const code = fs.readFileSync(path.join(EXT, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
  return { document, sandbox };
}

function rawRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* Test runner                                                         */
/* ------------------------------------------------------------------ */

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v301-test-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const mock = http.createServer(mockHandler);
  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

  let bridge = startBridge(BRIDGE_PORT, dataDir, {});
  const cleanup = (code) => {
    try { bridge.proc.kill('SIGTERM'); } catch (_) {}
    try { mock.close(); } catch (_) {}
    if (failures > 0) {
      console.log('\n--- bridge log (last 40 lines) ---');
      console.log(bridge.out.split('\n').slice(-40).join('\n'));
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nbridge-v301: ${passes} passed, ${failures} failed`);
    process.exit(code);
  };

  if (!(await waitListening(bridge))) {
    console.log('  FAIL  bridge starts -> ' + bridge.out.slice(-500));
    cleanup(1);
    return;
  }
  check('bridge starts', true);

  const token = fs.readFileSync(path.join(dataDir, '.bridge-token'), 'utf8').trim();
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  async function call(method, p, body) {
    const res = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }

  /* ==================== 0. VERSION ==================== */
  console.log('\n[0] version');
  {
    const h = await call('GET', '/health');
    check('health reports v3.0.1', h.version === '3.6.0', JSON.stringify(h.version));
  }

  /* ==================== 1. bridge-client: translate ==================== */
  console.log('\n[1] bridge-client.js — error translation');
  {
    const client = fs.readFileSync(path.join(EXT, 'bridge-client.js'), 'utf8');
    const sb = { fetch, console, setTimeout, clearTimeout, setInterval, clearInterval, URL };
    sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(client, sb, { filename: 'bridge-client.js' });
    const t = (expr) => vm.runInContext(expr, sb);

    const cases = [
      ['TypeError Failed to fetch', "new TypeError('Failed to fetch')"],
      ['NetworkError', "Object.assign(new Error('NetworkError when attempting to fetch resource.'), { name: 'TypeError' })"],
      ['ECONNREFUSED code', "Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:17321'), { code: 'ECONNREFUSED' })"],
      ['ENOTFOUND code', "Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' })"],
    ];
    for (const [name, expr] of cases) {
      const r = t(`translateBridgeError(${expr})`);
      check(`translate: ${name} -> BRIDGE_UNREACHABLE + Vietnamese`,
        r.code === 'BRIDGE_UNREACHABLE' && /Bridge chưa chạy/.test(r.message) && !/Failed to fetch/.test(r.message),
        JSON.stringify(r).slice(0, 200));
    }
    const timeout = t("translateBridgeError(Object.assign(new Error('x'), { code: 'BRIDGE_TIMEOUT' }))");
    check('translate: timeout -> BRIDGE_TIMEOUT', timeout.code === 'BRIDGE_TIMEOUT' && /quá chậm/.test(timeout.message), JSON.stringify(timeout).slice(0, 160));
    const http500 = t("translateBridgeError(new Error('HTTP 500'))");
    check('translate: HTTP 500 passes through (no fake unreachable)',
      http500.code !== 'BRIDGE_UNREACHABLE' && http500.message === 'HTTP 500', JSON.stringify(http500).slice(0, 120));
    check('isExtensionContext() false in Node vm', t('isExtensionContext()') === false);
    check('BRIDGE_START_GUIDE has 3 steps',
      /1\. Windows/.test(t('BRIDGE_START_GUIDE')) && /2\. Mac\/Linux/.test(t('BRIDGE_START_GUIDE')) && /3\. Đợi/.test(t('BRIDGE_START_GUIDE')));
  }

  /* ==================== 2. bridgeFetch vs a DEAD port ==================== */
  console.log('\n[2] bridgeFetch against a dead port (real kill, not mocked fetch)');
  {
    const client = fs.readFileSync(path.join(EXT, 'bridge-client.js'), 'utf8');
    const sb = { fetch, console, setTimeout, clearTimeout, setInterval, clearInterval, URL };
    sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(client, sb, { filename: 'bridge-client.js' });
    let caught = null;
    try {
      await vm.runInContext(`bridgeFetch('${DEAD_BASE}/health', undefined, 5000)`, sb);
    } catch (err) { caught = err; }
    check('bridgeFetch(dead port) rejects BRIDGE_UNREACHABLE',
      !!caught && caught.code === 'BRIDGE_UNREACHABLE', caught ? caught.code + ' / ' + String(caught.message).slice(0, 80) : 'no error thrown');
    check('bridgeFetch(dead port) message is Vietnamese, no "Failed to fetch"',
      !!caught && /Bridge chưa chạy/.test(caught.message) && !/Failed to fetch/.test(caught.message),
      caught ? String(caught.message).slice(0, 160) : '');

    let healthErr = null;
    try {
      await vm.runInContext(`checkBridgeHealth('${DEAD_BASE}')`, sb);
    } catch (err) { healthErr = err; }
    check('checkBridgeHealth(dead port) rejects BRIDGE_UNREACHABLE',
      !!healthErr && healthErr.code === 'BRIDGE_UNREACHABLE', healthErr ? String(healthErr.code) : 'no error');

    const steps = await vm.runInContext(`checkConnectionSteps('${DEAD_BASE}', '')`, sb);
    check('checkConnectionSteps(dead port): step 1 fails, stops early',
      Array.isArray(steps) && steps.length === 1 && steps[0].key === 'bridge' && steps[0].ok === false,
      JSON.stringify(steps).slice(0, 200));
    check('checkConnectionSteps(dead port): Vietnamese fix, no "Failed to fetch"',
      steps[0] && /Bridge chưa chạy/.test(steps[0].detail || '') && !/Failed to fetch/.test(JSON.stringify(steps)),
      JSON.stringify(steps).slice(0, 200));
  }

  /* ==================== 3. CORS preflight ==================== */
  console.log('\n[3] CORS preflight (raw OPTIONS)');
  {
    const opts = async (origin) => rawRequest({
      host: '127.0.0.1', port: BRIDGE_PORT, path: '/api/connection-test', method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });
    const ext = await opts('chrome-extension://abcdefghijklmnop');
    check('CORS: chrome-extension:// origin allowed (204 + ACAO echo)',
      ext.status === 204 && ext.headers['access-control-allow-origin'] === 'chrome-extension://abcdefghijklmnop',
      `status ${ext.status}, ACAO ${ext.headers['access-control-allow-origin']}`);
    check('CORS: preflight allows Authorization header',
      /authorization/i.test(ext.headers['access-control-allow-headers'] || ''),
      ext.headers['access-control-allow-headers'] || '(none)');
    const local = await opts('http://localhost:3000');
    check('CORS: http://localhost:3000 origin allowed (v3.0.1)',
      local.status === 204 && local.headers['access-control-allow-origin'] === 'http://localhost:3000',
      `status ${local.status}, ACAO ${local.headers['access-control-allow-origin']}`);
    const file = await opts('null');
    check('CORS: null origin (file://) allowed with ACAO: null',
      file.status === 204 && file.headers['access-control-allow-origin'] === 'null',
      `status ${file.status}, ACAO ${file.headers['access-control-allow-origin']}`);
    const evil = await opts('https://evil.example.com');
    check('CORS: unrelated https origin gets NO Allow-Origin header',
      !('access-control-allow-origin' in evil.headers),
      `ACAO ${evil.headers['access-control-allow-origin'] || '(absent)'}`);
  }

  /* ==================== 4. /api/connection-test ==================== */
  console.log('\n[4] GET /api/connection-test');
  {
    const ok = await call('GET', '/api/connection-test');
    check('connection-test with token -> 200 ok + v3.0.1',
      ok.status === 200 && ok.ok === true && ok.version === '3.6.0', JSON.stringify(ok).slice(0, 160));
    const noAuth = await fetch(BASE + '/api/connection-test');
    check('connection-test without token -> 401', noAuth.status === 401, 'status ' + noAuth.status);
  }

  /* ==================== 5. checkConnectionSteps (live bridge) ==================== */
  console.log('\n[5] checkConnectionSteps on the live bridge');
  {
    const client = fs.readFileSync(path.join(EXT, 'bridge-client.js'), 'utf8');
    const sb = { fetch, console, setTimeout, clearTimeout, setInterval, clearInterval, URL };
    sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(client, sb, { filename: 'bridge-client.js' });
    const steps = await vm.runInContext(`checkConnectionSteps('${BASE}', '${token}')`, sb);
    const byKey = (k) => (steps || []).find((s) => s.key === k) || {};
    check('checkConnectionSteps: 5 steps returned',
      Array.isArray(steps) && steps.length === 5, 'got ' + (steps || []).length);
    check('checkConnectionSteps: bridge step ok', byKey('bridge').ok === true, JSON.stringify(byKey('bridge')));
    check('checkConnectionSteps: port step ok', byKey('port').ok === true, JSON.stringify(byKey('port')));
    check('checkConnectionSteps: cors step ok (preflighted authed request)',
      byKey('cors').ok === true, JSON.stringify(byKey('cors')));
    check('checkConnectionSteps: health step ok', byKey('health').ok === true, JSON.stringify(byKey('health')));
    check('checkConnectionSteps: oauth step present (unconfigured here, still ok:true)',
      byKey('oauth').ok === true && /chưa cấu hình/.test(byKey('oauth').detail || ''), JSON.stringify(byKey('oauth')));
    check('checkConnectionSteps: no "Failed to fetch" anywhere',
      !/Failed to fetch/.test(JSON.stringify(steps)), JSON.stringify(steps).slice(0, 200));
  }

  /* ==================== 6. kill bridge mid-test ==================== */
  console.log('\n[6] kill the bridge, then restart it (same data dir)');
  {
    bridge.proc.kill('SIGTERM');
    await waitExit(bridge.proc);
    check('bridge killed', bridge.proc.exitCode !== null, 'exitCode ' + bridge.proc.exitCode);
    const client = fs.readFileSync(path.join(EXT, 'bridge-client.js'), 'utf8');
    const sb = { fetch, console, setTimeout, clearTimeout, setInterval, clearInterval, URL };
    sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(client, sb, { filename: 'bridge-client.js' });
    let caught = null;
    try {
      await vm.runInContext(`bridgeFetch('${BASE}/health', undefined, 5000)`, sb);
    } catch (err) { caught = err; }
    check('after kill: bridgeFetch -> BRIDGE_UNREACHABLE (Vietnamese)',
      !!caught && caught.code === 'BRIDGE_UNREACHABLE' && /Bridge chưa chạy/.test(caught.message),
      caught ? caught.code : 'no error');
    bridge = startBridge(BRIDGE_PORT, dataDir, {});
    check('bridge restarts', await waitListening(bridge));
    const h = await call('GET', '/health');
    check('after restart: /health ok again', h.ok === true && h.version === '3.6.0', JSON.stringify(h).slice(0, 120));
    const tokenStill = fs.readFileSync(path.join(dataDir, '.bridge-token'), 'utf8').trim();
    check('bridge token survives restart (same data dir)', tokenStill === token);
  }

  /* ==================== 7. dashboard in vm, bridge DEAD ==================== */
  console.log('\n[7] dashboard.js in vm — bridge URL points at a dead port');
  {
    const store = { bridgeUrl: DEAD_BASE, token };
    const dash = runScripts(['bridge-client.js', 'dashboard.js'], store);
    await sleep(1500);
    const d = dash.document;
    const logText = d.getElementById('log').textContent;
    check('dashboard boot: log shows Vietnamese guide, no "Failed to fetch"',
      /Bridge chưa chạy/.test(logText) && !/Failed to fetch/.test(logText), logText.slice(0, 200));
    check('dashboard boot: CONNECT GITHUB disabled while bridge is down',
      d.getElementById('oauthConnectBtn').disabled === true);
    check('dashboard boot: Device Flow button disabled while bridge is down',
      d.getElementById('deviceFlowBtn').disabled === true);
    check('dashboard boot: PAT button disabled while bridge is down',
      d.getElementById('loginPatBtn').disabled === true);
    check('dashboard boot: bridge-down notice is visible',
      d.getElementById('bridgeDownNotice').classList.contains('hidden') === false);
    check('dashboard boot: notice text has the 3-step guide',
      /1\. Windows/.test(d.getElementById('bridgeDownNoticeText').textContent) &&
      /2\. Mac\/Linux/.test(d.getElementById('bridgeDownNoticeText').textContent));
    check('dashboard boot: outside-extension notice hidden (vm pretends to be the extension)',
      d.getElementById('outsideExtensionNotice').classList.contains('hidden') === true);
    check('dashboard boot: isExtensionContext() true inside the extension',
      vm.runInContext('isExtensionContext()', dash.sandbox) === true);

    // Same page opened WITHOUT chrome.runtime.id (plain file / web page):
    // the notice must show, and the context check must say so.
    const dashPlain = runScripts(['bridge-client.js', 'dashboard.js'], { bridgeUrl: DEAD_BASE, token }, { noRuntimeId: true });
    await sleep(1500);
    check('outside-extension context: isExtensionContext() false',
      vm.runInContext('isExtensionContext()', dashPlain.sandbox) === false);
    check('outside-extension context: notice is shown',
      dashPlain.document.getElementById('outsideExtensionNotice').classList.contains('hidden') === false);
    try { vm.runInContext('clearInterval(healthTimer)', dashPlain.sandbox); } catch (_) {}
    try { vm.runInContext('stopEventStream()', dashPlain.sandbox); } catch (_) {}
    check('dashboard boot: bridge status DISCONNECTED',
      d.getElementById('bridgeStatus').textContent === 'BRIDGE DISCONNECTED',
      d.getElementById('bridgeStatus').textContent);

    let gateErr = null;
    try {
      await vm.runInContext('ensureBridgeUp()', dash.sandbox);
    } catch (err) { gateErr = err; }
    check('ensureBridgeUp() throws BRIDGE_UNREACHABLE when bridge is down',
      !!gateErr && gateErr.code === 'BRIDGE_UNREACHABLE', gateErr ? String(gateErr.code) : 'no error');

    // Click CONNECT GITHUB while the bridge is down: must log the
    // Vietnamese guide, never the raw browser error.
    d.getElementById('oauthConnectBtn').onclick();
    await sleep(800);
    const afterClick = d.getElementById('log').textContent;
    check('click CONNECT GITHUB (bridge down): log is Vietnamese, no "Failed to fetch"',
      /Bridge chưa chạy/.test(afterClick) && !/Failed to fetch/.test(afterClick), afterClick.slice(0, 240));

    // Connection diagnostics panel against the dead port.
    const steps = await vm.runInContext('runConnectionDiagnostics()', dash.sandbox);
    check('runConnectionDiagnostics(dead port): step 1 fails with Vietnamese fix',
      Array.isArray(steps) && steps.length === 1 && steps[0].ok === false && /Bridge chưa chạy/.test(steps[0].detail || ''),
      JSON.stringify(steps).slice(0, 200));
    check('runConnectionDiagnostics(dead port): panel status shows the failure count',
      /1\/1 bước chưa đạt/.test(d.getElementById('connDiagStatus').textContent),
      d.getElementById('connDiagStatus').textContent);

    try { vm.runInContext('clearInterval(healthTimer)', dash.sandbox); } catch (_) {}
    try { vm.runInContext('stopEventStream()', dash.sandbox); } catch (_) {}
  }

  /* ==================== 8. popup in vm, bridge DEAD ==================== */
  console.log('\n[8] popup.js in vm — bridge URL points at a dead port');
  {
    const store = { bridgeUrl: DEAD_BASE, token };
    const pop = runScripts(['bridge-client.js', 'popup.js'], store);
    await sleep(1200);
    const d = pop.document;
    check('popup boot: DISCONNECTED',
      d.getElementById('connection').textContent === 'DISCONNECTED',
      d.getElementById('connection').textContent);
    const msg = d.getElementById('message').textContent;
    check('popup boot: message is Vietnamese, no "Failed to fetch"',
      /Bridge chưa chạy/.test(msg) && !/Failed to fetch/.test(msg), msg.slice(0, 200));
    check('popup boot: detail line has the start guide',
      /start-windows\.bat/.test(d.getElementById('bridgeDetail').textContent),
      d.getElementById('bridgeDetail').textContent.slice(0, 160));
    check('popup boot: version v3.0.1', d.getElementById('version').textContent === 'v3.6.0',
      d.getElementById('version').textContent);
    try { vm.runInContext('clearInterval(pollTimer)', pop.sandbox); } catch (_) {}
  }

  /* ==================== 9. start scripts ==================== */
  console.log('\n[9] start scripts');
  {
    // 9a. start-mac-linux.sh with node hidden from PATH -> clear error, exit 1.
    const binDir = path.join(tmp, 'nodeless-bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const tool of ['dirname', 'readlink']) {
      const src = '/usr/bin/' + tool;
      if (fs.existsSync(src)) fs.symlinkSync(src, path.join(binDir, tool));
    }
    const sh = spawn('/bin/sh', [path.join(ROOT, 'bridge', 'start-mac-linux.sh')], {
      env: { ...process.env, PATH: binDir, BRIDGE_PORT: '17393' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let shOut = '';
    sh.stdout.on('data', (d) => { shOut += d.toString('utf8'); });
    sh.stderr.on('data', (d) => { shOut += d.toString('utf8'); });
    const shCode = await new Promise((resolve) => sh.on('close', resolve));
    check('start-mac-linux.sh without node: exits 1 with a clear message',
      shCode === 1 && /Node\.js chua duoc cai dat/.test(shOut) && /nodejs\.org/.test(shOut),
      `exit ${shCode}, out: ${shOut.slice(0, 200)}`);
    check('start-mac-linux.sh without node: does NOT try to start the bridge',
      !/Listening:/.test(shOut));

    // 9b. start-mac-linux.sh with node present starts a real bridge
    // (from a COPY, so bridge/ on disk is untouched).
    const copyDir = path.join(tmp, 'bridge-copy');
    fs.mkdirSync(copyDir, { recursive: true });
    fs.copyFileSync(BRIDGE_ENTRY, path.join(copyDir, 'bridge-server.js'));
    fs.copyFileSync(path.join(ROOT, 'bridge', 'start-mac-linux.sh'), path.join(copyDir, 'start-mac-linux.sh'));
    const copyData = path.join(tmp, 'copy-data');
    fs.mkdirSync(copyData, { recursive: true });
    const sh2 = spawn('/bin/sh', [path.join(copyDir, 'start-mac-linux.sh')], {
      env: { ...process.env, BRIDGE_PORT: '17393', BRIDGE_DATA_DIR: copyData },
      stdio: ['ignore', 'pipe', 'pipe'],
      // v3.0.1: detached process group — killing the group stops the
      // node child too (killing only the sh parent used to orphan it).
      detached: true,
    });
    let sh2Out = '';
    sh2.stdout.on('data', (d) => { sh2Out += d.toString('utf8'); });
    sh2.stderr.on('data', (d) => { sh2Out += d.toString('utf8'); });
    const started2 = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 15000);
      const onData = () => { if (sh2Out.includes('Listening:')) { clearTimeout(timer); resolve(true); } };
      sh2.stdout.on('data', onData);
      sh2.stderr.on('data', onData);
      sh2.on('exit', () => { clearTimeout(timer); resolve(false); });
    });
    check('start-mac-linux.sh with node: bridge starts (Listening:)',
      started2 === true, sh2Out.slice(-300));
    if (started2) {
      const h2 = await fetch('http://127.0.0.1:17393/health').then((r) => r.json()).catch(() => ({}));
      check('start-mac-linux.sh bridge: /health ok, v3.0.1',
        h2.ok === true && h2.version === '3.6.0', JSON.stringify(h2).slice(0, 120));
    }
    try { process.kill(-sh2.pid, 'SIGTERM'); } catch (_) { try { sh2.kill('SIGTERM'); } catch (_) {} }
    await sleep(300);

    // 9c. start-windows.bat: static checks (cannot run .bat on Linux).
    const bat = fs.readFileSync(path.join(ROOT, 'bridge', 'start-windows.bat'), 'utf8');
    check('start-windows.bat: checks node is installed before starting',
      /where node/.test(bat) && /Node\.js chua duoc cai dat/.test(bat), bat.slice(0, 200));
    check('start-windows.bat: pauses so the user can read errors',
      /pause/.test(bat));
    check('start-windows.bat: version string v3.6.0',
      /v3\.6\.0/.test(bat));
    const shText = fs.readFileSync(path.join(ROOT, 'bridge', 'start-mac-linux.sh'), 'utf8');
    check('start-mac-linux.sh: version string v3.6.0', /v3\.6\.0/.test(shText));
  }

  /* ==================== 10. login diagnostics (bridge up) ==================== */
  console.log('\n[10] login diagnostics still pass when the bridge is up');
  {
    const diag = await call('GET', '/api/github/login/diagnostics');
    check('diagnostics: 200 + 6 checks',
      diag.ok === false && Array.isArray(diag.checks) && diag.checks.length === 6,
      JSON.stringify(diag).slice(0, 200));
    const bridgeCheck = (diag.checks || []).find((c) => c.key === 'bridge');
    check('diagnostics: bridge check ok', bridgeCheck && bridgeCheck.ok === true, JSON.stringify(bridgeCheck));
    const reach = (diag.checks || []).find((c) => c.key === 'reachability');
    check('diagnostics: reachability check ok (mock github.com)',
      reach && reach.ok === true, JSON.stringify(reach));
  }

  cleanup(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('bridge-v301 crashed:', err);
  process.exit(1);
});
