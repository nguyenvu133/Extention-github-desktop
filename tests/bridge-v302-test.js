'use strict';
require('./_node16-fetch'); // v3.1.0: Node 16.13 has no global fetch

/*
 * Bridge v3.0.2 functional test harness — fix "start-windows.bat does
 * not open" on Windows (double-click does nothing / window flashes
 * and closes), blocking the bridge and sign-in.
 *
 * Diagnosis (verified on the file bytes, not guessed): the v3.0.1
 * .bat was UTF-8 with LF-only line endings (grep -c $'\r' = 0) and
 * contained a non-ASCII em-dash — cmd.exe expects CRLF and can
 * misparse such a file, so the window closed before showing any error.
 *
 * What this harness checks:
 *
 *   - start-windows.bat BYTES: CRLF on every line, 100% ASCII,
 *     no BOM, and the required pieces (node check + major >= 18,
 *     bridge-server.js check, netstat port check, bridge-start.log,
 *     pause on every exit path, /health wait, v3.0.2). The .bat CANNOT
 *     be executed on Linux (no cmd.exe here) — the byte + structure
 *     checks are the honest substitute, and this limit is documented
 *     in docs/BRIDGE_V2.md section 8.
 *   - start-windows.ps1: UTF-8 BOM, ASCII after the BOM, balanced
 *     braces, same 5 checks as the .bat (node / version / file /
 *     port / /health), log + Read-Host pause.
 *   - bridge-doctor.bat: same byte rules as the .bat (CRLF/ASCII/
 *     no BOM) + report file + checks. bridge-doctor.sh: runs FOR
 *     REAL on Linux (a copy in a temp dir) — once against a live
 *     bridge (report says /health OK) and once against a dead port
 *     (report says no answer).
 *   - start-mac-linux.sh: runs a REAL bridge copy in a temp dir —
 *     /health 200 + version 3.1.0.
 *   - the bridge itself: `node bridge-server.js` on a test port —
 *     /health 200 + version 3.1.0 and /api/connection-test 200
 *     (proves the bridge runs fine; only the launcher was broken).
 *   - README covers the .bat failure (extract ZIP, Node.js,
 *     SmartScreen/Unblock, manual cmd run, doctor, start-windows.ps1,
 *     bridge-start.log).
 *   - BRIDGE_START_GUIDE names the new fallbacks (.ps1 + doctor);
 *     .gitignore covers the doctor report.
 *
 * Usage:
 *   node tests/bridge-v302-test.js
 *
 * The bridges under test write their token/config into temp
 * directories (BRIDGE_DATA_DIR), so nothing in bridge/ is touched
 * (except the launcher/doctor tests, which run COPIES in temp dirs).
 * No call to api.github.com or github.com is ever made.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_ENTRY = path.join(ROOT, 'bridge', 'bridge-server.js');
const MOCK_PORT = 17403;
const BRIDGE_PORT = 17394;
const SH_PORT = 17392;
const DEAD_PORT = 17498; // nothing ever listens here
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
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
/* Byte rules for Windows batch files                                  */
/* ------------------------------------------------------------------ */

// Every line CRLF, 100% ASCII, no BOM. Returns {ok, detail}.
function checkBatchBytes(buf, label) {
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  check(`${label}: no UTF-8 BOM`, !hasBom);
  let nonAscii = 0;
  for (const b of buf) if (b >= 128) nonAscii += 1;
  check(`${label}: 100% ASCII (0 non-ASCII bytes)`, nonAscii === 0, `${nonAscii} non-ASCII bytes`);
  const crCount = [...buf].filter((b) => b === 0x0d).length;
  const lfCount = [...buf].filter((b) => b === 0x0a).length;
  check(`${label}: CRLF on every line (CR == LF)`, crCount === lfCount && lfCount > 0, `CR=${crCount} LF=${lfCount}`);
  // No CR except immediately before an LF (no bare CR, no stray CR).
  let bareCr = false;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0d && buf[i + 1] !== 0x0a) { bareCr = true; break; }
  }
  check(`${label}: no bare CR`, !bareCr);
  return buf.toString('utf8');
}

/* ------------------------------------------------------------------ */
/* Fake GitHub (reachability only)                                     */
/* ------------------------------------------------------------------ */

function mockHandler(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

/* ------------------------------------------------------------------ */
/* Bridge spawner                                                      */
/* ------------------------------------------------------------------ */

function startBridge(port, dataDir) {
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

async function waitFile(file, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 10000);
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await sleep(100);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Test runner                                                         */
/* ------------------------------------------------------------------ */

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v302-test-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const mock = http.createServer(mockHandler);
  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

  let bridge = startBridge(BRIDGE_PORT, dataDir);
  let shProc = null;
  const cleanup = (code) => {
    try { bridge.proc.kill('SIGTERM'); } catch (_) {}
    if (shProc) {
      try { process.kill(-shProc.pid, 'SIGTERM'); } catch (_) { try { shProc.kill('SIGTERM'); } catch (_) {} }
    }
    try { mock.close(); } catch (_) {}
    if (failures > 0) {
      console.log('\n--- bridge log (last 40 lines) ---');
      console.log(bridge.out.split('\n').slice(-40).join('\n'));
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nbridge-v302: ${passes} passed, ${failures} failed`);
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
    const rootManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const extManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge', 'package.json'), 'utf8'));
    check('root manifest version 3.7.0', rootManifest.version === '3.7.0', JSON.stringify(rootManifest.version));
    check('extension manifest version 3.7.0', extManifest.version === '3.7.0', JSON.stringify(extManifest.version));
    check('bridge package.json version 3.7.0 + test:v302 script',
      pkg.version === '3.7.0' && typeof pkg.scripts['test:v302'] === 'string', JSON.stringify(pkg.scripts));
    const h = await call('GET', '/health');
    check('health reports v3.7.0', h.ok === true && h.version === '3.7.0', JSON.stringify(h.version));
    const ct = await call('GET', '/api/connection-test');
    check('connection-test 200 ok + v3.7.0',
      ct.status === 200 && ct.ok === true && ct.version === '3.7.0', JSON.stringify(ct).slice(0, 160));
  }

  /* ==================== 1. start-windows.bat BYTES ==================== */
  console.log('\n[1] start-windows.bat — bytes (cannot run cmd.exe on Linux)');
  let batText = '';
  {
    const buf = fs.readFileSync(path.join(ROOT, 'bridge', 'start-windows.bat'));
    batText = checkBatchBytes(buf, 'start-windows.bat');
    const need = [
      ['checks node is installed', /where node/],
      ['checks Node version >= 16.13', /LSS 16/ && /EQU 16 if %NODEMINOR% LSS 13/],
      ['checks bridge-server.js exists', /if not exist bridge-server\.js/],
      ['checks port with netstat', /netstat/],
      ['logs to bridge-start.log', /bridge-start\.log/],
      ['pauses so the user can read errors', /pause/],
      ['waits for /health', /\/health/],
      ['tries curl first, PowerShell fallback', /curl\.exe/ && /powershell/],
      ['version string v3.7.0', /v3\.7\.0/],
      ['prints TOKEN from the log', /TOKEN:/],
      ['space before >> in :log (digit-eating fix)', /echo %~1 >> /],
    ];
    for (const [name, re] of need) {
      check(`start-windows.bat: ${name}`, re.test(batText), batText.slice(0, 200));
    }
    // Structure: balanced parens/braces (batch is easy to break blind).
    const opens = (batText.match(/\(/g) || []).length;
    const closes = (batText.match(/\)/g) || []).length;
    check('start-windows.bat: balanced parens', opens === closes, `(${opens} vs )${closes}`);
    const braceOpens = (batText.match(/\{/g) || []).length;
    const braceCloses = (batText.match(/\}/g) || []).length;
    check('start-windows.bat: balanced braces', braceOpens === braceCloses, `{${braceOpens} vs }${braceCloses}`);
    // No call :log with a message that delayed expansion would eat.
    check('start-windows.bat: no ! inside :log messages',
      !/^call :log ".*!.*"/m.test(batText));
  }

  /* ==================== 2. start-windows.ps1 ==================== */
  console.log('\n[2] start-windows.ps1 — bytes + structure');
  {
    const buf = fs.readFileSync(path.join(ROOT, 'bridge', 'start-windows.ps1'));
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    check('start-windows.ps1: UTF-8 BOM present', hasBom);
    let nonAscii = 0;
    for (const b of buf.slice(3)) if (b >= 128) nonAscii += 1;
    check('start-windows.ps1: ASCII after BOM (0 non-ASCII bytes)', nonAscii === 0, `${nonAscii} non-ASCII bytes`);
    const ps = buf.slice(3).toString('utf8');
    const need = [
      ['checks node is installed', /Get-Command node/],
      ['checks Node version >= 16.13', /-lt 16 -or/],
      ['checks bridge-server.js exists', /Test-Path 'bridge-server\.js'/],
      ['checks port', /BeginConnect/],
      ['logs to bridge-start.log', /bridge-start\.log/],
      ['waits for /health', /Invoke-WebRequest/ && /\/health/],
      ['pauses at the end (Read-Host)', /Read-Host/],
      ['version string v3.7.0', /v3\.7\.0/],
      ['documents ExecutionPolicy Bypass', /ExecutionPolicy Bypass/],
    ];
    for (const [name, re] of need) {
      check(`start-windows.ps1: ${name}`, re.test(ps), ps.slice(0, 200));
    }
    const braceOpens = (ps.match(/\{/g) || []).length;
    const braceCloses = (ps.match(/\}/g) || []).length;
    check('start-windows.ps1: balanced braces', braceOpens === braceCloses && braceOpens > 0, `{${braceOpens} vs }${braceCloses}`);
    const parenOpens = (ps.match(/\(/g) || []).length;
    const parenCloses = (ps.match(/\)/g) || []).length;
    check('start-windows.ps1: balanced parens', parenOpens === parenCloses, `(${parenOpens} vs )${parenCloses}`);
  }

  /* ==================== 3. bridge-doctor.bat ==================== */
  console.log('\n[3] bridge-doctor.bat — bytes (cannot run cmd.exe on Linux)');
  {
    const buf = fs.readFileSync(path.join(ROOT, 'bridge', 'bridge-doctor.bat'));
    checkBatchBytes(buf, 'bridge-doctor.bat');
    const text = buf.toString('utf8');
    for (const [name, re] of [
      ['writes bridge-doctor-report.txt', /bridge-doctor-report\.txt/],
      ['checks node', /where node/],
      ['checks port with netstat', /netstat/],
      ['checks /health', /\/health/],
      ['checks bridge-server.js', /bridge-server\.js/],
      ['version string v3.7.0', /v3\.7\.0/],
    ]) {
      check(`bridge-doctor.bat: ${name}`, re.test(text));
    }
  }

  /* ==================== 4. bridge-doctor.sh (RUNS FOR REAL) ==================== */
  console.log('\n[4] bridge-doctor.sh — runs for real on Linux');
  {
    const buf = fs.readFileSync(path.join(ROOT, 'bridge', 'bridge-doctor.sh'));
    check('bridge-doctor.sh: no CR bytes (LF only)', !buf.includes(0x0d));
    let nonAscii = 0;
    for (const b of buf) if (b >= 128) nonAscii += 1;
    check('bridge-doctor.sh: 100% ASCII', nonAscii === 0, `${nonAscii} non-ASCII bytes`);
    const text = buf.toString('utf8');
    for (const [name, re] of [
      ['writes bridge-doctor-report.txt', /bridge-doctor-report\.txt/],
      ['checks node version', /node -v/],
      ['checks /health with curl', /curl/ && /\/health/],
      ['respects BRIDGE_PORT env', /BRIDGE_PORT:-17321/],
      ['version string v3.7.0', /v3\.7\.0/],
    ]) {
      check(`bridge-doctor.sh: ${name}`, re.test(text));
    }

    // Run a copy in a temp dir: once against the LIVE bridge, once
    // against a dead port. The report must tell the two apart.
    const docDir = path.join(tmp, 'doctor');
    fs.mkdirSync(docDir, { recursive: true });
    fs.copyFileSync(BRIDGE_ENTRY, path.join(docDir, 'bridge-server.js'));
    fs.copyFileSync(path.join(ROOT, 'bridge', 'bridge-doctor.sh'), path.join(docDir, 'bridge-doctor.sh'));
    const runDoctor = (port) => new Promise((resolve) => {
      const p = spawn('/bin/sh', [path.join(docDir, 'bridge-doctor.sh')], {
        env: { ...process.env, BRIDGE_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString('utf8'); });
      p.stderr.on('data', (d) => { out += d.toString('utf8'); });
      const timer = setTimeout(() => { try { p.kill('SIGTERM'); } catch (_) {} resolve({ out, timedOut: true }); }, 15000);
      p.on('exit', () => { clearTimeout(timer); resolve({ out, timedOut: false }); });
    });

    const live = await runDoctor(BRIDGE_PORT);
    const liveReport = path.join(docDir, 'bridge-doctor-report.txt');
    check('doctor.sh (live bridge): exits', !live.timedOut, live.out.slice(-200));
    check('doctor.sh (live bridge): report file created', fs.existsSync(liveReport));
    if (fs.existsSync(liveReport)) {
      const rep = fs.readFileSync(liveReport, 'utf8');
      for (const [name, re] of [
        ['report: Node.js section + version', /1\. Node\.js:/ && /Node\.js: v\d+/],
        ['report: bridge-server.js found', /Tim thay bridge-server\.js/],
        ['report: port section says /health OK', /\/health tra loi OK/],
        ['report: write-permission OK', /Ghi file trong thu muc bridge: OK/],
        ['report: file list section', /6\. Danh sach file/],
      ]) {
        check(`doctor.sh (live bridge): ${name}`, re.test(rep), rep.slice(0, 300));
      }
    }

    const dead = await runDoctor(DEAD_PORT);
    check('doctor.sh (dead port): exits', !dead.timedOut, dead.out.slice(-200));
    if (fs.existsSync(liveReport)) {
      const rep = fs.readFileSync(liveReport, 'utf8');
      check('doctor.sh (dead port): report says /health does NOT answer',
        /\/health KHONG tra loi/.test(rep), rep.slice(0, 300));
      check('doctor.sh (dead port): report names the dead port',
        new RegExp(`Cong ${DEAD_PORT}`).test(rep), rep.slice(0, 200));
    }
  }

  /* ==================== 5. start-mac-linux.sh (RUNS FOR REAL) ==================== */
  console.log('\n[5] start-mac-linux.sh — runs a real bridge copy');
  {
    const shText = fs.readFileSync(path.join(ROOT, 'bridge', 'start-mac-linux.sh'), 'utf8');
    check('start-mac-linux.sh: version string v3.7.0', /v3\.7\.0/.test(shText));
    const copyDir = path.join(tmp, 'sh-copy');
    fs.mkdirSync(copyDir, { recursive: true });
    fs.copyFileSync(BRIDGE_ENTRY, path.join(copyDir, 'bridge-server.js'));
    fs.copyFileSync(path.join(ROOT, 'bridge', 'start-mac-linux.sh'), path.join(copyDir, 'start-mac-linux.sh'));
    const copyData = path.join(tmp, 'sh-copy-data');
    fs.mkdirSync(copyData, { recursive: true });
    shProc = spawn('/bin/sh', [path.join(copyDir, 'start-mac-linux.sh')], {
      env: { ...process.env, BRIDGE_PORT: String(SH_PORT), BRIDGE_DATA_DIR: copyData },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detached process group — killing the group stops the node
      // child too (killing only the sh parent used to orphan it).
      detached: true,
    });
    let shOut = '';
    shProc.stdout.on('data', (d) => { shOut += d.toString('utf8'); });
    shProc.stderr.on('data', (d) => { shOut += d.toString('utf8'); });
    const started = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 15000);
      const onData = () => { if (shOut.includes('Listening:')) { clearTimeout(timer); resolve(true); } };
      shProc.stdout.on('data', onData);
      shProc.stderr.on('data', onData);
      shProc.on('exit', () => { clearTimeout(timer); resolve(false); });
    });
    check('start-mac-linux.sh with node: bridge starts (Listening:)', started === true, shOut.slice(-300));
    if (started) {
      const h = await fetch(`http://127.0.0.1:${SH_PORT}/health`).then((r) => r.json()).catch(() => ({}));
      check('start-mac-linux.sh bridge: /health ok, v3.7.0',
        h.ok === true && h.version === '3.7.0', JSON.stringify(h).slice(0, 120));
    }
    try { process.kill(-shProc.pid, 'SIGTERM'); } catch (_) { try { shProc.kill('SIGTERM'); } catch (_) {} }
    await waitExit(shProc);
    shProc = null;
  }

  /* ==================== 6. README covers the .bat failure ==================== */
  console.log('\n[6] README — .bat failure troubleshooting');
  {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    for (const [name, re] of [
      ['mentions start-windows.bat', /start-windows\.bat/i],
      ['mentions start-windows.ps1', /start-windows\.ps1/i],
      ['mentions extracting the ZIP first', /giải nén/i],
      ['mentions installing Node.js', /Node\.js 18/i],
      ['mentions SmartScreen', /SmartScreen/i],
      ['mentions Unblock', /Unblock/i],
      ['mentions manual cmd run', /node bridge-server\.js/i],
      ['mentions bridge-doctor', /bridge-doctor/i],
      ['mentions bridge-start.log', /bridge-start\.log/i],
      ['has a dedicated .bat section', /Không mở được start-windows\.bat/i],
    ]) {
      check(`README: ${name}`, re.test(readme), readme.slice(0, 200));
    }
  }

  /* ==================== 7. guide + gitignore ==================== */
  console.log('\n[7] bridge-down guide names the new fallbacks');
  {
    const client = fs.readFileSync(path.join(ROOT, 'extension', 'bridge-client.js'), 'utf8');
    check('BRIDGE_START_GUIDE mentions start-windows.ps1', /start-windows\.ps1/.test(client));
    check('BRIDGE_START_GUIDE mentions bridge-doctor', /bridge-doctor/.test(client));
    check('BRIDGE_START_GUIDE still has the 3 numbered steps',
      /1\. Windows/.test(client) && /2\. Mac\/Linux/.test(client) && /3\. Đợi/.test(client));
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    check('.gitignore covers bridge-doctor-report.txt', /bridge-doctor-report\.txt/.test(gi));
    check('.gitignore still covers .github-oauth.json', /\.github-oauth\.json/.test(gi));
  }

  cleanup(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('bridge-v302 crashed:', err);
  process.exit(1);
});
