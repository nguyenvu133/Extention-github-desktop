# Bridge v2.0.0 — Chẩn đoán "Bridge disconnected" và kiến trúc viết lại

> Phiên bản: **2.0.0** · Ngày: 2026-11-23 · Repo: `nguyenvu133/Extention-github-desktop`
> (head trước khi viết lại: `1f8a2fc`, v1.0.2)

---

## 1. Vì sao v1 báo "Bridge disconnected"

Đã đọc toàn bộ code v1 trước khi viết lại. Kết luận: **không phải 1 lỗi, mà là 4 điểm yếu cộng dồn** — bất kỳ điểm nào cũng đủ làm UI kẹt ở DISCONNECTED mà không tự khỏi.

### 1.1. Không có auto-reconnect

- v1 chỉ gọi `GET /health` **một lần** khi popup/dashboard mở, hoặc khi người dùng bấm Refresh.
- Bridge mà **khởi động lại / crash / máy ngủ (sleep) rồi tỉnh** thì extension không hề thử lại — UI kẹt ở DISCONNECTED vĩnh viễn cho tới khi người dùng tự bấm nút.
- Không có backoff, không có hẹn giờ kiểm tra lại, không có trạng thái trung gian "đang thử kết nối lại".

### 1.2. Token là điểm lỗi duy nhất (single point of failure)

- Bridge tự sinh token ngẫu nhiên và lưu vào `bridge/.bridge-token`.
- Xoá thư mục bridge, cài lại bridge, hoặc đổi máy → token mới → token cũ lưu trong `chrome.storage` của extension **không còn khớp** → mọi `/api/*` trả **401**.
- v1 không có luồng **ghép nối lại (re-pair)**: không nút "đổi token", không hướng dẫn lấy token mới, không phân biệt được 401 (sai token) với "bridge chưa chạy" (không kết nối được).

### 1.3. Không có đăng nhập GitHub

- v1 là **Git local thuần**: chỉ chạy `git status / commit / pull / push` trên một thư mục trên máy.
- Không có PAT, không có OAuth, không có `GET /user`, không có danh sách repo GitHub — nên yêu cầu "hiện đầy đủ repo GitHub, trang giống github.com" **không thể làm được** trên kiến trúc v1.

### 1.4. Không có trạng thái trực tiếp (live status) và không có auto-update

- Không WebSocket, không SSE, không long-poll: extension không biết bridge chết cho tới khi tự gọi lại.
- Không có cơ chế làm mới repo định kỳ: muốn biết repo có commit mới phải tự bấm Refresh.

### Tóm tắt chẩn đoán

| Triệu chứng | Nguyên nhân gốc (v1) |
|---|---|
| "Bridge disconnected" kẹt cứng | Không auto-reconnect, không health poll |
| Bridge chạy lại vẫn disconnected | Token cũ không khớp, không có re-pair |
| Không thấy repo GitHub nào | v1 không có đăng nhập GitHub |
| Repo không tự cập nhật | Không có polling/SSE |

---

## 2. Kiến trúc v2.0.0 — Đăng nhập → API → Auto-update

```
┌────────────────────────────┐      HTTP 127.0.0.1:17321      ┌──────────────────────┐
│  Chrome Extension (MV3)    │  ◄──────────────────────────►  │  Bridge (Node thuần) │
│                            │   Bearer token (bridge)        │                      │
│  popup.js / dashboard.js   │   + SSE /api/events            │  bridge-server.js    │
│  • trạng thái 3 màu        │                                │  • /health           │
│  • login PAT / Device Flow │                                │  • /api/github/*     │
│  • danh sách repo          │                                │  • /api/git/* (v1)   │
│  • auto-update bar         │                                │  • SSE + poller      │
└────────────────────────────┘                                └──────┬───────────────┘
                                                                     │ HTTPS
                                                                     ▼
                                                            ┌──────────────────┐
                                                            │  api.github.com  │
                                                            │  (PAT / OAuth)   │
                                                            └──────────────────┘
```

### 2.1. Đăng nhập GitHub (2 cách)

**Cách 1 — Personal Access Token (PAT, khuyên dùng):**
1. Người dùng tạo token tại `github.com/settings/tokens` (classic) hoặc
   `github.com/settings/tokens?type=beta` (fine-grained), scope tối thiểu
   `repo` + `read:user` (classic) hoặc Repository access: All repositories,
   quyền Contents: Read and write (fine-grained).
2. Nhập token vào dashboard → `POST /api/github/auth { token }`.
3. Bridge kiểm tra ngay bằng `GET /user` (timeout 10 s, User-Agent
   `PixiJS-GitHub-Sync/2.0.0`). Token sai → 401, không lưu.
4. Token đúng → lưu vào **`bridge/.github-config.json`, mode 0600, đã gitignore**,
   và trả về cho extension **chỉ** profile công khai (`login`, `avatar_url`,
   `name`, `html_url`). **Token thô không bao giờ được trả lại.**

**Cách 2 — OAuth Device Flow (không cần gõ token):**
1. Cần `GITHUB_CLIENT_ID` (OAuth App, loại "GitHub App" không dùng được —
   phải là **OAuth App**). Chạy bridge với `GITHUB_CLIENT_ID=... node bridge-server.js`.
2. `POST /api/github/auth/device/start` → bridge gọi
   `POST https://github.com/login/device/code` → trả `user_code` + `verification_uri`.
3. Người dùng mở `github.com/login/device`, nhập code → bridge poll
   `POST /login/oauth/access_token` mỗi 5 s (tối đa ~15 phút, theo `interval` GitHub trả về).
4. Có token → kiểm tra `GET /user` rồi lưu như cách 1.
5. Không có `GITHUB_CLIENT_ID` → endpoint trả 400 kèm hướng dẫn tạo OAuth App.

**Đăng xuất:** `POST /api/github/logout` — xoá token khỏi file config và bộ nhớ,
báo SSE `github-auth` cho extension cập nhật giao diện.

### 2.2. GitHub API qua bridge (không gọi thẳng từ extension)

Extension **không bao giờ** cầm token GitHub. Mọi lệnh GitHub đi qua bridge,
bridge gắn `Authorization: Bearer <PAT>` khi gọi `api.github.com`:

| Endpoint bridge | GitHub API | Ghi chú |
|---|---|---|
| `GET /api/github/me` | `GET /user` | Profile công khai |
| `GET /api/github/repos?page&per_page&type&sort&direction` | `GET /user/repos` | Phân trang, Link header |
| `GET /api/github/repos/all` | `GET /user/repos` (nhiều trang) | Server-side, cache 60 s |
| `GET /api/github/repos/search?q=` | `GET /search/repositories` | Tìm kiếm |
| `GET /api/github/repos/:owner/:repo` | `GET /repos/:owner/:repo` | Chi tiết |
| `GET .../branches` | `GET /repos/:owner/:repo/branches` | |
| `GET .../commits?per_page` | `GET /repos/:owner/:repo/commits` | |
| `GET .../contents?path=&ref=` | `GET /repos/:owner/:repo/contents/:path` | Thư mục hoặc file (base64 → text) |
| `GET .../readme` | `GET /repos/:owner/:repo/readme` | Đã giải mã |
| `GET .../issues?state` | `GET /repos/:owner/:repo/issues` | Lọc PR ra (issue có `pull_request`) |
| `GET .../pulls?state` | `GET /repos/:owner/:repo/pulls` | |
| `PUT .../contents` | `PUT /repos/:owner/:repo/contents/:path` | Tạo/cập nhật file (base64) |
| `GET /api/github/rate-limit` | `GET /rate_limit` | Còn lại / reset lúc nào |
| `GET /health` | — | Thêm `github`, `rateLimit`, `autoUpdate`, `uptimeSeconds` |

- **Chuẩn hoá dữ liệu:** mọi repo/commit/branch/content/issue đều qua hàm
  `normalize*` — extension chỉ nhận field đã biết trước (tránh vỡ khi GitHub
  đổi thêm field).
- **Rate limit:** bridge đọc header `x-ratelimit-remaining/reset` sau mỗi lần
  gọi; còn ≤ 5 → phát SSE `rate-limit` để dashboard cảnh báo.
- **Lỗi GitHub:** `GhError` mang `status` (401 token sai, 403 rate limit,
  404 không có quyền/không tồn tại) — extension hiển thị đúng thông báo.

### 2.3. Auto-update repo

- **Bật/tắt + khoảng thời gian:** `GET/POST /api/github/auto-update`
  (`enabled`, `intervalSeconds`, kẹp 15–3600 s, mặc định 60 s).
- **Poller trên bridge:** mỗi chu kỳ, với mỗi repo đã biết, gọi
  `GET /repos/:owner/:repo/commits?per_page=1` kèm header
  **`If-None-Match: <ETag lần trước>`**:
  - GitHub trả **304** → không có commit mới, **không tốn quota**.
  - Có commit mới → SHA khác SHA đã lưu → ghi nhận cập nhật, xoá cache
    danh sách repo, phát SSE `repo-updated` (repo, sha cũ/mới, message).
- **Làm mới tay:** `POST /api/github/refresh` — chạy ngay một chu kỳ, trả về
  `{ checked, updatesFound, updates }`.
- **Trạng thái:** `lastRunAt` (lần kiểm tra cuối), `lastChangeAt` (lần phát hiện
  thay đổi cuối), `updatesFound` (tổng số lần phát hiện) — dashboard hiện
  "Lần kiểm tra cuối … · Cập nhật tiếp theo sau …s" + badge số repo có mới.

### 2.4. Kết nối bền (bridge ↔ extension)

- **`/health`** mở (không cần token) — extension dùng để phát hiện bridge.
- **SSE `GET /api/events?token=…`** — token qua query (EventSource không gắn
  được header), so sánh bằng `timingSafeEqual`. Sự kiện: `hello` (kèm version
  + trạng thái GitHub + auto-update), `auto-update`, `repo-updated`,
  `github-auth`, `rate-limit`, heartbeat `: ping` mỗi 25 s.
- **Máy trạng thái trong extension** (popup + dashboard giống nhau):
  `connected` (xanh) → `reconnecting` (vàng, backoff 1 s → 2 s → 5 s → 10 s
  → tối đa 30 s) → `disconnected` (đỏ). Health poll mỗi 10 s + SSE.
  Bridge tắt rồi mở lại → **tự kết nối lại, danh sách repo còn nguyên**
  (đã kiểm tra bằng test).
- **Khi bridge chưa chạy:** UI hiện rõ "Bridge chưa chạy" + hướng dẫn chạy
  script `start-mac-linux.sh` / `start-windows.bat` (hoặc `node bridge-server.js`),
  kèm nút **Kết nối lại**.

### 2.5. Bảo mật — thiết kế token

- **Token GitHub** chỉ nằm trong `bridge/.github-config.json` (0600, gitignore,
  **KHÔNG BAO GIỜ commit**). Bridge không log token, không trả token cho
  extension (kể cả sau khi lưu), extension chỉ giữ **trạng thái + profile**.
- **Token bridge** (Bearer cho `/api/*`) vẫn như v1: sinh ngẫu nhiên vào
  `bridge/.bridge-token` (0600, gitignore), `/health` và `/api/events`
  kiểm tra bằng `timingSafeEqual`. Token cũ sai → 401 → dashboard hướng dẫn
  copy token mới từ terminal bridge (luồng re-pair).
- **chrome.storage** chỉ lưu: URL bridge, token bridge, repo local đã chọn,
  tuỳ chọn auto-update — **không lưu token GitHub**.
- Git local vẫn chạy `git` bằng `spawn('git', …, { shell: false })` — không
  qua shell, không injection.

### 2.6. Tương thích ngược v1

Toàn bộ route Git local v1 (`/api/git/*`, `/health` cơ bản, state file,
token file) giữ nguyên — test v1 vẫn chạy được trên bridge v2.
Manifest kép (root + `extension/`) giữ nguyên: Load unpacked được từ cả 2 chỗ.

---

## 3. File đã sửa / tạo (v2.0.0)

| File | Thay đổi |
|---|---|
| `bridge/bridge-server.js` | Viết lại: 1.483 dòng (v1: 645). Thêm GitHub auth (PAT + Device Flow), toàn bộ API GitHub, auto-update poller + ETag, SSE `/api/events`, `/health` mở rộng, `GhError`, rate-limit tracking. Giữ nguyên toàn bộ route Git local v1. |
| `bridge/package.json` | Version 2.0.0; script `test:all` (chạy cả 4 test). |
| `bridge/start-mac-linux.sh`, `bridge/start-windows.bat` | Echo v2.0.0. |
| `extension/manifest.json` | Version 2.0.0. |
| `manifest.json` (root) | Version 2.0.0. |
| `extension/background.js` | 55 dòng: seed mặc định v2 (autoUpdate…), `OPEN_DASHBOARD` qua `dashboardUrl()`. |
| `extension/popup.html`, `popup.css`, `popup.js` | Viết lại: đèn trạng thái 3 màu + nút Reconnect, chip user GitHub (avatar/login/logout), repo local + Git nhanh, toggle auto-update, nhập token bridge. |
| `extension/dashboard.html`, `dashboard.css`, `dashboard.js` | Viết lại: dashboard.js 1.130 dòng — theme tối kiểu github.com; login PAT + Device Flow; danh sách TẤT CẢ repo (search/lọc/sắp xếp); chi tiết repo (Overview/README, Files, Commits, Branches, Issues, Pulls); thanh auto-update; tab Local Git giữ nguyên tính năng v1; máy trạng thái kết nối + SSE + backoff. |
| `tests/run-all.js` | **Mới**: chạy cả 4 suite trong một lệnh (tự khởi động bridge 17321 cho extension-test, rồi tắt). `npm --prefix bridge run test:all` → `run-all.js`. |
| `tests/bridge-v2-test.js` | **Mới** (36,5 KB): mock GitHub API local + bridge thật + dashboard trong vm. Xem §4. |
| `tests/extension-test.js` | Cập nhật v2: version 2.0.0, shim `classList`/`createTextNode`/`setInterval`, thêm ID mới, text trạng thái `BRIDGE CONNECTED`. |
| `tests/load-from-root-test.js` | Cập nhật v2: version 2.0.0, shim `classList`/`checked`/`src`/`alt`, `setInterval`, `process.exit(0)` (popup v2 chạy interval 10 s). |
| `tests/validate-manifest.js` | Không đổi (đã kiểm tra cả 2 manifest). |
| `README.md` | Viết lại đầy đủ từ A–Z (cài bridge → chạy → load extension → đăng nhập → từng tính năng → xử lý lỗi). |
| `docs/BRIDGE_V2.md` | File này. |
| `.gitignore` | Thêm `.github-config.json` (ghi chú "NEVER commit"). |

**Không đẩy lên GitHub** (theo yêu cầu nhiệm vụ — parent sẽ hỏi user trước).
**Không có token thật nào được commit.** Không gọi `api.github.com` thật trong test.

---

## 4. Kiểm thử — số liệu từng vòng

Chạy bằng `node`, in PASS/FAIL từng mục. Mock GitHub API chạy local
(`127.0.0.1:17401`), bridge thật chạy ở cổng test (`17399`), không gọi
GitHub thật. Harness: `tests/bridge-v2-test.js`.

### Vòng 1 — `node tests/bridge-v2-test.js` (lần chạy đầu)

- **Tìm được 1 bug thật trong bridge:** biến `res` (kết quả `ghRequest`)
  che mất `res` (HTTP response) trong các route GitHub → `send()` gọi
  `res.writeHead` trên nhầm object, mọi endpoint GitHub trả 400
  `{"error":"res.writeHead is not a function"}`. Đã sửa: đổi tên thành `gh`
  ở 10 route (rate-limit, repos, search, detail, branches, commits, issues,
  pulls, contents GET/PUT) + 1 chỗ `res.data` sót ở PUT contents (dòng 1189).
- 2 lỗi nhỏ trong test: token giả `ghp_bogus` quá ngắn nên bridge từ chối
  400 trước khi gọi GitHub (đổi sang token dài hơn để test đúng 401);
  `bridgeProc` null khi stdout flush muộn (thêm guard).
- Kết quả vòng 1 (sau sửa): **56 passed, 1 failed** — còn fail duy nhất
  "SSE: EventSource available in Node" vì Node trong VM không có global
  `EventSource`. Đã sửa test: viết client SSE tối giản bằng `http` để parse
  stream thật (không phụ thuộc global EventSource).

### Vòng 2 — chạy lại toàn bộ (sau sửa SSE)

| Test | Lệnh | Kết quả |
|---|---|---|
| bridge v2 (mock GitHub + bridge thật + dashboard vm) | `node tests/bridge-v2-test.js` | **58 passed, 0 failed** |
| extension v1 (Git local, bridge thật cổng 17321) | `node tests/extension-test.js` | **ALL CHECKS PASSED** (22 checks) |
| validate manifest (cả 2 chỗ) | `node tests/validate-manifest.js` | **18/18 passed** |
| load-from-root | `node tests/load-from-root-test.js` | **7/7 passed** |

### Vòng 3 — chạy lại toàn bộ lần 2 (kiểm thử liên tục)

| Test | Kết quả |
|---|---|
| `node tests/bridge-v2-test.js` | **58 passed, 0 failed** |
| `node tests/extension-test.js` | **ALL CHECKS PASSED** (22 checks) |
| `node tests/validate-manifest.js` | **18/18 passed** |
| `node tests/load-from-root-test.js` | **7/7 passed** |

### bridge-v2-test kiểm tra những gì (58 checks)

1. **Manifest:** `validate-manifest` + `load-from-root-test` exit 0.
2. **Health:** version 2.0.0, chưa đăng nhập GitHub, Device Flow có sẵn
   (client id test), auto-update tắt mặc định.
3. **Đăng nhập PAT:** token sai → 401; token đúng → user `octocat`;
   response **không chứa token thô**; file config trên đĩa giữ token, mode 0600.
4. **Repos:** phân trang (trang 1: 2 repo + `has_next`, trang 2: 1 repo),
   chuẩn hoá (`full_name`, `stargazers_count`, `visibility`),
   `repos/all` trả đủ 3 repo (gồm repo private), search `alpha` → 1 repo.
5. **Chi tiết repo:** branches `main` + `dev`, 3 commits, cây file
   (README.md + `src/`), đọc file (base64 → text), README đã giải mã,
   1 issue, 1 PR.
6. **Ghi file:** PUT contents tạo file, mock ghi nhận đúng nội dung base64.
7. **Rate limit:** 59/60 còn lại.
8. **ETag:** lần list thứ 2 vẫn trả dữ liệu; mock thấy header `If-None-Match`.
9. **Auto-update:** bật (15 s); refresh tay lúc đầu: 3 repo, 0 cập nhật;
   đổi SHA của `octocat/alpha` → refresh phát hiện **1 cập nhật**;
   status `updatesFound >= 1`, `lastChangeAt` được set.
10. **SSE:** nhận event `hello` (version 2.0.0); đổi SHA của `octocat/beta` →
    refresh → nhận event `repo-updated` cho đúng repo.
11. **Device Flow:** start trả `user_code`; poll #1, #2 pending; poll #3
    authorized thành `octocat`.
12. **Bảo mật:** token bridge sai → 401.
13. **Dashboard trong vm:** render đủ 3 repo, hiện CONNECTED + user octocat,
    count = 3, search lọc còn `beta`, hàng repo bấm được, mở chi tiết repo
    (README + 3 commits load được); **giết bridge → dashboard báo
    RECONNECTING/DISCONNECTED; khởi động lại bridge (cùng data dir) →
    TỰ KẾT NỐI LẠI thành CONNECTED, danh sách repo còn nguyên**.
14. **Đăng xuất:** logout thành công; `/me` → `authed=false`;
    `repos/all` → 401; file config không còn token.

### extension-test kiểm tra (22 checks, Git local v1 trên bridge v2)

Dashboard: CONNECTED, lamp ok, token/URL pre-filled, repo/branch/remote,
history có commit seed, branchSelect, tạo file mới → changes list có nút
Diff/Stage, diff hiện nội dung, stage được, commit thành công, summary
được xoá, history lên 2 commit. Lỗi: token sai hiện lỗi trong log.
Popup: CONNECTED, lamp ok, token accepted, version v2.0.0, tên repo.

### Lưu ý khi chạy test

- `tests/extension-test.js` cần bridge thật đang chạy ở cổng mặc định 17321
  (nó đọc `bridge/.bridge-token`). Cách dễ nhất: chạy
  `node tests/run-all.js` — script này tự khởi động bridge, chạy cả 4 suite
  theo thứ tự, rồi tắt bridge. Hoặc chạy tay: mở terminal, `cd bridge &&
  node bridge-server.js`, rồi chạy từng test ở terminal khác. `npm --prefix
  bridge run test:all` cũng chạy `run-all.js`.
- `tests/bridge-v2-test.js` tự chạy mock GitHub + bridge riêng, không cần
  chuẩn bị gì.
- **Không test nào gọi `api.github.com` thật.** Muốn test với GitHub thật:
  chạy bridge, đăng nhập bằng PAT thật trong dashboard, rồi kiểm tra thủ công
  theo README (mục "Kiểm tra bằng tay").

---

## 5. v2.1.0 — Mở rộng push/pull + đăng nhập bằng tài khoản GitHub thật

> Phiên bản: **2.1.0** · Ngày: 2026-11-23 · Head trước khi làm: `6db537d` (v2.0.0)
> Giữ nguyên toàn bộ tính năng v2.0.0, chỉ thêm mới.

### 5.1. OAuth Web Application Flow — "Kết nối GitHub" (cách chính)

- `GET /api/github/oauth/start` (cần bridge token): tạo `state` ngẫu nhiên
  (48 ký tự hex, dùng một lần, hết hạn 10 phút), trả `authorizeUrl`
  (`github.com/login/oauth/authorize?client_id=…&redirect_uri=http://127.0.0.1:17321/api/github/oauth/callback&scope=repo read:user&state=…`).
  Dashboard mở URL này bằng `chrome.tabs.create`, rồi poll
  `GET /api/github/user` mỗi 2 s (tối đa 5 phút) cho tới khi đăng nhập xong
  (SSE `github-auth` cũng báo).
- `GET /api/github/oauth/callback` (public — là redirect từ trình duyệt nên
  không mang bridge token; bù lại: server chỉ nghe 127.0.0.1 + kiểm tra
  `state` dùng một lần + hết hạn): đổi `code` lấy access token bằng
  Client ID + Client Secret, kiểm tra `GET /user`, lưu như PAT với
  `authMethod: 'oauth-web'`, phát SSE `github-auth`, trả trang HTML báo
  thành công ("Đã kết nối GitHub ✓", hiện login, không chứa token/secret).
  Sai state → 400; code sai → 400; state dùng lại → 400.
- `GET /api/github/oauth/status` (đã cấu hình OAuth App chưa, đã đăng nhập
  chưa, bằng cách nào), `POST /api/github/oauth/config` (lưu Client ID +
  Secret vào `bridge/.github-oauth.json` mode 0600, không bao giờ trả secret
  về), `GET /api/github/user` (profile + `authMethod` + `scopes`).
- Client ID/Secret lấy từ biến môi trường (`GITHUB_OAUTH_CLIENT_ID` /
  `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_CLIENT_ID` cũ vẫn dùng được làm
  alias) hoặc từ file config — env thắng file. Device Flow cũng dùng chung
  Client ID này.
- `ghConfig` thêm `authMethod` (`pat` | `device` | `oauth-web`) + `scopes`
  (đọc từ header `x-oauth-scopes` của `GET /user`); `/health` báo thêm
  `oauthWebAvailable` + `authMethod`.

### 5.2. Push/pull mở rộng (bridge, qua git CLI, `shell: false`)

| Nhóm | Route mới / mở rộng | Ghi chú |
|---|---|---|
| Pull | `POST /api/git/pull` `{mode: merge\|rebase\|ff-only, remote, branch}` | Merge truyền `--no-rebase` tường minh (git mới từ chối pull khi rẽ nhánh nếu không chỉ rõ); trả `changedFiles`, `commitsPulled`, `fastForward`; conflict trả HTTP 200 `{ok:false, conflict:true, conflicts}` |
| Push | `POST /api/git/push` `{remote, branch, setUpstream, force, confirm, pushAll, tags}` | Force chỉ là `--force-with-lease` và chỉ khi `confirm=true`, nếu không bridge trả 400 |
| Sync | `POST /api/git/sync` `{mode, remote, branch}` | fetch → pull → push, báo từng bước; cả 3 bước lỗi đều trả HTTP 200 kèm `steps` |
| Ahead/behind | `GET /api/git/ahead-behind` | `{branch, upstream, ahead, behind, hasUpstream}` qua `rev-list --left-right --count` |
| Branch | `POST /api/git/branch/create|rename|delete`, `GET /api/git/branches` (thêm `remoteBranches` + `current`) | Xoá được cả remote (`deleteRemote`), xoá branch hiện tại bị từ chối |
| Merge/conflict | `POST /api/git/merge`, `GET /api/git/conflicts`, `POST /api/git/conflict/resolve` `{path, side: ours\|theirs}`, `POST /api/git/merge/abort` | Resolve = `checkout --ours/--theirs` + `add`; commit merge được phép khi không còn gì staged (trường hợp ours == HEAD) |
| Stash | `POST /api/git/stash/create`, `GET /api/git/stash/list`, `POST /api/git/stash/apply` `{index, pop}`, `POST /api/git/stash/drop` | Stash rỗng → 400 "Nothing to stash" |
| Commit | `POST /api/git/commit` thêm `{amend, all}` | `--amend` đổi message không thêm commit; `all` = `add -A` trước |
| Log/diff | `GET /api/git/log?page&per_page`, `GET /api/git/diff/summary` | Log phân trang; diff summary trả insertions/deletions từng file (worktree + staged) |
| Remote | `GET /api/git/remotes`, `POST /api/git/remote/add|remove|set-url` | Đọc URL thô từ `git config` (không qua `git remote -v`, vì `-v` áp dụng `url.insteadOf` làm sai URL hiển thị) |
| Clone | `POST /api/git/clone` `{url, path, branch?}` | Đặt trước guard `repoPath` (chưa cần chọn repo); thư mục đích phải chưa tồn tại hoặc rỗng; xong tự chọn repo vừa clone |

Hàm dùng chung `pullRepo()` / `pushRepo()` (để auto-sync dùng đúng một
hành vi với route). `commitsPulled` đếm bằng `old HEAD .. FETCH_HEAD`
(chỉ commit từ remote), không đếm merge commit hay commit local bị rebase.

### 5.3. Auto-sync (tuỳ chọn)

- `POST /api/github/auto-update` nhận thêm `{autoSync}`; status thêm
  `autoSync` + `lastAutoSync`.
- Khi tick auto-update phát hiện repo GitHub trùng với `origin` của repo
  local (so bằng owner/repo trích từ remote URL) có commit mới:
  chỉ pull (merge) khi working tree đang sạch; tree bẩn → bỏ qua, ghi rõ
  lý do, không merge. Kết quả phát qua SSE event `auto-sync`.
- `remoteUrl()` đổi sang đọc `git config --get remote.origin.url` thay vì
  `git remote get-url` (cái sau áp dụng `url.insteadOf` nên auto-sync
  không nhận ra remote GitHub khi user dùng mirror local).

### 5.4. Bug thật bắt được khi test (3 lỗi)

1. **Pull merge trên branch rẽ nhánh bị git từ chối** — git mới yêu cầu
   chỉ rõ cách reconcile ("You have divergent branches…"). Sửa: merge mode
   truyền `--no-rebase` tường minh.
2. **`runGit` chỉ giữ stderr khi lỗi** — `git pull` in tóm tắt fetch ra
   stderr nhưng in `CONFLICT (content)…` ra stdout, nên bridge không nhận
   ra conflict mà trả lỗi chung chung. Sửa: gộp stdout + stderr vào
   `error.message` (giữ `gitStderr` riêng như cũ).
3. **Commit merge sau khi resolve "ours" bị chặn** — resolve ours có thể
   cho ra index giống hệt HEAD (không còn gì staged) nhưng commit merge
   vẫn cần được tạo. Sửa: route commit cho qua khi `MERGE_HEAD` tồn tại.

### 5.5. File đã sửa / tạo (v2.1.0)

- Sửa: `bridge/bridge-server.js` (1.483 → ~2.300 dòng), `extension/dashboard.js`
  (1.130 → 1.746 dòng), `extension/dashboard.html`, `extension/dashboard.css`,
  `extension/popup.js`, `extension/popup.html`, `extension/popup.css`,
  `bridge/package.json`, `tests/run-all.js`, `tests/bridge-v2-test.js`
  (2 check version 2.0.0 → 2.1.0), `README.md`, `docs/BRIDGE_V2.md`,
  `manifest.json` + `extension/manifest.json` (2.0.0 → 2.1.0),
  `.gitignore` (thêm `.github-oauth.json` vào danh sách cấm commit).
- Mới: `tests/bridge-v21-test.js` (107 checks).

### 5.6. Kiểm thử v2.1 — số liệu từng vòng

`tests/bridge-v21-test.js` (node, mock GitHub local, repo git thật:
bare remote + 2 clone, **không gọi api.github.com thật**):

- **Vòng smoke (script tạm `/tmp/v21-smoke.js`, 36 checks):** 29/36 →
  phát hiện bug pull `--no-rebase` (mục 5.4.1) → 33/36 → phát hiện bug
  `runGit` stdout/stderr + commit merge (mục 5.4.2/3) → **36/36**.
- **Vòng 1 (suite chính thức, 107 checks):** 100/107 → 3 lỗi do
  `remoteUrl()` đọc URL đã bị `insteadOf` viết lại (sửa: đọc raw config),
  1 lỗi do test đếm sai amend, 2 lỗi do `commitsPulled` đếm cả merge
  commit (sửa: đếm qua `FETCH_HEAD`), 1 lỗi do test so HEAD tuyệt đối
  thay vì kiểm tra ancestor sau merge → sửa xong.
- **Vòng 2 (chạy lại toàn bộ `run-all.js`):** **ALL SUITES PASSED** —
  validate-manifest 18/18, load-from-root 7/7, bridge-v2-test 58/58,
  bridge-v21-test **107/107**, extension-test 22/22.
- **Vòng 3 (chạy lại `run-all.js` lần 2):** **ALL SUITES PASSED** —
  kết quả giống hệt vòng 2.

Điểm kiểm thử quan trọng nhất đã pass: **auto-sync thật** — fake GitHub
báo SHA mới + clone B push commit thật lên bare remote → bridge tự pull
về repo local (file mới xuất hiện, commit của B thành ancestor của HEAD);
cây đang bẩn → auto-sync bỏ qua, không merge, file bẩn còn nguyên.
OAuth Web Flow: authorize URL đúng dạng + state ngẫu nhiên, callback sai
state/code bị từ chối, state dùng lại bị từ chối, token/secret không xuất
hiện trong bất kỳ response nào, file `.github-oauth.json` mode 0600.

### 5.7. Chưa kiểm chứng bằng tay

- OAuth Web Flow với tài khoản GitHub thật + OAuth App thật (cần desktop
  Chrome + tạo OAuth App theo README mục 3/6).
- Toàn bộ panel Push/Pull mới trên Chrome thật (pull rebase, force-with-lease,
  resolve conflict bằng tay).

---

## 6. v3.0.0 — Sửa đăng nhập + Download .zip + thêm tính năng

> Phiên bản: **3.0.0** · Ngày: 2026-11-23 · Head trước khi làm: `571ac3c` (v2.1.0)
> Giữ nguyên toàn bộ tính năng v2.1.0, chỉ thêm mới / sửa lỗi đăng nhập.

### 6.1. Chẩn đoán lỗi đăng nhập — "gõ email/mật khẩu vào không nhận"

**Báo cáo của user:** nút Connect GitHub không kết nối được tài khoản
`nguyenvu16592b@gmail.com` — gõ ID/mật khẩu vào không nhận.

**Nguyên nhân (đã xác minh bằng tài liệu công khai của GitHub):**
GitHub đã **bỏ xác thực bằng mật khẩu cho app bên thứ ba từ tháng 11/2020**
(basic authentication bằng mật khẩu bị tắt hoàn toàn) — không một app nào
được phép nhận mật khẩu GitHub trực tiếp nữa. Vì vậy:

- Ô **Personal Access Token** trong extension chỉ nhận **token** (bắt đầu
  bằng `ghp_…` hoặc `github_pat_…`). Gõ email/mật khẩu vào đó thì bridge
  thử gọi `GET /user` với chuỗi đó làm token → GitHub trả 401 → báo lỗi
  chung chung "token rejected". Đó chính là điều user gặp phải.
- Nút **Connect GitHub** (OAuth Web Flow) không có ô mật khẩu nào cả: nó
  mở **trang github.com** để user đăng nhập bằng tài khoản thật trên đó.
  Nhưng ở v2.1, nếu bridge **chưa cấu hình OAuth App** (chưa có Client ID
  + Client Secret) thì `/oauth/start` chỉ trả lỗi chung chung, user không
  biết phải làm gì — cũng trông giống như "bấm Connect GitHub không được".

**Cách đúng (3 cách, không cách nào hỏi mật khẩu GitHub trong extension):**

1. **Connect GitHub (OAuth Web Flow, khuyên dùng):** tạo OAuth App một lần
   (README mục 3) → nhập Client ID + Secret → bấm CONNECT GITHUB → đăng
   nhập bằng tài khoản thật **trên trang github.com** → Authorize.
2. **Device Flow (dễ nhất, chỉ cần Client ID):** bấm nút → hiện mã 6 ký tự
   → mở github.com/device → đăng nhập + nhập mã → Authorize. Tài khoản
   bật 2FA vẫn đăng nhập được trên github.com.
3. **Token PAT:** tạo token tại github.com → Settings → Developer settings
   → Personal access tokens (dạng `ghp_…` / `github_pat_…`, scope `repo` +
   `read:user`) → dán token vào ô PAT.

**Sửa trong v3.0 (bridge + extension):**

- Bridge: `POST /api/github/auth` phát hiện ngay input không phải token
  (chứa `@`/khoảng trắng, hoặc không bắt đầu bằng `ghp_/github_pat_/gho_/
  ghu_/ghs_/ghr_`) → trả `400 {error, code: 'INVALID_TOKEN_FORMAT'}`
  với thông báo tiếng Việt giải thích token bắt đầu bằng gì + link tạo
  token. Thêm helper `fail(code, message)` (Error mang `.code`) và catch
  cuối file trả cả `code` trong JSON. `GET /api/github/oauth/start` khi
  chưa cấu hình OAuth App → `400 {code: 'OAUTH_APP_NOT_CONFIGURED'}`
  kèm các bước sửa, thay cho lỗi chung.
- Bridge: `GET /api/github/login/diagnostics` (mới) — kiểm tra từng bước
  và trả checklist tiếng Việt: bridge đang chạy, OAuth App đã cấu hình
  chưa, token có/không + còn hiệu lực không (gọi `GET /user`, 401 →
  "Đăng nhập lại"), scope có `repo` không, rate limit còn lại, tới được
  github.com không (fetch `GITHUB_OAUTH_BASE/` timeout 5 s).
  Trả `{ok, authed, login, checks: [{key, label, ok, detail, fix}], summary}`.
- Extension: `#loginPanel` viết lại thành **wizard 3 cách tiếng Việt,
  không còn ô mật khẩu GitHub nào** (ô PAT vẫn `type=password` nhưng nhãn
  ghi rõ "Token — KHÔNG phải mật khẩu GitHub"). Gợi ý tài khoản
  (`nguyenvu16592b@gmail.com`) chỉ là **chữ gợi ý trong UI local** để user
  nhận ra tài khoản của mình — không gửi tới API nào, không lưu làm
  credential. PAT kiểm tra định dạng ngay ở client bằng hàm thuần
  `looksLikeGithubToken()` (dán email/mật khẩu → cảnh báo đỏ + không gửi
  request). Panel chẩn đoán `#diagList` + nút "Kiểm tra đăng nhập", tự
  chạy khi đăng nhập lỗi. Device Flow thêm đếm ngược. Chip tài khoản hiện
  thêm email (`publicUser()` thêm `email`).
- Sửa bug có sẵn phát hiện khi test: `noteRateLimit()` — header rate-limit
  vắng mặt trả `null`, mà `Number(null) === 0` nên mọi response không có
  header đều ghi nhầm "còn 0 request" → diagnostics check rate-limit fail.
  Sửa: guard null/'' → NaN, chỉ ghi khi header thật sự có.

### 6.2. Download .zip (mới)

- `GET /api/github/repos/:owner/:repo/zip?ref=<branch>` (cần GitHub auth,
  đặt trước khối repoMatch): fetch từ codeload
  (`https://codeload.github.com/:owner/:repo/zip/refs/heads/:ref`, ref
  mặc định = default_branch; SHA 40 hex dùng dạng `/zip/:ref`), kèm
  `Authorization: Bearer` nên **repo private cũng tải được**. Base qua env
  `GITHUB_CODELOAD_BASE` (mặc định codeload.github.com) để test dùng mock
  local. Stream body về client bằng `Readable.fromWeb`, header
  `Content-Type: application/zip` + `Content-Disposition: attachment;
  filename="<repo>-<ref>.zip"`. 404 → "Không tìm thấy repo hoặc branch",
  403 → thông báo rate limit.
- `POST /api/git/archive-zip` `{ref?}` (cần repo local): `git archive
  --format=zip <ref>` qua helper mới `runGitBuffer()` (thu Buffer, không
  qua string — ZIP là nhị phân, `runGit` trả string sẽ hỏng), trả ZIP tên
  `<tên-repo>-<ref>.zip`.
- Extension: helper `downloadBlob()` (fetch kèm Bearer token, lỗi đọc JSON
  rồi throw, blob → `<a download>` → thu hồi URL, disable nút lúc tải).
  Nút "⬇ .zip" ở **mỗi dòng repo** trong danh sách, nút "Tải .zip" ở đầu
  **trang chi tiết repo** (dùng branch đang chọn), nút "Tải .zip" ở
  **popup** (archive local, ref = branch hiện tại), nút "Xuất ZIP local"
  ở panel Push/Pull/Sync của tab Local Git.

### 6.3. API GitHub v3.0 (mới)

Khối repoMatch mở sang POST/DELETE/PATCH (đọc body cho PATCH/DELETE, CORS
thêm PATCH/DELETE). Thêm normalizer `normalizePull/normalizeComment/
normalizeRelease`.

| Nhóm | Route mới | Ghi chú |
|---|---|---|
| Repo | `POST /api/github/repos` `{name, description, private, auto_init}` | Tạo repo (tên regex `^[A-Za-z0-9._-]+$`) |
| Repo | `PATCH /api/github/repos/:owner/:repo` `{description?, private?}` | Sửa mô tả / đổi public-private |
| Repo | `DELETE /api/github/repos/:owner/:repo` `{confirm: true}` | Xoá repo, bắt buộc confirm |
| Repo | `POST /api/github/repos/:owner/:repo/fork` | Fork về tài khoản của bạn |
| Repo | `PUT/DELETE /api/github/repos/:owner/:repo/star` | Star / unstar |
| Issues | `POST .../issues` `{title, body, labels[]}`; `GET .../issues/:number` (kèm comments); `POST .../issues/:number/comments` `{body}`; `PATCH .../issues/:number` `{state}` | Tạo / xem chi tiết + bình luận / bình luận / đóng-mở |
| PRs | `POST .../pulls` `{title, head, base?, body}`; `PUT .../pulls/:number/merge` `{merge_method?}`; `PATCH .../pulls/:number` `{state}` | Tạo PR (base mặc định = default_branch), merge (merge/squash/rebase), đóng |
| Releases | `GET .../releases`; `POST .../releases` `{tag_name, name, body, draft, prerelease}`; `GET .../releases/assets/:assetId?name=` | Liệt kê / tạo / tải asset (stream binary, Accept: application/octet-stream) |
| File | `PUT .../contents` thêm `contentBase64` | Upload file (kể cả nhị phân) |
| File | `DELETE .../contents` `{path, message, sha, branch?}` | Xoá file (cần sha hiện tại) |
| Search | `GET /api/github/search/code?q=&repo=` | Tìm code trong repo (thêm `repo:owner/repo` vào query) |
| Notify | `GET /api/github/notifications`; `POST /api/github/notifications/read` | Liệt kê chưa đọc / đánh dấu đã đọc hết |
| Profile | `GET /api/github/profile` | Đầy đủ: login, name, email, bio, company, blog, location, repos/followers/following, created_at |

### 6.4. Git local thêm (v3.0)

| Route | Ghi chú |
|---|---|
| `POST /api/git/cherry-pick` `{sha}` | SHA hex 4–40; conflict → HTTP 200 `{ok:false, conflict:true, conflicts}` |
| `POST /api/git/revert` `{sha}` | `git revert --no-edit`; conflict → cùng dạng trên |
| `POST /api/git/reset` `{mode: soft\|mixed\|hard, ref, confirm?}` | Hard bắt buộc `confirm: true` (xoá thay đổi chưa commit); ref = SHA / HEAD / HEAD~n / tên branch |
| `GET /api/git/tags` | Liệt kê tag kèm sha từng tag (best-effort) |
| `POST /api/git/tag/create` `{name, message?, ref?}` | Annotated nếu có message, không thì lightweight |
| `POST /api/git/tag/delete` `{name}` | `git tag -d` |
| `POST /api/git/tag/push` `{name, remote?}` | Push tag lên remote (mặc định origin) |

### 6.5. Extension UI v3.0 (dashboard ~2.050 → ~2.684 dòng)

- Wizard đăng nhập (mục 6.1) + panel chẩn đoán + đếm ngược Device Flow +
  chip tài khoản hiện email.
- Download .zip (mục 6.2).
- Form tạo repo; Star/Unstar riêng, Fork, sửa mô tả (prompt), xoá repo
  (confirm 2 lần + `{confirm: true}`); tab **Releases** (liệt kê + tạo từ
  tag + tải asset); tab Files mở rộng (sửa file + Lưu với sha, tạo file
  mới, xoá file confirm, upload file → base64 → `contentBase64`); Issues
  (tạo issue, xem chi tiết + bình luận + Đóng/Mở lại); Pulls (tạo PR
  head/base, Merge với select merge/squash/rebase + Đóng); tìm code trong
  repo; chuông thông báo header (`#notifBtn` + badge chưa đọc + panel +
  "Đánh dấu đã đọc hết"); nav **Hồ sơ** (`#view-profile`); nav **Cài đặt**
  (`#view-settings`: khoảng auto-update, nhánh mặc định, auto-sync,
  bật/tắt thông báo — lưu `chrome.storage.local`, key mới
  `settingsDefaultBranch`, `settingsNotifications`, áp dụng khi boot);
  Local Git thêm panel Cherry-pick/Revert/Reset (hard reset cần checkbox
  xác nhận) và panel Tags.
- Popup: nút "Tải .zip" (archive local), chip tài khoản hiện email.

### 6.6. File đã sửa / tạo (v3.0.0)

- Sửa: `bridge/bridge-server.js` (2.312 → 2.934 dòng),
  `bridge/package.json` (3.0.0 + script `test:v3`),
  `extension/dashboard.js` (1.746 → 2.684 dòng),
  `extension/dashboard.html`, `extension/dashboard.css`,
  `extension/popup.js`, `extension/popup.html`, `extension/popup.css`,
  `manifest.json` + `extension/manifest.json` (2.1.0 → 3.0.0),
  `tests/run-all.js` (thêm suite v3), `tests/bridge-v2-test.js` (2 check
  version 2.1.0 → 3.0.0 — assertion cũ hardcode version), 
  `tests/bridge-v21-test.js` (1 check OAuth: `/not configured/i` →
  `code === 'OAUTH_APP_NOT_CONFIGURED'` — thông báo lỗi giờ là tiếng Việt
  theo đúng yêu cầu v3.0), `README.md`, `docs/BRIDGE_V2.md`.
- Mới: `tests/bridge-v3-test.js` (108 checks).

### 6.7. Kiểm thử v3.0 — số liệu từng vòng

`tests/bridge-v3-test.js` (node, mock GitHub local cổng 17403 — API +
OAuth device + codeload — + bridge thật cổng 17397, bridge thứ 2 cổng
17396 với `GITHUB_OAUTH_BASE` trỏ cổng chết để test unreachable; repo
git thật cho cherry-pick/revert/reset/tags; **không gọi api.github.com
thật**):

- **Vòng 1 (chạy riêng): 108/108 pass** — diagnostics đủ đường, OAuth
  start chưa cấu hình → code `OAUTH_APP_NOT_CONFIGURED`, PAT dạng
  email/mật khẩu/chuỗi ngẫu nhiên → `INVALID_TOKEN_FORMAT`, Device Flow
  mock đủ vòng, zip download mock (đúng bytes, đúng tên file, 404 rõ) +
  git archive thật (2 byte đầu `PK` + tên file trong ZIP), repo
  create/fork/star/delete mock, issues/PRs/releases mock, sửa file
  `contentBase64` + xóa file mock, code search, notifications,
  profile (có email), git cherry-pick/revert/reset/tags thật. Trong vòng
  này bắt được bug `noteRateLimit()` (mục 6.1, cuối) và đã sửa.
- **Vòng 2 (`node tests/run-all.js`, lần 1): ALL SUITES PASSED** —
  validate-manifest 18/18, load-from-root 7/7, bridge-v2-test 58/58,
  bridge-v21-test 107/107, bridge-v3-test 108/108, extension-test
  ALL CHECKS PASSED (76).
- **Vòng 3 (`node tests/run-all.js`, lần 2): ALL SUITES PASSED** —
  kết quả giống hệt vòng 2 (tổng 374 dòng PASS).
- **Vòng 4 (chạy lẻ từng suite, do parent tích hợp):** bridge-v2-test
  58/58, bridge-v21-test 107/107, bridge-v3-test 108/108,
  validate-manifest 18/18, load-from-root 7/7, extension-test
  ALL CHECKS PASSED.
- Lưu ý: lần đầu chạy `run-all` sau khi bump version, 3 check cũ fail
  vì assertion hardcode giá trị tiền-v3 (2 check version `'2.1.0'` trong
  bridge-v2-test, 1 check thông báo tiếng Anh trong bridge-v21-test) —
  đã cập nhật 3 dòng assertion đó (mục 6.6), không phải lỗi code mới.

`tests/extension-test.js` (node, dashboard.js/popup.js nguyên vẹn trong
vm + bridge thật): **76/76 check, 0 fail, chạy 3 vòng** (17 check cũ +
7 popup + 59 check mới: `looksLikeGithubToken` đúng/sai 7 trường hợp,
cảnh báo khi dán email làm PAT, diagnostics render mềm khi bridge 404,
36 hàm v3.0 tồn tại, chuyển view Profile/Settings, lưu settings vào
storage). `validate-manifest` + `load-from-root-test` cũng pass.

### 6.8. Chưa kiểm chứng bằng tay

- Đăng nhập bằng tài khoản GitHub thật trên github.com thật (chỉ mock
  local): OAuth Web Flow với OAuth App thật, Device Flow thật, PAT thật.
- Tải zip repo private thật; tải asset release thật.
- Toàn bộ UI v3.0 trên Chrome thật: wizard đăng nhập, đếm ngược Device
  Flow, tải file .zip (trình duyệt phải hiện hộp thoại lưu file), upload
  file, badge chuông thông báo, trang Hồ sơ / Cài đặt.
- Các route v3.0 mới chỉ mới kiểm tra tồn tại hàm + gọi đúng route ở phía
  extension (bridge v2.1 trả 404 thì UI xử lý mềm, không vỡ); end-to-end
  với bridge v3.0 đã được kiểm tra ở phía bridge (108/108) nhưng chưa
  click thật trên Chrome.

## 7. v3.0.1 — Sửa lỗi "Failed to fetch" khi đăng nhập

> Phiên bản: **3.0.1** · Ngày: 2026-11-23 · Head trước khi làm: `a6acec83` (v3.0.0)
> Giữ nguyên toàn bộ tính năng v3.0.0, chỉ sửa/thêm phần lỗi kết nối.

### 7.1. Chẩn đoán — "Failed to fetch" là gì, nguyên nhân nào đúng

**Báo cáo của user:** bấm đăng nhập báo `ERROR: Failed to fetch`.

`Failed to fetch` không phải lỗi GitHub, không phải lỗi token — đó là
`TypeError` của `fetch()`: trình duyệt **không nhận được bất kỳ phản hồi
nào** từ bridge. Kiểm chứng từng nguyên nhân trong code v3.0.0:

| # | Nguyên nhân nghi ngờ | Kết quả kiểm chứng |
|---|---|---|
| 1 | **Bridge chưa chạy** trên máy user | **ĐÚNG — nguyên nhân số 1.** Không một nút đăng nhập nào kiểm tra `/health` trước: `run()` (dashboard.js:2080) gọi `fetchJson` thẳng, `fetchJson` dùng `fetch()` trần nên bridge tắt → `TypeError: Failed to fetch` → hiện nguyên văn `err.message` cho user. Không có cơ chế vô hiệu hoá nút khi bridge tắt. |
| 2 | **CORS** | **ĐÚNG một phần — chỉ ngoài extension.** Trong extension thì OK (host_permissions bypass CORS), nhưng `corsOrigin()` chỉ cho `chrome-extension://` và `moz-extension://`: dashboard mở dưới dạng `file://` (Origin: null) hoặc `http://localhost` không nhận được header `Access-Control-Allow-Origin` → preflight fail → cũng ra "Failed to fetch". Không có phát hiện "mở ngoài extension" nào. |
| 3 | **URL bridge sai / port khác** | **LOẠI TRỪ phần lớn.** `bridgeUrl` lấy từ `chrome.storage`, mặc định đúng `http://127.0.0.1:17321`, không có chỗ nào hardcode sai. Chỉ còn rủi ro user đổi cổng mà quên sửa Bridge URL — đã thêm bước kiểm tra cổng vào panel chẩn đoán. |
| 4 | **Dashboard mở ngoài extension** | **ĐÚNG (cùng gốc với #2).** Mở `dashboard.html` trực tiếp từ repo/`file://`/`https` thì origin null/https, fetch về `http://127.0.0.1` bị chặn. v3.0.0 không cảnh báo gì. |
| 5 | **Start script yếu** | **ĐÚNG.** `.bat` ghi v2.0.0, không kiểm tra node; `.sh` không kiểm tra node, không pause/read — cửa sổ đóng ngay khi lỗi, user không kịp đọc. Không báo cổng đang dùng. |

### 7.2. Sửa trong v3.0.1

- **Mới `extension/bridge-client.js` (~12 KB, dùng chung popup +
  dashboard):** `translateBridgeError()` — mọi lỗi mạng (`TypeError` /
  "Failed to fetch" / timeout / `ECONNREFUSED`) đều dịch thành mã
  `BRIDGE_UNREACHABLE` (hoặc `BRIDGE_TIMEOUT`) + thông báo tiếng Việt
  "Bridge chưa chạy — chạy bridge trước rồi bấm lại", kèm hướng dẫn 3
  bước mở bridge (`BRIDGE_START_GUIDE`) — **không bao giờ hiện chữ
  "Failed to fetch" thô cho user nữa**. `bridgeFetch()` (timeout 15 s
  bằng `Promise.race`, cố ý không dùng AbortController — harness vm
  không có nó), `checkBridgeHealth()`, `checkConnectionSteps()` (5 bước),
  `isExtensionContext()` (có `chrome.runtime.id` không).
- **Bridge:** `corsOrigin()` cho thêm `http://localhost:<port>` /
  `http://127.0.0.1:<port>` và origin `null` (trả ACAO `'null'` + ghi
  log), log rõ khi origin lạ bị từ chối; route mới
  `GET /api/connection-test` (sau token gate, trả
  `{ok, version, time, bridgeUrl}`) để dashboard kiểm tra nhanh.
- **Dashboard:** `fetchJson`/`downloadBlob` dùng `bridgeFetch`;
  `health()` dùng `bridgeFetch` + gọi `setLoginEnabled()`; mới
  `setLoginEnabled()` (vô hiệu hoá 6 nút đăng nhập + hiện
  `#bridgeDownNotice` kèm hướng dẫn khi bridge tắt),
  `ensureBridgeUp()` (kiểm tra `/health` trước mọi nút đăng nhập:
  Connect GitHub, Device Flow, PAT), `runConnectionDiagnostics()` (panel
  "Chẩn đoán kết nối": bridge trả lời không → đúng cổng 17321 không →
  CORS preflight có qua không → `/health` có ok không →
  `/oauth/status` ra sao, kết quả từng bước bằng tiếng Việt). Boot phát
  hiện mở ngoài extension → hiện banner `#outsideExtensionNotice`;
  `refreshGithubState` coi `BRIDGE_UNREACHABLE` là trạng thái trống.
  `dashboard.html`: thêm `#outsideExtensionNotice`,
  `#bridgeDownNotice` (+ nút "Thử lại"), box chẩn đoán kết nối;
  `<script src="bridge-client.js">` trước `dashboard.js`.
- **Popup:** `fetchJson`/`downloadLocalZip` dùng `bridgeFetch`; mới
  `showError()` (thông báo ngắn đã dịch + dòng hướng dẫn); `refresh()`
  catch hiện hướng dẫn tiếng Việt; logout / auto-update toggle /
  download-zip / data-action đều dùng `showError()`. `popup.html` nạp
  `bridge-client.js` trước `popup.js`.
- **Start script:** `.bat` + `.sh` viết lại — kiểm tra node có sẵn
  không (báo rõ nếu chưa cài Node), `cd` đúng thư mục chứa script, báo
  cổng đang dùng nếu trùng, Windows `pause` / macOS-Linux `read` để
  cửa sổ không đóng ngay khi lỗi, in hướng dẫn mở extension sau khi
  bridge chạy. Cả hai đều ghi v3.0.1.
- **Version:** 3.0.1 ở cả 2 `manifest.json` + `bridge/package.json` +
  header bridge + header dashboard/popup.

### 7.3. File đã sửa / tạo (v3.0.1)

- Sửa: `bridge/bridge-server.js`, `extension/dashboard.js`,
  `extension/dashboard.html`, `extension/popup.js`,
  `extension/popup.html`, `bridge/start-windows.bat`,
  `bridge/start-mac-linux.sh`, `manifest.json`,
  `extension/manifest.json`, `bridge/package.json`,
  `tests/bridge-v2-test.js` (2 check version → 3.0.1 + nạp
  `bridge-client.js` trước `dashboard.js` trong vm — xem 7.4),
  `tests/bridge-v21-test.js`, `tests/bridge-v3-test.js` (check version →
  3.0.1), `tests/extension-test.js` (nạp `bridge-client.js` trước,
  thêm 17 check v3.0.1, `chrome.runtime.id` trong stub), `tests/run-all.js`
  (thêm suite v3.0.1 — 7 suite), `README.md`, `docs/BRIDGE_V2.md`.
- Mới: `extension/bridge-client.js`, `tests/bridge-v301-test.js`
  (64 checks).

### 7.4. Kiểm thử v3.0.1 — số liệu từng vòng

`tests/bridge-v301-test.js` (node, mock GitHub cổng 17404 + bridge thật
cổng 17395, cổng chết 17499, dashboard/popup nguyên vẹn trong vm,
**không gọi api.github.com thật**; test "bridge tắt" dùng cổng riêng +
kill bridge thật giữa chừng, không mock fetch nông):

- **Chạy lẻ lần 1: 60/61** — 1 fail: banner ngoài-extension trong vm
  (DOM shim của harness không có class HTML ban đầu; code thật đúng).
  Sửa: dashboard boot đặt trạng thái banner **rõ ràng cả hai chiều**
  bằng `classList.toggle('hidden', isExtensionContext())`.
- **Chạy lẻ lần 2: 62/63** — 1 fail: test start-script (bridge con của
  lần 1 bị mồ côi vì chỉ kill process `sh` cha, node con vẫn chiếm cổng
  17393). Sửa test: spawn script với process group riêng (`detached`)
  và kill cả group. Không phải lỗi code sản phẩm.
- **Chạy lẻ lần 3: 64/64 pass** — translate `Failed to fetch` →
  `BRIDGE_UNREACHABLE` + tiếng Việt (không chứa "Failed to fetch"),
  `bridgeFetch` cổng chết, CORS OPTIONS (chrome-extension/localhost/null
  cho phép, origin https lạ bị từ chối), `/api/connection-test`
  200/401, `checkConnectionSteps` live, kill + restart bridge, dashboard
  vm cổng chết (nút đăng nhập bị vô hiệu hoá + notice hiện + log tiếng
  Việt + click CONNECT GITHUB bị chặn với hướng dẫn), popup vm cổng
  chết, start script (node thiếu → exit 1 + thông báo rõ; node có →
  bridge thật chạy + `/health` v3.0.1), login diagnostics vẫn pass khi
  bridge chạy.
- **`node tests/run-all.js` vòng 1: FAILED lần đầu, rồi ALL SUITES
  PASSED sau khi sửa harness** — nguyên nhân fail: (a) bridge cũ còn
  sót chiếm cổng 17399 từ lần chạy trước bị giết giữa chừng (không phải
  lỗi code), (b) **bug thật trong harness**: `bridge-v2-test.js` nạp
  `dashboard.js` trong vm mà không nạp `bridge-client.js` trước →
  `ReferenceError: isExtensionContext is not defined` ở boot. Sửa
  harness (nạp `bridge-client.js` trước + stub `chrome.runtime.id`),
  chạy lại: **ALL SUITES PASSED** — validate-manifest 18/18,
  load-from-root 7/7, bridge-v2 58/58, bridge-v21 107/107, bridge-v3
  108/108, bridge-v301 64/64, extension-test 93/93 (76 cũ + 17 mới
  v3.0.1), không còn listener sót sau khi chạy.
- **`node tests/run-all.js` vòng 2: ALL SUITES PASSED** — số liệu giống
  hệt vòng 1.

### 7.5. User cần làm trên máy tính của mình

1. **Mở bridge TRƯỚC** rồi mới đăng nhập: Windows đúp
   `bridge/start-windows.bat`; macOS/Linux chạy
   `bridge/start-mac-linux.sh`. Đợi terminal hiện `Listening:
   http://127.0.0.1:17321` + đèn trong extension chuyển xanh.
2. Nếu bấm đăng nhập mà nút bị mờ + hiện khung "Bridge chưa chạy":
   làm theo 3 bước trong khung đó (mở bridge → đợi đèn xanh → bấm
   "Thử lại"), đừng bấm đăng nhập khi đèn còn đỏ.
3. Nếu vẫn lỗi: bấm **"Chẩn đoán kết nối"** trong dashboard, chụp màn
   hình 5 bước đó gửi lại — bước nào đỏ thì biết đúng chỗ hỏng.
4. Nhớ: đăng nhập GitHub vẫn cần làm **trên trang github.com** (OAuth /
   Device Flow) hoặc dán **token PAT** — không gõ mật khẩu GitHub vào
   extension (xem README mục 6).

### 7.6. Chưa kiểm chứng bằng tay

- Toàn bộ UI v3.0.1 trên Chrome thật: nút đăng nhập bị vô hiệu hoá khi
  bridge tắt, banner ngoài-extension, panel "Chẩn đoán kết nối", start
  script đúp chuột trên Windows thật.
- Đăng nhập bằng tài khoản GitHub thật trên github.com thật (chỉ mock
  local) — vẫn là bước user phải tự làm (mục 7.5).
