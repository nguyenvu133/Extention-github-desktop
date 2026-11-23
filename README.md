# PixiJS GitHub Desktop Sync — v2.1.0

> **Đồng bộ GitHub ngay trong Chrome**: đăng nhập bằng **tài khoản GitHub thật**
> (bấm "Kết nối GitHub", đăng nhập trên github.com), xem **tất cả repo** của
> bạn trên một trang giống github.com, tự động phát hiện repo có commit mới
> (có thể tự pull về), và dùng đầy đủ Git local — **pull/push mở rộng**
> (merge/rebase/ff-only, force-with-lease, sync 1 nút, branch, merge +
> xử lý conflict, stash, remote, clone) cho thư mục trên máy — tất cả qua
> một **bridge chạy trên máy bạn**, không qua server trung gian nào.

```
Chrome Extension (popup + dashboard)  ⇄  Bridge (Node.js, 127.0.0.1:17321)  ⇄  api.github.com
```

---

## Mục lục

1. [Cần gì trước khi bắt đầu](#1-cần-gì-trước-khi-bắt-đầu)
2. [Cài đặt bridge (3 bước)](#2-cài-đặt-bridge-3-bước)
3. [Chạy bridge](#3-chạy-bridge)
4. [Cài extension vào Chrome (Load unpacked)](#4-cài-extension-vào-chrome-load-unpacked)
5. [Kết nối extension với bridge](#5-kết-nối-extension-với-bridge)
6. [Đăng nhập GitHub](#6-đăng-nhập-github)
7. [Dùng dashboard giống github.com](#7-dùng-dashboard-giống-githubcom)
8. [Auto-update repo (tự động làm mới)](#8-auto-update-repo-tự-động-làm-mới)
9. [Git local (tab Local Git)](#9-git-local-tab-local-git)
10. [Popup nhanh](#10-popup-nhanh)
11. [Cấu trúc thư mục](#11-cấu-trúc-thư-mục)
12. [Bảo mật — token lưu ở đâu](#12-bảo-mật--token-lưu-ở-đâu)
13. [Xử lý lỗi thường gặp](#13-xử-lý-lỗi-thường-gặp)
14. [Kiểm thử](#14-kiểm-thử)
15. [Ghi chú cho người dùng điện thoại](#15-ghi-chú-cho-người-dùng-điện-thoại)
16. [Lịch sử phiên bản](#16-lịch-sử-phiên-bản)

---

## 1. Cần gì trước khi bắt đầu

| Thứ | Yêu cầu |
|---|---|
| Máy tính | **Windows, macOS hoặc Linux** (xem mục 15 nếu bạn chỉ có điện thoại) |
| Trình duyệt | **Google Chrome** (hoặc Chromium/Edge/Brave — bản desktop) |
| Node.js | **≥ 18** — kiểm tra bằng `node --version`. Chưa có thì tải tại <https://nodejs.org> (bản LTS) |
| Git | Đã cài sẵn (`git --version`). Cần cho tính năng Git local |
| Tài khoản GitHub | Để đăng nhập và xem repo (mục 6) |

**Không cần cài thêm thư viện nào.** Bridge chỉ dùng module có sẵn của Node
(`http`, `fs`, `crypto`, `child_process`, `fetch` tích hợp) — không có
`node_modules`, không cần `npm install`.

---

## 2. Cài đặt bridge (3 bước)

```bash
# 1. Tải repo về máy (hoặc git clone nếu bạn đã quen)
git clone https://github.com/nguyenvu133/Extention-github-desktop.git
cd Extention-github-desktop

# 2. Vào thư mục bridge
cd bridge

# 3. (Không cần npm install — bridge không có dependency.)
# Kiểm tra Node:
node --version   # phải ra v18 trở lên
```

> Lần đầu chạy, bridge tự tạo 2 file trong `bridge/`:
> - `.bridge-token` — token để extension kết nối tới bridge (tự sinh, mode 0600).
> - `.bridge-state.json` — nhớ repo local bạn đã chọn.
> Cả 2 file đều đã có trong `.gitignore`, **không bao giờ bị commit lên GitHub**.

---

## 3. Chạy bridge

### Windows

Nháy đúp `bridge\start-windows.bat`, hoặc trong terminal:

```cmd
cd bridge
node bridge-server.js
```

### macOS / Linux

```bash
cd bridge
./start-mac-linux.sh
# hoặc: node bridge-server.js
```

Khi chạy đúng, terminal sẽ hiện tương tự:

```
PixiJS GitHub Bridge v2.1.0
Listening: http://127.0.0.1:17321
Token file: bridge/.bridge-token
TOKEN:      ab12cd34ef56... (token của bạn)

GitHub:     not signed in — sign in from the extension (Connect GitHub, PAT or Device Flow).
OAuth App:  not configured — Device Flow and Connect GitHub need a client id (see README section 6).
Auto-update: OFF

Paste the TOKEN into the extension dashboard, then click "Connect Bridge".
Keep this terminal open. Press Ctrl+C to stop.
```

**Giữ cửa sổ terminal này mở** trong suốt thời gian dùng extension. Tắt terminal
= tắt bridge = extension báo Disconnected (nhưng sẽ tự kết nối lại khi bạn
mở bridge lên — xem mục 13).

### Đổi cổng (không bắt buộc)

Mặc định bridge chạy cổng **17321**. Muốn đổi cổng:

```bash
BRIDGE_PORT=18080 node bridge-server.js        # macOS/Linux
set BRIDGE_PORT=18080 && node bridge-server.js  # Windows cmd
```

Nhớ sửa **Bridge URL** trong extension cho khớp (mục 5).

### Bật OAuth App — cho "Kết nối GitHub" và Device Flow (không bắt buộc nếu chỉ dùng PAT)

Muốn đăng nhập bằng tài khoản GitHub thật (bấm "Kết nối GitHub", đăng nhập
trên github.com — mục 6, cách 1) hoặc kiểu "nhập mã 6 ký tự" (Device Flow,
cách 3), bạn cần tạo một **OAuth App** trên GitHub trước:

1. Mở <https://github.com/settings/developers> → **OAuth Apps** →
   **New OAuth App**.
2. Application name: `PixiJS GitHub Sync` (tên gì cũng được).
   Homepage URL: `http://127.0.0.1:17321`.
   **Authorization callback URL: `http://127.0.0.1:17321/api/github/oauth/callback`**
   (bắt buộc cho "Kết nối GitHub"; Device Flow không dùng callback nhưng
   cứ điền để dùng chung một App cho cả hai).
3. Tạo xong, copy **Client ID** (dạng `Ov23li...`) và **Client Secret**
   (bấm **Generate a new client secret** — chỉ hiện một lần).

Rồi nhập 2 giá trị này vào bridge bằng **1 trong 2 cách**:

- **Cách dễ nhất — nhập trong dashboard:** mở dashboard → mục đăng nhập →
  form **OAuth App** → dán Client ID + Client Secret → **Save**. Bridge
  lưu vào file `bridge/.github-oauth.json` (mode 0600, đã gitignore) và
  **không bao giờ trả lại cho extension**.
- **Hoặc chạy bridge kèm biến môi trường:**

```bash
GITHUB_OAUTH_CLIENT_ID=Ov23liXXXXXXXXXXXXXXXX GITHUB_OAUTH_CLIENT_SECRET=YYYYYYYYYYYYYYYYYYYY node bridge-server.js
```

Không có Client ID/Secret thì nút "Kết nối GitHub" và Device Flow trong
dashboard sẽ báo lỗi và hướng dẫn tạo OAuth App — đăng nhập bằng PAT và
các tính năng khác vẫn chạy bình thường.

---

## 4. Cài extension vào Chrome (Load unpacked)

> ⚠️ **Load unpacked chỉ có trên Chrome máy tính.** Xem mục 15 nếu bạn dùng
> điện thoại là chính.

1. Mở Chrome, gõ vào thanh địa chỉ: **`chrome://extensions`**
2. Bật công tắc **Developer mode** (góc trên bên phải).
3. Bấm **Load unpacked**.
4. Chọn **thư mục gốc của repo** (`Extention-github-desktop`) **hoặc** thư mục
   `Extention-github-desktop/extension` — **cả 2 chỗ đều được** (từ v1.0.2,
   repo có `manifest.json` ở cả root lẫn `extension/`).
   - Chọn **đúng thư mục chứa file `manifest.json`** — nếu chọn nhầm thư mục
     cha (ví dụ `Extention-github-desktop-main/` khi giải nén zip), Chrome sẽ
     báo *"Manifest file is missing or unreadable"*.
5. Extension **"PixiJS GitHub Desktop Sync"** xuất hiện trong danh sách.
   Bấm **Details** → bật **Allow access to file URLs** nếu bạn muốn mở
   dashboard từ file local (không bắt buộc).
6. Ghim extension lên thanh công cụ: bấm biểu tượng mảnh ghép → ghim
   **PixiJS GitHub Desktop Sync**.

**Cập nhật extension sau khi pull code mới:** vào `chrome://extensions` →
bấm nút **Reload** (mũi tên xoay) trên thẻ extension. Không cần gỡ rồi cài lại.

---

## 5. Kết nối extension với bridge

1. **Chạy bridge trước** (mục 3) — để terminal mở.
2. Bấm icon extension → popup hiện ra. Lần đầu sẽ thấy đèn đỏ
   **DISCONNECTED** và ô **Bridge token** trống.
3. Copy token trong terminal bridge (dòng sau chữ `Bridge token`), dán vào ô
   **Bridge token** trong popup (hoặc trong dashboard, tab Local Git), bấm
   **Save connection**.
4. Đèn chuyển **xanh — BRIDGE CONNECTED**. Popup hiện tên repo local (nếu đã
   chọn) và các nút Git.

> **Mẹo:** Token bridge chỉ cần nhập **một lần** — extension lưu vào
> `chrome.storage`. Đổi token khi nào? Chỉ khi bạn xoá thư mục `bridge/` rồi
> chạy lại (bridge sinh token mới) — lúc đó dán token mới vào là xong
> (xem mục 13, "Token bridge không khớp").

### Ý nghĩa 3 trạng thái đèn

| Đèn | Nghĩa | Làm gì |
|---|---|---|
| 🟢 **CONNECTED** | Bridge đang chạy, token đúng | Dùng bình thường |
| 🟡 **RECONNECTING…** | Mất kết nối, đang thử lại (backoff 1 s → 30 s) | Chờ vài giây — thường tự khỏi |
| 🔴 **DISCONNECTED** | Bridge chưa chạy, hoặc token sai | Xem mục 13 |

Nút **Reconnect** (popup + dashboard) thử kết nối lại ngay, không cần chờ
chu kỳ tự động.

---

## 6. Đăng nhập GitHub

Mở **dashboard** (bấm **Open Workspace** trong popup, hoặc
`chrome://extensions` → Details → **Extension options**). Nếu chưa đăng nhập,
đầu trang sẽ có khung **Sign in to GitHub** với 3 cách:

### Cách 1 — Kết nối GitHub bằng tài khoản thật (OAuth Web Flow, khuyên dùng)

1. Tạo OAuth App một lần duy nhất và nhập Client ID + Client Secret vào
   dashboard (mục 3, cuối — chỉ làm 1 lần, làm xong thì nút này mới bật).
2. Trong dashboard bấm nút lớn **CONNECT GITHUB**.
3. Một tab mới mở ra trang **github.com/login/oauth/authorize** — đăng nhập
   bằng tài khoản GitHub thật của bạn (nếu chưa đăng nhập) rồi bấm
   **Authorize** cho App `PixiJS GitHub Sync`.
4. GitHub tự chuyển về bridge (`http://127.0.0.1:17321/api/github/oauth/callback`),
   bridge đổi mã lấy token và lưu như PAT. Tab báo "Đã kết nối GitHub ✓" —
   đóng tab, dashboard tự hiện avatar + tên của bạn (chip ghi "via OAuth Web").
5. Token có scope `repo` + `read:user` — đủ để xem/sửa repo của bạn.

> **An toàn:** link đăng nhập có mã chống giả mạo (`state`) dùng một lần,
> hết hạn sau 10 phút. Bridge không bao giờ ghi token hay Client Secret ra
> log, không trả chúng cho extension (xem mục 12).

### Cách 2 — Personal Access Token

1. Tạo token trên GitHub:
   - **Classic token:** <https://github.com/settings/tokens> → **Generate new
     token (classic)**. Tick 2 scope: **`repo`** (đọc/ghi repo) và
     **`read:user`** (đọc thông tin user). Hạn dùng: chọn 90 ngày hoặc
     "No expiration" nếu bạn tự quản lý.
   - **Fine-grained token:** <https://github.com/settings/tokens?type=beta> →
     **Generate new token**. Resource owner: tài khoản của bạn. Repository
     access: **All repositories** (hoặc chọn repo cụ thể). Permissions:
     **Contents: Read and write**, **Metadata: Read-only** (mặc định).
2. Copy token (dạng `ghp_...` hoặc `github_pat_...`) — **chỉ hiện một lần**,
   mất là phải tạo lại.
3. Dán vào ô **Personal Access Token** trong dashboard → bấm **Sign in**.
4. Bridge kiểm tra token bằng `GET /user`. Đúng → avatar + tên đăng nhập
   hiện ở góc phải header, danh sách repo load ngay. Sai → báo
   "GitHub token rejected (401) — check the token and its scopes".

> **Token GitHub của bạn không bao giờ rời khỏi máy bạn.** Bridge lưu nó vào
> file `bridge/.github-config.json` trên máy (mode 0600, đã gitignore) và
> **không trả lại cho extension** — extension chỉ nhận tên + avatar của bạn
> (xem mục 12).

### Cách 3 — OAuth Device Flow (không cần dán token)

1. Cần cấu hình OAuth App (mục 3, cuối — chỉ cần Client ID, không cần Secret
   cho cách này).
2. Trong dashboard bấm **Sign in with device code** → hiện mã 6 ký tự
   (ví dụ `ABCD-EFGH`) + nút **Open github.com/login/device**.
3. Mở link, đăng nhập GitHub, nhập mã → bấm **Authorize**.
4. Dashboard tự poll và đăng nhập xong trong vài giây.

### Đăng xuất

Bấm avatar/tên đăng nhập ở header → **Sign out**. Token bị xoá khỏi file
config trên máy và khỏi bộ nhớ bridge ngay lập tức; danh sách repo biến mất
cho tới khi đăng nhập lại.

### Token hết hạn thì sao?

- Classic token hết hạn → GitHub trả 401 → dashboard báo "GitHub token
  rejected (401)" và hiện lại khung đăng nhập. Tạo token mới, đăng nhập lại.
- Fine-grained token hết hạn tương tự.
- Xem thêm mục 13.

---

## 7. Dùng dashboard giống github.com

Dashboard có 2 tab: **Repositories** (GitHub) và **Local Git** (máy bạn).

### Header

- **Ô Search** (góc trái): gõ để lọc repo theo tên/mô tả (lọc ngay khi gõ,
  không cần Enter).
- **Bridge status pill**: Connected / Reconnecting / Disconnected + nút
  **Reconnect**.
- **Avatar + tên đăng nhập** (sau khi đăng nhập) → bấm để đăng xuất.
- **Rate limit**: hiện "API 59/60" — số lượt gọi GitHub còn lại trong giờ
  hiện tại; gần hết sẽ cảnh báo vàng.

### Tab Repositories — danh sách TẤT CẢ repo

- Mỗi lần mở tab (hoặc bấm **Refresh**), dashboard gọi
  `GET /api/github/repos/all` — bridge tự phân trang hết repo của bạn
  (public + private + fork), **không giới hạn 30 repo** như API mặc định.
- Mỗi hàng repo hiện: **tên** (`owner/repo`), **mô tả**, **ngôn ngữ chính**,
  ⭐ **số sao**, **fork**, **public/private**, **cập nhật lần cuối**.
- **Lọc:** All / Public / Private / Forks / Sources / Archived.
- **Sắp xếp:** Recently updated / Recently pushed / Most stars / Name /
  Recently created.
- **Tìm kiếm:** ô search trong tab (lọc theo tên + mô tả).
- **Refresh** (làm mới thường — dùng cache 60 s) và **Refresh (force)**
  (bỏ cache, gọi GitHub ngay).
- Repo có commit mới (do auto-update phát hiện) sẽ có **badge "NEW"**.

### Bấm vào một repo — trang chi tiết

- **Overview:** mô tả, ngôn ngữ, sao/fork/issues, nút mở trên github.com,
  và **README** hiển thị bên dưới (đã render Markdown cơ bản).
- **Files:** chọn branch ở dropdown → xem cây thư mục/file → bấm vào file
  để xem nội dung (file text, tối đa ~100 KB). Nút **↑** để lên thư mục cha.
- **Commits:** 10 commit gần nhất (SHA ngắn, message, tác giả, thời gian).
- **Branches:** danh sách branch + SHA đầu branch.
- **Issues:** issue đang mở (tiêu đề, số, người tạo, labels).
- **Pulls:** pull request đang mở.
- Nút **← Back to repositories** để về danh sách.

### Tạo / sửa file trong repo (cơ bản)

Hiện tại dashboard chưa có trình soạn thảo file trực tiếp — muốn tạo/sửa file
hãy dùng **Git local** (mục 9) rồi push, hoặc sửa trên github.com. API
`PUT /api/github/repos/:owner/:repo/contents` đã có sẵn trong bridge để bản
sau thêm trình soạn thảo.

---

## 8. Auto-update repo (tự động làm mới)

Thanh **Auto-update** nằm ngay trên danh sách repo:

1. **Bật/tắt:** gạt công tắc **Auto-update**.
2. **Chọn khoảng thời gian:** 15 giây / 30 giây / 1 phút / 5 phút / 15 phút
   (mặc định 1 phút).
3. Bridge sẽ tự kiểm tra từng repo theo chu kỳ: gọi
   `GET /repos/:owner/:repo/commits?per_page=1` kèm header
   `If-None-Match` (ETag) — nếu GitHub trả **304** (không có gì mới) thì
   **không tốn quota** rate limit.
4. Khi phát hiện repo có commit mới: badge **NEW** xuất hiện ở repo đó,
   thanh trạng thái hiện "Đã phát hiện cập nhật", và (nếu dashboard đang mở)
   danh sách repo tự làm mới.
5. **Check now** — nút làm mới tay: kiểm tra ngay một chu kỳ, không cần chờ
   tới lượt.
6. Thanh trạng thái hiện: **Lần kiểm tra cuối** (giờ), **Cập nhật tiếp theo
   sau …s**, và **tổng số lần phát hiện cập nhật**.

### Auto-sync — tự pull khi remote có commit mới (v2.1, tuỳ chọn)

Bật thêm công tắc **Auto-sync** trong thanh auto-update (chỉ bật được khi
auto-update đang bật):

- Khi auto-update phát hiện repo GitHub tương ứng với repo local của bạn
  (cùng `owner/repo` với remote `origin`) có commit mới, bridge **tự pull**
  (merge) về repo local.
- Chỉ pull khi **working tree đang sạch** (không có file chưa commit).
  Nếu tree đang bẩn, bridge bỏ qua lần đó và ghi rõ lý do ("Working tree
  has uncommitted changes") — không bao giờ tự merge đè lên thay đổi của bạn.
- Kết quả lần auto-sync gần nhất hiện trong thanh auto-update
  (pull được mấy commit / bị bỏ qua vì sao).

> **Lưu ý:** auto-update chỉ **phát hiện** commit mới; muốn lấy code mới về
> repo local mà không bật auto-sync, dùng nút **Pull** ở tab Local Git
> (mục 9).

---

## 9. Git local (tab Local Git)

Tab này giữ nguyên toàn bộ tính năng v1 — làm việc với **một thư mục repo
trên máy bạn** (không cần đăng nhập GitHub).

1. **Chọn repo:** bấm **Choose repository…** → nhập đường dẫn tuyệt đối tới
   thư mục (ví dụ `C:\Users\Ban\3D-Model` hoặc `/home/ban/3D-Model`) →
   **Connect**. Bridge nhớ lựa chọn này (file `.bridge-state.json`).
2. **Trạng thái:** branch hiện tại, remote, số file thay đổi.
3. **Changes:** danh sách file đổi — bấm **Diff** để xem khác biệt,
   **Stage** / **Unstage** từng file, **Stage all** / **Unstage all**.
   Panel **Diff summary** hiện số dòng thêm/xoá của từng file (worktree và
   staged riêng).
4. **Commit:** nhập message → **Commit**. Tick **Amend** để sửa commit gần
   nhất (đổi message, không tạo commit mới); tick **Commit all** để commit
   luôn mọi file đã đổi mà không cần stage tay.
5. **Push / Pull mở rộng (panel Sync):**
   - Huy hiệu **ahead/behind** (ví dụ `↑2 ↓1`) hiện ngay trên panel — số
     commit local chưa push / số commit remote chưa pull, cập nhật sau mỗi
     thao tác.
   - **Pull:** chọn chế độ **Merge** (mặc định, `git pull --no-rebase`),
     **Rebase** (`--rebase`, xếp commit local lên trên commit remote) hoặc
     **FF-only** (chỉ pull khi fast-forward được, từ chối nếu đã rẽ nhánh).
     Chọn remote + branch nguồn. Kết quả báo số commit kéo về, file đổi,
     có fast-forward không. Nếu pull gây **conflict**, panel Merge &
     Conflicts hiện danh sách file conflict để xử lý (xem dưới).
   - **Push:** push branch hiện tại; tick **Set upstream** để gắn
     `origin/<branch>` lần đầu; **Push all branches** để push mọi branch;
     **Push tags** để push tag. **Force push** chỉ dùng
     `--force-with-lease` (không bao giờ dùng `--force` trần) và **bắt buộc
     tick checkbox xác nhận** trong UI thì bridge mới nhận.
   - **Sync (1 nút):** làm liền **fetch → pull → push**, hiện từng bước
     (bước nào lỗi thì dừng ở đó, báo rõ lỗi) — khỏi bấm 3 nút.
6. **Branches:** xem danh sách branch local + remote, chuyển branch, tạo
   branch mới (từ branch nào, checkout ngay hay không), đổi tên, xoá
   (local, có tick xoá cả trên remote, tick force khi cần).
7. **Merge & xử lý conflict:** nhập tên branch → **Merge**. Merge sạch thì
   xong; nếu conflict: danh sách file conflict hiện ra, mỗi file bấm
   **Ours** (giữ bản của mình) hoặc **Theirs** (lấy bản remote); resolve
   hết thì bấm **Commit merge**. Không muốn merge nữa thì **Abort merge**.
8. **Stash:** tạo stash (kèm message), xem danh sách, **Apply** (giữ stash),
   **Pop** (lấy ra rồi xoá stash), **Drop** (xoá stash).
9. **Remotes:** xem danh sách remote (tên + URL), thêm remote, đổi URL,
   xoá remote.
10. **Clone:** nhập URL repo (GitHub hoặc bất kỳ URL git nào) + thư mục đích
    (+ branch, tuỳ chọn) → **Clone**; xong bridge tự chọn repo vừa clone.
11. **History:** xem lịch sử commit có phân trang (**Prev/Next**).

> Mọi lệnh Git chạy bằng `spawn('git', …, { shell: false })` — không qua
> shell nên không sợ injection từ tên file/branch. URL/branch/remote đều
> được kiểm tra trước khi chạy.

---

## 10. Popup nhanh

Bấm icon extension bất cứ lúc nào để mở popup:

- Đèn trạng thái bridge + nút **Reconnect**.
- **Chip GitHub:** avatar + tên đăng nhập + phương thức đăng nhập
  ("via OAuth Web" / "via PAT" / "via Device Flow") — hoặc nút **Sign in**
  mở dashboard.
- **Repo local:** tên repo + branch + huy hiệu ahead/behind (`↑n ↓m`).
- Nút Git nhanh: **Status / Fetch / Pull / Push / Sync** (áp dụng cho repo local).
- **Auto-update:** bật/tắt + khoảng thời gian (đồng bộ với dashboard).
- **Bridge token:** đổi token khi cần (mục 13).
- **Open Workspace:** mở dashboard đầy đủ.

Popup tự kiểm tra lại trạng thái mỗi 10 giây — bridge mở lại là popup tự
xanh, không cần bấm gì.

---

## 11. Cấu trúc thư mục

```
Extention-github-desktop/
├── manifest.json                  # Manifest MV3 ở ROOT (Load unpacked từ root)
├── README.md                      # File này
├── .gitignore                     # .bridge-token, .bridge-state.json, .github-config.json, ...
├── bridge/
│   ├── bridge-server.js           # Bridge v2.1: Git local + GitHub API + SSE + auto-update + auto-sync
│   ├── package.json               # version 2.1.0, scripts start/test/test:v21/test:all
│   ├── start-mac-linux.sh         # Chạy bridge (macOS/Linux)
│   └── start-windows.bat          # Chạy bridge (Windows)
├── extension/
│   ├── manifest.json              # Manifest MV3 ở extension/ (Load unpacked từ đây)
│   ├── background.js              # Service worker: mở dashboard
│   ├── popup.html / popup.js / popup.css
│   └── dashboard.html / dashboard.js / dashboard.css   # Dashboard kiểu github.com
├── tests/
│   ├── run-all.js                 # Chạy cả 5 suite (tự khởi động bridge)
│   ├── bridge-v2-test.js          # Test v2: mock GitHub + bridge thật + dashboard vm
│   ├── bridge-v21-test.js         # Test v2.1: push/pull thật + OAuth Web Flow + auto-sync
│   ├── extension-test.js          # Test Git local v1 (cần bridge chạy)
│   ├── validate-manifest.js       # Kiểm tra cả 2 manifest
│   └── load-from-root-test.js     # Kiểm tra Load unpacked từ root/extension
└── docs/
    └── BRIDGE_V2.md               # Chẩn đoán "Bridge disconnected" + kiến trúc v2/v2.1 + số liệu test
```

---

## 12. Bảo mật — token lưu ở đâu

| Token | Lưu ở đâu | Ai thấy được |
|---|---|---|
| **Token GitHub (PAT/OAuth)** | `bridge/.github-config.json` trên máy bạn, mode 0600, đã gitignore | Chỉ bridge (đọc file) — **không gửi cho extension, không log, không commit** |
| **OAuth App Client Secret** | `bridge/.github-oauth.json` trên máy bạn, mode 0600, đã gitignore (hoặc biến môi trường `GITHUB_OAUTH_CLIENT_SECRET`) | Chỉ bridge (đổi code lấy token) — **không gửi cho extension, không log, không commit** |
| **Token bridge** | `bridge/.bridge-token` trên máy bạn, mode 0600, đã gitignore; bản copy trong `chrome.storage` của extension | Extension (để gọi API bridge), bạn (copy từ terminal) |
| **Cài đặt** (URL bridge, repo local, auto-update) | `chrome.storage` | Chỉ extension |

- Extension **không bao giờ** giữ token GitHub thô hay Client Secret. Mọi lệnh
  GitHub đều đi qua bridge; bridge gắn token khi gọi `api.github.com`.
- Bridge chỉ nghe trên **127.0.0.1** (localhost) — máy khác trong mạng không
  kết nối được.
- **Đừng bao giờ** commit file `.github-config.json`, `.github-oauth.json`,
  `.bridge-token`, `.bridge-state.json` lên GitHub, đừng gửi token/secret qua
  chat/email, đừng dán chúng vào issue công khai. Lỡ lộ token GitHub → vào
  <https://github.com/settings/tokens> → **Revoke** ngay rồi tạo token mới.
  Lỡ lộ Client Secret → vào OAuth App → **Generate a new client secret**.

---

## 13. Xử lý lỗi thường gặp

### "Bridge disconnected" / đèn đỏ — bridge chưa chạy

**Dấu hiệu:** popup/dashboard đỏ, bấm gì cũng báo lỗi kết nối.

1. Kiểm tra terminal chạy bridge còn mở không. Nếu tắt rồi → chạy lại
   (mục 3).
2. Kiểm tra bridge có đang nghe không: mở trình duyệt, vào
   `http://127.0.0.1:17321/health` — phải thấy JSON `{"ok":true,
   "version":"2.1.0", ...}`. Không thấy → bridge chưa chạy (hoặc sai cổng).
3. Nếu dùng cổng khác (biến `BRIDGE_PORT`): sửa **Bridge URL** trong popup
   cho khớp (ví dụ `http://127.0.0.1:18080`).
4. Bấm **Reconnect** trong popup/dashboard.
5. **Từ v2, extension tự thử lại** (backoff 1 s → 30 s) — chỉ cần mở lại
   bridge, đèn sẽ tự xanh trong vài giây, không cần bấm gì.

### "Bridge disconnected" — token bridge không khớp

**Dấu hiệu:** bridge đang chạy (`/health` vẫn trả JSON), nhưng extension
vẫn đỏ; dashboard log có dòng `401` hoặc "token rejected".

**Nguyên nhân:** bạn xoá thư mục `bridge/` rồi chạy lại (bridge sinh token
mới), hoặc đổi máy.

**Sửa:** copy token mới trong terminal bridge → dán vào ô **Bridge token**
trong popup/dashboard → **Save connection**. (Từ v2, popup hiện rõ "token
không khớp — copy token mới từ terminal bridge" thay vì chỉ báo chung chung.)

### "GitHub token rejected (401)" — token GitHub sai / hết hạn

1. Kiểm tra token còn hạn không: <https://github.com/settings/tokens>.
2. Tạo token mới (mục 6, cách 1) → đăng nhập lại trong dashboard.
3. Nếu dùng fine-grained token: kiểm tra **Repository access** có bao gồm
   repo bạn muốn xem không, và quyền **Contents** có phải Read and write
   (hoặc ít nhất Read-only) không.

### "Rate limit exceeded" / API 0/60

- GitHub cho **5.000 lượt gọi/giờ** với token xác thực (60/giờ nếu không
  đăng nhập — bridge v2 không gọi API khi chưa đăng nhập nên không gặp).
- Dashboard hiện số còn lại ở header. Gần hết (≤ 5) sẽ cảnh báo vàng.
- Chờ tới giờ reset (dashboard hiện "reset lúc …") hoặc giảm tần suất
  auto-update (chọn 5–15 phút thay vì 15 giây).
- Auto-update dùng ETag/304 nên **không tốn quota** khi không có gì mới.

### "Manifest file is missing or unreadable" (khi Load unpacked)

- Bạn đang chọn **sai thư mục**: Chrome cần thư mục chứa trực tiếp file
  `manifest.json`. Chọn đúng **`Extention-github-desktop/`** (root repo)
  hoặc **`Extention-github-desktop/extension/`**.
- Nếu tải repo dạng zip: giải nén ra rồi chọn thư mục bên trong, **đừng
  chọn thư mục `...-main/`** nếu bên trong nó còn một thư mục con nữa.

### Dashboard trống / không thấy repo

1. Kiểm tra đã đăng nhập GitHub chưa (avatar hiện ở header chưa?).
2. Bấm **Refresh (force)** trong tab Repositories.
3. Kiểm tra token có scope `repo` không (mục 6) — thiếu scope `repo` thì
   GitHub không trả repo private.
4. Mở DevTools của dashboard (F12) → tab Console xem lỗi; hoặc xem log
   trong terminal bridge.

### "Kết nối GitHub" báo "OAuth Web Flow is not configured"

- Bridge chưa có Client ID + Client Secret của OAuth App. Làm theo mục 3,
  cuối (tạo OAuth App rồi nhập vào form trong dashboard) — nhớ điền đúng
  **Authorization callback URL**:
  `http://127.0.0.1:17321/api/github/oauth/callback` (sai URL này thì
  GitHub sẽ từ chối redirect sau khi đăng nhập).
- Kiểm tra trạng thái trong dashboard (mục đăng nhập): phải hiện
  "OAuth App: configured". Chưa hiện → kiểm tra lại Client ID/Secret đã dán.
- Cách nhanh để kiểm tra: vào `http://127.0.0.1:17321/api/github/oauth/status`
  (cần bridge token) — xem `configured: true` chưa.

### Đăng nhập OAuth xong tab báo "Phiên đăng nhập đã hết hạn hoặc không hợp lệ"

- Mã `state` chỉ dùng được **1 lần** và hết hạn sau **10 phút**. Bấm lại nút
  **Connect GitHub** trong dashboard để lấy link mới, đừng dùng lại link cũ,
  đừng bấm F5 ở trang callback.
- Nếu bấm Authorize trên github.com mà tab callback báo lỗi đổi code:
  kiểm tra Client Secret đã đúng chưa (Secret sai → GitHub từ chối đổi mã).

### Pull / Sync báo conflict — file conflict hiện ra

- Đây không phải lỗi: remote và local cùng sửa một file. Vào tab Local Git
  → panel **Merge & Conflicts** → mỗi file bấm **Ours** (giữ bản local)
  hoặc **Theirs** (lấy bản remote) → resolve hết → **Commit merge** →
  **Push**.
- Không muốn merge nữa: bấm **Abort merge** để về trạng thái trước khi merge.

### Push báo "non-fast-forward" / "rejected"

- Remote có commit mà local chưa có (ai đó push trước). Bấm **Pull** (hoặc
  **Sync**) trước, xử lý conflict nếu có, rồi **Push** lại.
- Muốn ghi đè lịch sử remote: tick **Force-push with lease** + tick
  **xác nhận** trong panel Push rồi bấm Push (bridge chỉ cho
  `--force-with-lease`, không bao giờ dùng `--force` trần).

### Pull --ff-only báo lỗi "Not possible to fast-forward"

- Branch đã rẽ nhánh (local và remote đều có commit riêng). Đổi chế độ Pull
  sang **Merge** hoặc **Rebase** rồi pull lại.

### Device Flow báo "Device Flow is not configured"

- Bridge đang chạy **không có** Client ID của OAuth App. Nhập Client ID vào
  form OAuth App trong dashboard (mục 3, cuối), hoặc chạy bridge với
  `GITHUB_OAUTH_CLIENT_ID=...`, rồi thử lại.
- Hoặc dùng cách 1 (Kết nối GitHub) / cách 2 (dán PAT) — không cần Client ID
  cho PAT.

### Bridge báo "port already in use" (EADDRINUSE)

- Đã có một bridge khác đang chạy ở cổng 17321. Tắt cửa sổ terminal cũ đi,
  hoặc chạy cổng khác: `BRIDGE_PORT=18080 node bridge-server.js` (nhớ sửa
  Bridge URL trong extension).

### Extension không cập nhật sau khi sửa code

- Vào `chrome://extensions` → bấm **Reload** trên thẻ extension.
- Dashboard đang mở: bấm F5 (hoặc Ctrl+R) để tải lại.

---

## 14. Kiểm thử

Toàn bộ test chạy bằng `node`, in PASS/FAIL từng mục, **không gọi
api.github.com thật** (dùng mock GitHub chạy local).

```bash
# Chạy TẤT CẢ (khuyên dùng) — tự khởi động bridge, chạy 5 suite, tắt bridge:
node tests/run-all.js
# hoặc:
npm --prefix bridge run test:all
```

Chạy lẻ từng test:

```bash
node tests/validate-manifest.js      # 18 checks: cả 2 manifest hợp lệ, cùng version
node tests/load-from-root-test.js    # 7 checks: Load unpacked từ root và từ extension/
node tests/bridge-v2-test.js         # 58 checks: mock GitHub + bridge thật + dashboard trong vm
node tests/bridge-v21-test.js        # 107 checks: push/pull trên repo git thật + OAuth Web Flow + auto-sync
node tests/extension-test.js         # 22 checks: Git local v1 (CẦN bridge đang chạy ở 17321)
```

### Kết quả đã chạy (2026-11-23, 2 vòng liên tiếp — xem chi tiết trong `docs/BRIDGE_V2.md`)

| Suite | Vòng 1 | Vòng 2 |
|---|---|---|
| `bridge-v2-test.js` | 58 passed, 0 failed | 58 passed, 0 failed |
| `bridge-v21-test.js` | 107 passed, 0 failed | 107 passed, 0 failed |
| `extension-test.js` | ALL CHECKS PASSED (22) | ALL CHECKS PASSED (22) |
| `validate-manifest.js` | 18/18 | 18/18 |
| `load-from-root-test.js` | 7/7 | 7/7 |

`bridge-v21-test.js` kiểm tra bằng repo git thật (bare remote + 2 clone):
pull merge/rebase/ff-only, push upstream/--all/tags/force-with-lease,
sync 1 nút, ahead/behind, branch tạo/đổi tên/xoá (local + remote), merge
conflict thật + resolve ours/theirs + abort, stash, commit --amend, log
phân trang, diff summary, remotes, clone; OAuth Web Flow với GitHub giả
(authorize URL đúng dạng + state, callback sai state/code bị từ chối,
state dùng lại bị từ chối, token/secret không rò ra ngoài); auto-sync
kéo commit mới về thật và bỏ qua khi tree đang bẩn.

`bridge-v2-test.js` kiểm tra cả kịch bản quan trọng nhất của v2: **giết bridge
giữa chừng → dashboard báo RECONNECTING/DISCONNECTED → khởi động lại bridge
→ dashboard TỰ KẾT NỐI LẠI thành CONNECTED, danh sách repo còn nguyên**.

### Kiểm tra bằng tay với GitHub thật (tuỳ chọn)

1. Chạy bridge, load extension, đăng nhập bằng tài khoản thật (mục 6, cách 1).
2. Tab Repositories phải hiện đủ repo (kiểm tra số lượng với github.com).
3. Bật auto-update 15 s → push một commit lên một repo từ máy khác →
   trong vòng ~30 s dashboard phải hiện badge NEW ở repo đó.
4. Tắt terminal bridge → dashboard chuyển vàng/đỏ → mở bridge lại →
   dashboard tự xanh lại.
5. Tab Local Git: thử Pull (đổi chế độ Merge/Rebase), Push, Sync, tạo
   branch mới rồi push, tạo conflict rồi resolve bằng Ours/Theirs.

---

## 15. Ghi chú cho người dùng điện thoại

- **Extension Chrome cần Chrome máy tính** để Load unpacked (mục 4).
  Chrome trên điện thoại (Android/iOS) **không hỗ trợ** cài extension
  unpacked.
- Bridge cũng cần chạy trên máy tính (Node.js) — điện thoại không chạy được.
- Nếu bạn chỉ có điện thoại: dùng **máy tính của bạn bè/người thân** hoặc
  máy tính công cộng để cài và dùng thử; mọi dữ liệu (token, repo local)
  đều nằm trên máy tính đó — nhớ **đăng xuất GitHub** trong dashboard và
  **xoá thư mục bridge** sau khi dùng xong trên máy không phải của mình.
- Các tính năng khác của repo PixiJS Studio (3D Studio, game WUXIA3D) vẫn
  xem được từ trình duyệt điện thoại nếu publish lên GitHub Pages — đó là
  việc khác, không liên quan tới extension này.

---

## 16. Lịch sử phiên bản

- **v2.1.0 (2026-11-23)** — Mở rộng push/pull + đăng nhập bằng tài khoản
  GitHub thật: OAuth Web Application Flow (nút "Kết nối GitHub", đăng nhập
  trên github.com, callback về bridge, state chống CSRF dùng một lần,
  Client Secret lưu file local 0600); pull merge/rebase/ff-only, push
  upstream/--all/tags/--force-with-lease (cần xác nhận), sync 1 nút,
  ahead/behind, branch tạo/đổi tên/xoá (local + remote), merge + xử lý
  conflict (ours/theirs/abort), stash, commit --amend/--all, log phân
  trang, diff summary, remotes, clone từ URL; auto-sync (tự pull khi
  remote có commit mới, bỏ qua khi tree bẩn). Xem `docs/BRIDGE_V2.md`
  (mục v2.1.0).
- **v2.0.0 (2026-11-23)** — Viết lại toàn bộ: đăng nhập GitHub (PAT +
  OAuth Device Flow), API GitHub đầy đủ (list/search/detail/branches/
  commits/files/README/issues/PRs), dashboard kiểu github.com, auto-update
  repo (polling + ETag + SSE), kết nối bền (health poll + SSE + auto-reconnect
  với backoff), sửa triệt để lỗi "Bridge disconnected" của v1.
  Xem `docs/BRIDGE_V2.md`.
- **v1.0.2 (2026-11-23)** — Sửa Load unpacked từ repo root: thêm
  `manifest.json` ở root, `dashboardUrl()` tự suy ra đường dẫn dashboard.
- **v1.0.1 (2026-11-23)** — Viết lại bridge-server/dashboard/popup,
  manifest 1.0.1 (host_permissions, options_ui, clipboardWrite).
- **v1.0.0 (2026-11-23)** — Bản đầu: bridge Node local + extension MV3
  (popup/dashboard Git local).
