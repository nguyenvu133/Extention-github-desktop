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
