'use strict';

/*
 * PixiJS GitHub Desktop Sync — bridge-client v3.5.0
 *
 * Shared by popup.js and dashboard.js (loaded BEFORE them in
 * popup.html / dashboard.html). Every network call to the bridge goes
 * through bridgeFetch() here, so a dead bridge can never surface as a
 * raw "Failed to fetch" again.
 *
 * WHY THIS FILE EXISTS (v3.0.1 diagnosis — "ERROR: Failed to fetch"
 * when clicking sign-in):
 *   fetch() throws TypeError "Failed to fetch" whenever the browser
 *   gets NO response at all — the #1 cause is the bridge simply not
 *   running on the user's machine (connection refused). v3.0 logged
 *   err.message verbatim, so the user saw the browser's English
 *   network error instead of what to do. Now every network error is
 *   translated into a Vietnamese message with the exact fix
 *   (BRIDGE_UNREACHABLE + the 3-step start guide), and login buttons
 *   check /health BEFORE calling any sign-in route.
 *
 *   CORS is NOT the cause when the dashboard runs inside the
 *   extension (host_permissions bypass CORS), but it IS a cause when
 *   dashboard.html is opened directly as a file:// page or from a
 *   local web server — the bridge only allowed chrome-extension://
 *   origins before v3.0.1. checkConnectionSteps() below tells the two
 *   cases apart: /health (a simple GET, no preflight) works, but an
 *   authenticated request (preflighted) fails => CORS / wrong context.
 *
 * No dependency on chrome.* — this file also runs in the Node test
 * harness (vm), where `fetch` is the global Node fetch.
 */

const BRIDGE_UNREACHABLE_CODE = 'BRIDGE_UNREACHABLE';
const BRIDGE_TIMEOUT_CODE = 'BRIDGE_TIMEOUT';
const BRIDGE_DEFAULT_TIMEOUT_MS = 15000;

// Short one-liner for log lines / the popup's single-line message.
const BRIDGE_START_SHORT =
  'Bridge chưa chạy — chạy bridge trước rồi bấm lại (Windows: đúp bridge/start-windows.bat; Mac/Linux: ./bridge/start-mac-linux.sh).';

// Full 3-step guide for the dashboard notice + diagnostics fixes.
// v3.0.2: step 1 also names the fallbacks when double-clicking the
// .bat does nothing (extract the ZIP first, Unblock the file, or run
// the .ps1 instead) and points at the doctor script.
const BRIDGE_START_GUIDE =
  'Bridge chưa chạy — chạy bridge trước rồi bấm lại:\n' +
  '1. Windows: đúp chuột vào bridge/start-windows.bat (trong thư mục đã tải về). Nếu đúp chuột không mở được: giải nén ZIP ra trước, chuột phải file → Properties → tích Unblock (nếu có), hoặc chạy bridge/start-windows.ps1 (chuột phải → Run with PowerShell).\n' +
  '2. Mac/Linux: mở Terminal, vào thư mục bridge rồi chạy ./start-mac-linux.sh.\n' +
  '3. Đợi cửa sổ bridge hiện "Listening: http://127.0.0.1:17321" rồi bấm "Thử lại" ở đây.\n' +
  'Nếu vẫn không mở được, chạy bridge/bridge-doctor.bat (Windows) hoặc bridge/bridge-doctor.sh (Mac/Linux) rồi gửi file bridge-doctor-report.txt lại.';

function isNetworkError(err) {
  if (!err) return false;
  if (err.code === BRIDGE_UNREACHABLE_CODE || err.code === BRIDGE_TIMEOUT_CODE) return true;
  if (err.name === 'TypeError' && /fetch/i.test(String(err.message || ''))) return true;
  return /failed to fetch|networkerror|network request failed|load failed|econnrefused|enotfound|ehostunreach|econnreset|econnaborted|socket hang up|network connection lost/i
    .test(String(err.message || '') + ' ' + String(err.code || ''));
}

// Translate ANY error from a bridge call into {code, short, detail,
// message}. Network errors become BRIDGE_UNREACHABLE with Vietnamese
// guidance; anything else passes through unchanged (but never the raw
// "Failed to fetch" string — that text never reaches the user).
function translateBridgeError(err, bridgeUrl) {
  const url = bridgeUrl ? String(bridgeUrl) : '';
  if (err && (err.code === BRIDGE_TIMEOUT_CODE || /timed? ?out/i.test(String(err.message || '')))) {
    return {
      code: BRIDGE_TIMEOUT_CODE,
      short: 'Bridge trả lời quá chậm (hết thời gian chờ).',
      detail: 'Thử bấm lại sau vài giây. Nếu vẫn chậm, kiểm tra máy có đang quá tải không, hoặc khởi động lại bridge.',
      message: 'Bridge trả lời quá chậm (hết thời gian chờ). Thử bấm lại sau vài giây.',
    };
  }
  if (isNetworkError(err)) {
    return {
      code: BRIDGE_UNREACHABLE_CODE,
      short: BRIDGE_START_SHORT,
      detail: BRIDGE_START_GUIDE,
      message: BRIDGE_START_SHORT + '\n' + BRIDGE_START_GUIDE,
    };
  }
  const message = String((err && err.message) || err || 'Unknown error');
  return { code: (err && err.code) || 'BRIDGE_ERROR', short: message, detail: url ? 'Bridge: ' + url : '', message };
}

// Build the translated Error object (carries .code / .short / .detail
// so callers can render a short line + a detailed guide separately).
function bridgeError(err, bridgeUrl) {
  const t = translateBridgeError(err, bridgeUrl);
  const e = new Error(t.message);
  e.code = t.code;
  e.short = t.short;
  e.detail = t.detail;
  e.bridgeUrl = bridgeUrl ? String(bridgeUrl) : '';
  return e;
}

// fetch() with a timeout. The timeout is implemented with Promise.race
// (no AbortController — the Node vm test harness does not provide one).
// Network failures throw the translated BRIDGE_UNREACHABLE error.
async function bridgeFetch(url, options, timeoutMs) {
  const timeout = Number(timeoutMs) || BRIDGE_DEFAULT_TIMEOUT_MS;
  let timer = null;
  const timeoutError = new Error('Bridge request timed out');
  timeoutError.code = BRIDGE_TIMEOUT_CODE;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeout);
  });
  try {
    return await Promise.race([fetch(url, options), timeoutPromise]);
  } catch (err) {
    throw bridgeError(err, url);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// GET /health (public, no token) — the "is the bridge up at all?"
// check every login button runs first. Throws the translated error.
async function checkBridgeHealth(bridgeUrl) {
  const base = String(bridgeUrl || '').trim().replace(/\/+$/, '');
  const res = await bridgeFetch(base + '/health', undefined, 8000);
  if (!res.ok) throw new Error('Bridge trả về HTTP ' + res.status + ' ở /health.');
  return res.json();
}

// True only when this page runs inside the Chrome extension. When the
// dashboard is opened directly (file://, or a plain https page) the
// browser enforces CORS against the bridge and sign-in cannot work.
function isExtensionContext() {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  } catch (_) {
    return false;
  }
}

// v3.0.1 — step-by-step connection check for the dashboard panel.
// Each step: {key, label, ok, detail, fix}. Stops early when the
// bridge does not answer at all (nothing else can be checked then).
// `token` may be '' — the CORS + OAuth steps then report "not
// checkable yet" instead of failing.
async function checkConnectionSteps(bridgeUrl, token) {
  const base = String(bridgeUrl || '').trim().replace(/\/+$/, '');
  const steps = [];

  // Step 1 — does the bridge answer at all? (simple GET, no auth, no
  // preflight, so CORS cannot break this step.)
  let healthData = null;
  try {
    const res = await bridgeFetch(base + '/health', undefined, 8000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    healthData = await res.json();
    steps.push({
      key: 'bridge',
      label: 'Bridge có trả lời không',
      ok: true,
      detail: 'Bridge trả về /health (phiên bản ' + (healthData.version || '?') + ').',
      fix: null,
    });
  } catch (err) {
    const t = translateBridgeError(err, base);
    steps.push({
      key: 'bridge',
      label: 'Bridge có trả lời không',
      ok: false,
      detail: t.short,
      fix: t.detail,
    });
    return steps;
  }

  // Step 2 — is the configured URL even a loopback bridge URL?
  let urlOk = true;
  let urlDetail = 'Đang dùng ' + base + '.';
  let urlFix = null;
  try {
    const u = new URL(base);
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
      urlOk = false;
      urlDetail = 'Bridge URL đang trỏ tới ' + u.hostname + ' — bridge chỉ nghe trên chính máy này (127.0.0.1).';
      urlFix = 'Sửa Bridge URL thành http://127.0.0.1:17321.';
    } else if (u.port && u.port !== '17321') {
      urlDetail = 'Đang dùng cổng ' + u.port + ' — đảm bảo bridge cũng chạy ở cổng này (biến BRIDGE_PORT khi chạy bridge).';
    }
  } catch (_) {
    urlOk = false;
    urlDetail = 'Bridge URL không đúng định dạng: ' + base;
    urlFix = 'Sửa Bridge URL thành http://127.0.0.1:17321.';
  }
  steps.push({ key: 'port', label: 'Đúng cổng 17321 không', ok: urlOk, detail: urlDetail, fix: urlFix });

  // Step 3 — CORS preflight: an authenticated request triggers a
  // preflight. /health worked but this fails with a network error =>
  // the browser blocked it (dashboard opened outside the extension).
  if (!token) {
    steps.push({
      key: 'cors',
      label: 'CORS preflight có qua không',
      ok: false,
      detail: 'Chưa có bridge token nên chưa kiểm tra được bước này.',
      fix: 'Dán token bridge (bridge in ra khi chạy) vào ô Bridge token rồi bấm lại.',
    });
  } else {
    try {
      const res = await bridgeFetch(base + '/api/connection-test', {
        headers: { Authorization: 'Bearer ' + token },
      }, 8000);
      if (res.status === 404) {
        steps.push({
          key: 'cors',
          label: 'CORS preflight có qua không',
          ok: false,
          detail: 'Bridge này là bản cũ (chưa có /api/connection-test).',
          fix: 'Cập nhật bridge lên v3.0.1 trở lên (tải code mới nhất rồi chạy lại bridge).',
        });
      } else {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        steps.push({
          key: 'cors',
          label: 'CORS preflight có qua không',
          ok: true,
          detail: 'Yêu cầu có token đã qua (bridge v' + (data.version || '?') + ').',
          fix: null,
        });
      }
    } catch (err) {
      const t = translateBridgeError(err, base);
      if (t.code === BRIDGE_UNREACHABLE_CODE) {
        steps.push({
          key: 'cors',
          label: 'CORS preflight có qua không',
          ok: false,
          detail: 'Bridge trả /health nhưng chặn yêu cầu có token — thường do trang này đang mở ngoài extension (file://) nên trình duyệt chặn CORS.',
          fix: 'Mở dashboard từ extension (popup → OPEN FULL WORKSPACE), đừng mở file dashboard.html trực tiếp. Nếu đã mở từ extension mà vẫn lỗi, cập nhật bridge lên v3.0.1.',
        });
      } else {
        steps.push({ key: 'cors', label: 'CORS preflight có qua không', ok: false, detail: t.short, fix: null });
      }
    }
  }

  // Step 4 — /health content (already known to answer).
  steps.push({
    key: 'health',
    label: '/health có ok không',
    ok: true,
    detail: 'Bridge v' + (healthData.version || '?') + ' đang chạy.',
    fix: null,
  });

  // Step 5 — OAuth status (needs the token).
  if (!token) {
    steps.push({
      key: 'oauth',
      label: '/oauth/status ra sao',
      ok: false,
      detail: 'Chưa có bridge token nên chưa kiểm tra được.',
      fix: 'Dán token bridge vào ô Bridge token rồi bấm lại.',
    });
  } else {
    try {
      const res = await bridgeFetch(base + '/api/github/oauth/status', {
        headers: { Authorization: 'Bearer ' + token },
      }, 8000);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
      steps.push({
        key: 'oauth',
        label: '/oauth/status ra sao',
        ok: true,
        detail: data.configured
          ? 'OAuth App đã cấu hình ✓ — bấm CONNECT GITHUB để đăng nhập.'
          : 'OAuth App chưa cấu hình — đăng nhập bằng Device Flow hoặc PAT, hoặc cấu hình OAuth App trước.',
        fix: null,
      });
    } catch (err) {
      const t = translateBridgeError(err, base);
      steps.push({ key: 'oauth', label: '/oauth/status ra sao', ok: false, detail: t.short, fix: null });
    }
  }

  return steps;
}
