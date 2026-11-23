'use strict';

/*
 * PixiJS GitHub Desktop Sync — native-bridge v3.6.0
 *
 * One-click bridge start through Chrome Native Messaging.
 *
 * Chrome extensions cannot run a .bat / .sh file on their own — the
 * only way to start the local bridge from the extension is the Native
 * Messaging host (bridge/native-host.js, registered once on the user's
 * machine as "com.pixijs.github.bridge"). This module is the extension
 * side of that contract:
 *   - connectNative('com.pixijs.github.bridge')
 *   - send { action: 'start-bridge' } -> { ok, token, bridgeUrl }
 *   - send { action: 'setup-env' }    -> { ok, started }
 *   - send { action: 'get-token' }    -> { ok, token }
 *   - send { action: 'status' }       -> { ok, running, bridgeUrl }
 *
 * The host is a SEPARATE workstream — this file only speaks the
 * contract above and never waits for the host to be finished.
 *
 * SECURITY: the bridge token is never logged (not even partially) and
 * never appears in an error message. It is only written to
 * chrome.storage.local by the caller (popup.js / dashboard.js reuse
 * their existing token storage) and sent as a Bearer header to the
 * bridge, exactly like a manually pasted token.
 *
 * No dependency on chrome.* at load time — every chrome access is
 * guarded, so this file also loads in the Node test harness (where
 * chrome is undefined) and every call there fails with a clear error
 * instead of a ReferenceError.
 */

const NATIVE_HOST_NAME = 'com.pixijs.github.bridge';
const NATIVE_START_TIMEOUT_MS = 20000;
const NATIVE_STATUS_TIMEOUT_MS = 5000;
const NATIVE_HOST_NOT_INSTALLED_CODE = 'NATIVE_HOST_NOT_INSTALLED';
const NATIVE_HOST_TIMEOUT_CODE = 'NATIVE_HOST_TIMEOUT';
const NATIVE_HOST_ERROR_CODE = 'NATIVE_HOST_ERROR';
const NATIVE_HOST_UNAVAILABLE_CODE = 'NATIVE_HOST_UNAVAILABLE';

// One-time install guide (Vietnamese). Shown whenever the host is not
// registered — the manual flow (start the bridge by hand, paste the
// token) keeps working; this only adds the 1-click path.
function nativeHostInstallGuide() {
  let extensionId = '';
  try {
    extensionId = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || '';
  } catch (_) { /* non-extension context */ }
  return 'Chưa cài Native Host nên extension chưa tự mở được bridge. Cài 1 lần duy nhất:\n' +
    '1. Mở thư mục đã tải về, chạy bridge/register-native-host.bat (Windows) — chuột phải → Run as administrator nếu nó báo không ghi được.\n' +
    '2. Khi file .bat hỏi, dán Extension ID này' + (extensionId ? ' (' + extensionId + ')' : ' (mở chrome://extensions, bật Developer mode, copy ID của "PixiJS GitHub Desktop Sync")') + '.\n' +
    '3. Vào chrome://extensions → bấm Reload trên extension này, rồi bấm lại "KHỞI ĐỘNG BRIDGE".\n' +
    'Trong lúc chờ, vẫn dùng cách cũ: chạy bridge bằng tay (bridge/start-windows.bat hoặc ./bridge/start-mac-linux.sh) rồi dán token vào ô Bridge token.';
}

function nativeHostError(code, short, detail) {
  const err = new Error(short);
  err.code = code;
  err.short = short;
  err.detail = detail || '';
  return err;
}

function nativeHostNotInstalledError(cause) {
  const err = nativeHostError(
    NATIVE_HOST_NOT_INSTALLED_CODE,
    'Chưa cài Native Host — xem hướng dẫn cài 1 lần bên dưới.',
    nativeHostInstallGuide()
  );
  if (cause) err.cause = cause;
  return err;
}

// Send one message to the native host and wait for its single reply.
// Rejects with a translated error (never a raw chrome error):
//   - host not registered -> NATIVE_HOST_NOT_INSTALLED (+ install guide)
//   - no reply in time    -> NATIVE_HOST_TIMEOUT
//   - not in an extension -> NATIVE_HOST_UNAVAILABLE
function sendNativeMessage(message, timeoutMs) {
  const timeout = Number(timeoutMs) || NATIVE_START_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.connectNative !== 'function') {
      reject(nativeHostError(
        NATIVE_HOST_UNAVAILABLE_CODE,
        'Trang này không chạy trong extension nên không gọi được Native Host.',
        'Mở dashboard/popup từ extension (bấm icon extension), đừng mở file .html trực tiếp.'
      ));
      return;
    }
    let port = null;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (err) {
      reject(nativeHostNotInstalledError(err));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      finish(nativeHostError(
        NATIVE_HOST_TIMEOUT_CODE,
        'Native Host trả lời quá chậm (hết ' + Math.round(timeout / 1000) + 's chờ).',
        'Thử bấm lại. Nếu vẫn chậm, kiểm tra xem bridge có đang chạy sẵn không, hoặc khởi động lại máy rồi thử lại.'
      ));
    }, timeout);
    function finish(err, result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (port) port.disconnect(); } catch (_) { /* already gone */ }
      if (err) reject(err);
      else resolve(result);
    }
    port.onMessage.addListener((msg) => finish(null, msg));
    port.onDisconnect.addListener(() => {
      let lastErr = null;
      try { lastErr = chrome.runtime.lastError || null; } catch (_) { /* ignore */ }
      // If the host already answered, onDisconnect fires right after
      // and finish() is a no-op — the reply wins.
      finish(nativeHostNotInstalledError(lastErr));
    });
    try {
      port.postMessage(message);
    } catch (err) {
      finish(nativeHostNotInstalledError(err));
    }
  });
}

// Ask the host to start the bridge (or reuse the running one) and
// return { ok, token, bridgeUrl }. The token is returned as-is — the
// caller stores it with the existing chrome.storage.local mechanism
// and NEVER logs it (not even masked).
async function startBridgeViaNative(timeoutMs) {
  const res = await sendNativeMessage({ action: 'start-bridge' }, timeoutMs || NATIVE_START_TIMEOUT_MS);
  if (!res || res.ok !== true || !res.token) {
    const msg = (res && res.error) || 'Native Host không trả về token.';
    throw nativeHostError(NATIVE_HOST_ERROR_CODE, 'Không mở được bridge: ' + msg, '');
  }
  return {
    ok: true,
    token: String(res.token),
    bridgeUrl: String(res.bridgeUrl || 'http://127.0.0.1:17321'),
  };
}

// Ask the host whether the bridge is running. Best-effort helper;
// returns { ok, running, bridgeUrl } or throws the same translated
// errors as startBridgeViaNative.
async function nativeBridgeStatus(timeoutMs) {
  const res = await sendNativeMessage({ action: 'status' }, timeoutMs || NATIVE_STATUS_TIMEOUT_MS);
  if (!res || res.ok !== true) {
    throw nativeHostError(NATIVE_HOST_ERROR_CODE, 'Không kiểm tra được trạng thái bridge: ' + ((res && res.error) || 'Native Host không trả lời.'), '');
  }
  return { ok: true, running: !!res.running, bridgeUrl: String(res.bridgeUrl || '') };
}
