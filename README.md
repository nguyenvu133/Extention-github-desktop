# PixiJS GitHub Desktop Sync — v3.7.1

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
| Node.js | **≥ 12.0.0** (12, 14, 16, 18, 20, 22 đều chạy) — kiểm tra bằng `node --version`. Chưa có thì tải tại <https://nodejs.org> (bản LTS). Lưu ý: Node 12 đã hết hỗ trợ từ 2022, nên nếu cài được bản mới hơn thì vẫn nên dùng bản LTS mới nhất. |
| Git | Đã cài sẵn (`git --version`). Cần cho tính năng Git local |
| Tài khoản GitHub | Để đăng nhập và xem repo (mục 6) |

**Không cần cài thêm thư viện nào.** Bridge chỉ dùng module có sẵn của Node
(`http`, `https`, `fs`, `crypto`, `child_process`) — từ v3.1.0 không còn phụ thuộc `fetch` tích hợp nên chạy được trên Node 12 — không có
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
node --version   # phải ra v12.0 trở lên
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

**Nếu đúp chuột vào `start-windows.bat` mà không mở được** (cửa sổ nháy
rồi tắt hoặc không hiện gì) — xem ngay mục 13
\"Không mở được start-windows.bat\". Tóm tắt: file `.bat` từ v3.0.2 đã
viết lại đúng chuẩn Windows (CRLF + ASCII, kiểm tra Node, kiểm tra cổng,
ghi log ra `bridge\bridge-start.log`, đợi `/health` rồi mới báo thành
công, mọi lỗi đều giữ cửa sổ mở). Nếu vẫn không mở được:

1. Kiểm tra đã **giải nén ZIP** ra thư mục chưa (đừng chạy file trong ZIP).
2. Kiểm tra đã cài **Node.js 12+** chưa (`node -v` trong cmd).
3. Nếu Windows SmartScreen chặn: chuột phải file → **Properties** →
   tích **Unblock** (nếu có) → **OK**, rồi đúp chuột lại; hoặc bấm
   **More info → Run anyway** trên màn hình SmartScreen.
4. Thử **phương án 2 — PowerShell**: chuột phải
   `bridge\start-windows.ps1` → **Run with PowerShell** (hoặc mở
   PowerShell rồi chạy
   `powershell -ExecutionPolicy Bypass -File .\start-windows.ps1`).
5. Chạy **chẩn đoán**: đúp `bridge\bridge-doctor.bat` — nó kiểm tra
   Node, file, cổng 17321, quyền ghi rồi ghi báo cáo ra
   `bridge\bridge-doctor-report.txt`. Gửi file đó lại khi cần giúp.
6. Chạy tay bằng cmd (luôn được): mở cmd, `cd` tới thư mục `bridge`
   rồi gõ `node bridge-server.js`.

**Giữ cửa sổ bridge mở** trong lúc dùng extension — đóng cửa sổ là tắt
bridge. Nếu cửa sổ bridge lỡ tắt, chạy lại file `.bat` (nó sẽ báo nếu
bridge đã chạy sẵn ở cổng 17321 thì cứ dùng luôn).

### macOS / Linux

```bash
cd bridge
./start-mac-linux.sh
# hoặc: node bridge-server.js
```

Khi chạy đúng, terminal sẽ hiện tương tự:

```
PixiJS GitHub Bridge v3.1.0
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

### Nút 1 chạm mở bridge (v3.6.0) — cài host 1 lần, rồi bấm là chạy

Từ v3.6.0, popup và dashboard có nút **KHỞI ĐỘNG BRIDGE**: bấm 1 lần là
bridge tự chạy lên (không cần mở `start-windows.bat` / terminal bằng tay
nữa) rồi extension tự lấy token và kết nối. Cơ chế: extension nói chuyện
với **Native Messaging host** (`bridge/native-host.js`, tên
`com.pixijs.github.bridge`) qua stdio; host này chạy launcher có sẵn
trong thư mục `bridge/` và trả token bridge về cho extension.

**Cài 1 lần duy nhất (Windows + Chrome):**

1. Mở Chrome, vào `chrome://extensions`, bật **Developer mode**.
2. Copy **Extension ID** (32 ký tự, dạng `abcdefghijklmnop...`) của
   extension PixiJS GitHub Desktop Sync.
3. Đúp chuột `bridge\register-native-host.bat`, dán Extension ID vào khi
   được hỏi. File này sinh `bridge\native-host-manifest.json` (đường dẫn
   tuyệt đối + ID thật) và ghi registry key
   `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pixijs.github.bridge`
   trỏ tới manifest đó.
4. **Tắt hết cửa sổ Chrome rồi mở lại** (Chrome chỉ đọc Native Messaging
   host khi khởi động), vào `chrome://extensions` bấm **Reload** trên
   extension này.
5. Mở popup (hoặc dashboard) và bấm **KHỞI ĐỘNG BRIDGE** — đèn phải
   chuyển xanh mà không cần chạy `start-windows.bat` bằng tay. Nếu đổi
   Extension ID (cài lại extension), chạy lại file `.bat` ở bước 3.
   Muốn gỡ: chạy `bridge\unregister-native-host.bat` (xoá registry key
   + file manifest đã sinh).

**GIỚI HẠN NÓI THẬT:**

- Extension **không thể tự chạy file `.bat`** — đó là giới hạn của
  Chrome, không phải lỗi của extension. Bắt buộc phải cài host 1 lần
  bằng tay theo 5 bước trên; sau đó mới bấm 1 chạm được.
- File `register-native-host.bat` / `unregister-native-host.bat` mới chỉ
  được **kiểm chứng bằng bytes + cấu trúc trên Linux** (CRLF từng dòng,
  ASCII thuần, không BOM, đúng registry key, sinh manifest — xem
  `tests/bat-test.js` mục [9]); **chưa test thật trên Windows** (không
  có máy Windows ở đây): chưa ai đúp chuột thật, chưa ghi registry
  thật, chưa bấm nút KHỞI ĐỘNG BRIDGE trên Chrome thật.
- File manifest thật (`bridge/native-host-manifest.json`) chứa đường dẫn
  tuyệt đối trên máy bạn + Extension ID nên **đã gitignore, không đẩy
  lên GitHub**; chỉ có file mẫu
  `bridge/native-host-manifest.json.example` (chứa placeholder
  `YOUR_EXTENSION_ID_HERE`) là được commit.
- Trên macOS/Linux không có `.bat`: chạy
  `sh bridge/register-native-host.sh` (cùng 3 bước lấy Extension ID),
  nó ghi manifest vào
  `~/.config/google-chrome/NativeMessagingHosts/com.pixijs.github.bridge.json`.
  Script này cũng mới chỉ kiểm chứng bằng đọc code, chưa chạy thật.

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

> **⚠️ Gõ email/mật khẩu vào không nhận? (lỗi hay gặp nhất)**
> GitHub đã **bỏ xác thực bằng mật khẩu cho app bên thứ ba** — không một app
> nào được phép nhận mật khẩu GitHub trực tiếp nữa. Vì vậy:
> - **Đừng gõ email/mật khẩu vào ô Personal Access Token** — ô đó chỉ nhận
>   **token** (bắt đầu bằng `ghp_…` hoặc `github_pat_…`). Gõ email/mật khẩu
>   vào đó thì GitHub trả 401 và báo "token rejected". Từ v3.0, dashboard
>   phát hiện ngay khi bạn dán email/mật khẩu và báo rõ, không gửi request.
> - **Nút CONNECT GITHUB không có ô mật khẩu nào cả** — nó mở trang
>   **github.com** để bạn đăng nhập bằng tài khoản thật **trên đó** (kể cả
>   tài khoản bật 2FA), rồi bấm Authorize. Nếu bấm nút mà báo
>   `OAUTH_APP_NOT_CONFIGURED` thì bridge chưa có Client ID + Client Secret
>   của OAuth App — làm theo mục 3, cuối (tạo OAuth App 1 lần duy nhất).
> - Không biết đăng nhập hỏng ở bước nào? Bấm nút **"Kiểm tra đăng nhập"**
>   trong khung đăng nhập (v3.0) — bridge kiểm tra từng bước (bridge,
>   OAuth App, token, scope, rate limit, mạng tới github.com) và chỉ đúng
>   bước hỏng + cách sửa.

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

### Kiểm tra đăng nhập thật (v3.5.0)

Trong khung đăng nhập có panel **"Kiểm tra đăng nhập thật"**: bấm nút để
bridge chạy kiểm tra đăng nhập + `GET /user` + `GET /user/emails` rồi hiện
tên đăng nhập, avatar và **email chính** của tài khoản GitHub đang đăng
nhập. Nếu email chính **không phải `nguyenvu16592b@gmail.com`** thì panel
hiện cảnh báo rõ — bạn đang đăng nhập nhầm tài khoản, hãy đăng xuất rồi
đăng nhập lại bằng đúng tài khoản đó. Panel này **không bao giờ** hỏi hay
hiện mật khẩu / token / Client Secret. Lưu ý: bước đồng ý trên github.com
vẫn phải do chính bạn bấm trong trình duyệt — bridge không thể bấm thay bạn.

### Cấu hình tự động bằng file .env (v3.5.1) — mở lên là dùng được

Nếu bạn chán dán lại token mỗi lần tải code mới về, dùng file `.env`:

**Cách nhanh nhất (Windows):** đúp chuột vào `bridge\setup-env.bat`
(Mac/Linux: `sh bridge/setup-env.sh`). Nó hỏi GitHub PAT, OAuth Client ID/Secret, đường dẫn repo mặc định,
Auto-update bật/tắt, chu kỳ kiểm tra và Auto-sync rồi ghi vào
`bridge\.env` cho bạn. Nó cũng tự sinh một bridge token
ổn định rồi in ra màn hình — bạn dán token đó **1 lần duy nhất** vào
extension (mục LOCAL BRIDGE), sau này không cần dán lại nữa.

**Cách tay:** copy `bridge\.env.example` thành `bridge\.env` rồi điền
các giá trị vào. Các khóa được hỗ trợ: `BRIDGE_TOKEN` (token ổn định
thay vì sinh ngẫu nhiên), `BRIDGE_PORT`, `GITHUB_PAT` (tự đăng nhập
GitHub khi bridge khởi động), `GITHUB_OAUTH_CLIENT_ID`,
`GITHUB_OAUTH_CLIENT_SECRET`, `DEFAULT_REPO_PATH` (tự chọn repo khi
mở bridge), `GITHUB_AUTO_UPDATE_ENABLED`,
`GITHUB_AUTO_UPDATE_INTERVAL_SECONDS`, `GITHUB_AUTO_SYNC`. Auto-update
được giới hạn 15–3600 giây (mặc định 60); auto-sync chỉ pull khi cây làm
việc sạch. Khi đổi các công tắc/chu kỳ trong dashboard, bridge cập nhật
ngay ba khóa này trong `.env` lẫn cấu hình cục bộ; giữ nguyên PAT/OAuth,
ghi chú và các khóa khác. `.env` được ghi atomic với quyền 0600 trên
macOS/Linux và được `.gitignore` loại khỏi Git. Biến môi trường hệ thống
thật luôn có độ ưu tiên cao hơn `.env`.

Sau đó chỉ cần chạy bridge như bình thường — nó tự đọc `.env`, tự đăng
nhập GitHub, tự cấu hình OAuth App, tự chọn repo. Lần đầu mở dashboard
bạn vẫn cần dán bridge token 1 lần (token này giờ đã ổn định, không đổi
nữa). **Cảnh báo:** `bridge\.env` đã được gitignore và **không bao giờ**
được đẩy lên GitHub — ai có file này sẽ đăng nhập GitHub được như bạn.
Đừng gửi nó qua chat/email, đừng chụp màn hình nó.

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

### Trang repo giống github.com hơn nữa (v3.5.0)

- **Tab Actions:** danh sách workflow + các lần chạy (run) với huy hiệu
  trạng thái giống GitHub (xanh lá = thành công, đỏ = thất bại, vàng =
  đang chạy/chờ, xám = đã huỷ/bỏ qua). Bấm vào một run để xem jobs, nút
  **Rerun** / **Cancel** và **Xem log** (log bị cắt ở ~200 KB).
- **Trang commit:** bấm vào một commit trong danh sách Commits để xem
  message đầy đủ, tác giả, thống kê +/- và từng file đã đổi.
- **Blame:** trong trang xem file, bấm **Blame** để xem từng dòng do ai
  viết, ngày nào. **Lịch sử file:** xem các commit đã chạm vào file đó.
- **Compare:** nhập `base...head` (ví dụ `main...feature-x`) để xem repo
  hơn/kém nhau bao nhiêu commit và những file nào đã đổi.
- **Trang Issue / Pull Request:** bấm vào issue/PR để xem nội dung đầy đủ,
  bình luận, file đã đổi và review của PR; có thể viết bình luận mới ngay
  trong dashboard.
- **Command palette:** bấm **Ctrl+K** (hoặc nút `⌘K / Ctrl+K` ở header) để
  nhảy nhanh tới tab, repo, issue/PR theo số, hoặc chạy Fetch/Pull/Push.
- **Giao diện tối:** nút mặt trăng/mặt trời ở header hoặc mục "Giao diện"
  trong Cài đặt — kiểu GitHub Primer dark (`#0d1117`), lựa chọn được lưu
  lại, mở lại vẫn giữ nguyên.

### Tạo / sửa file trong repo (cơ bản)

Hiện tại dashboard chưa có trình soạn thảo file trực tiếp — muốn tạo/sửa file
hãy dùng **Git local** (mục 9) rồi push, hoặc sửa trên github.com. API
`PUT /api/github/repos/:owner/:repo/contents` đã có sẵn trong bridge để bản
sau thêm trình soạn thảo.

---

### Tải repo về dạng .zip (v3.0)

- **Trong danh sách repo:** mỗi dòng repo có nút **⬇ .zip** (tải branch mặc
  định của repo đó, kể cả repo private — bridge gửi token kèm request).
- **Trong trang chi tiết repo:** nút **Tải .zip** ở đầu trang, tải branch
  đang chọn ở ô branch (mặc định là branch chính của repo).
- **Repo local (tab Local Git):** nút **Xuất ZIP local** trong panel
  Push/Pull/Sync — tạo ZIP từ `git archive` của repo đang mở (không cần
  GitHub, không cần mạng).
- **Popup:** nút **Tải .zip** tải ZIP của repo local đang chọn (branch hiện
  tại). Trình duyệt sẽ hiện hộp thoại lưu file `<tên-repo>-<branch>.zip`.
- Lỗi thường gặp: repo/branch không tồn tại → bridge báo "Không tìm thấy
  repo hoặc branch"; hết rate limit → đợi tới giờ reset (xem mục 13).

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

### Cấu hình auto-update đầy đủ và tự lưu vào `.env` (v3.7.0)

Có hai cách đặt cấu hình; dashboard là cách khuyến nghị vì nó tự ghi lại
`.env` sau mỗi thay đổi:

1. Kết nối bridge và đăng nhập GitHub trước. PAT/OAuth vẫn được lưu cục bộ
   theo quy tắc bảo mật ở mục 12; extension không nhận lại token thô.
2. Trong tab **Repositories**, bật **Auto-update** để bridge định kỳ kiểm
   tra repo GitHub. Chọn khoảng kiểm tra trong UI (15 giây, 30 giây, 1,
   5 hoặc 15 phút); API nhận khoảng 15–3600 giây và chuẩn hoá về giới hạn
   này. Mặc định là tắt, 60 giây.
3. Tuỳ chọn **Auto-sync (pull)** chỉ được bật khi Auto-update đang bật.
   Khi có commit mới trên repo trùng remote của repo local đã kết nối,
   bridge chỉ pull khi working tree sạch; nếu có thay đổi chưa commit hoặc
   chưa có branch phù hợp, thao tác bị bỏ qua và lý do được ghi trạng thái.
   Không có force-pull và không tự bỏ thay đổi chưa commit.
4. Mỗi lần lưu auto-update từ dashboard, ba khóa `GITHUB_AUTO_UPDATE_ENABLED`,
   `GITHUB_AUTO_UPDATE_INTERVAL_SECONDS`, `GITHUB_AUTO_SYNC` được đồng
   bộ vào `bridge/.env` và `.github-config.json`. Khi lưu OAuth Client ID/Secret
   hoặc đăng nhập bằng PAT/OAuth, bridge cũng ghi `GITHUB_OAUTH_CLIENT_ID`,
   `GITHUB_OAUTH_CLIENT_SECRET` và `GITHUB_PAT` vào `.env` để lần khởi động
   sau tự cấu hình/đăng nhập; thao tác **Sign out** xóa `GITHUB_PAT` khỏi
   `.env` nhưng giữ OAuth App để bạn có thể đăng nhập lại. Dashboard hiện
   **settings saved to local .env** khi đã đồng bộ; nếu không ghi được
   `.env`, nó báo lỗi thay vì báo lưu thành công. Sau khi khởi động lại,
   bridge khôi phục lựa chọn đã lưu.
5. Có thể cấu hình bằng tay trong `bridge/.env.example` → copy thành
   `bridge/.env`, rồi điền các biến. Hoặc chạy `bridge/setup-env.bat` trên
   Windows / `sh bridge/setup-env.sh` trên macOS/Linux; wizard hỏi các giá
   trị GitHub, repo và 3 tuỳ chọn auto-update. Chu kỳ ngoài 15–3600 giây
   được clamp khi bridge khởi động.
6. Thứ tự ưu tiên là biến môi trường của hệ điều hành trước, `.env` sau,
   rồi cấu hình đã lưu cục bộ. Nếu bạn đã export `GITHUB_AUTO_UPDATE_*`
   trong môi trường chạy bridge, hãy sửa chính biến môi trường đó để tránh
   nó ghi đè giá trị trong `.env` ở lần chạy sau.
7. `.env` có thể chứa PAT và OAuth Client Secret: không đưa file thật lên
   GitHub, không dán vào issue/chat, không chia sẻ ảnh chụp. Bridge giữ
   quyền file 0600 trên hệ thống POSIX; file được ghi qua file tạm rồi
   rename để giảm nguy cơ ghi dở. Khi đổi auto-update chỉ ba khóa auto-update
   được sửa; khi đổi thông tin đăng nhập chỉ khóa credential tương ứng được
   sửa. Comment và cấu hình không liên quan được giữ lại; giá trị PAT/secret
   không bao giờ được trả về dashboard hoặc ghi vào log.

Các khóa `.env`:

| Khóa | Ý nghĩa | Mặc định |
|---|---|---|
| `GITHUB_AUTO_UPDATE_ENABLED` | Tự phát hiện commit mới | `false` |
| `GITHUB_AUTO_UPDATE_INTERVAL_SECONDS` | Chu kỳ kiểm tra (15–3600 giây) | `60` |
| `GITHUB_AUTO_SYNC` | Tự pull repo local khi có commit mới và working tree sạch | `false` |

Auto-update gọi GitHub cho tối đa 100 repo mỗi tick, dùng cache/ETag khi
có thể; đây là tính năng chạy khi bridge còn hoạt động, không phải dịch vụ
đám mây luôn chạy nếu bạn tắt máy hoặc đóng bridge.

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

### Thanh công cụ Fetch / Pull / Push luôn hiện (v3.1.1)

Ngay dưới header, ở **mọi tab**, có thanh giống GitHub Desktop:

| Ô / nút | Làm gì |
|---|---|
| **Repository hiện tại** | Chọn repo local đã dùng gần đây, **＋ Thêm repo có sẵn trên máy…** (nhập đường dẫn) hoặc **＋ Clone repo từ GitHub…** |
| **Branch hiện tại** | Đổi branch (checkout) |
| **Fetch origin** | Lấy thông tin commit mới từ remote, không đổi file. Dòng nhỏ ghi "Fetch lần cuối …" |
| **Pull origin** (số ↓) | Kéo commit mới về (merge + autostash mặc định). Có conflict thì tự mở tab Local Git |
| **Push origin** (số ↑) | Đẩy commit lên. Branch mới chưa có trên remote thì nút đổi thành **Publish branch** (push `-u`) |

Nút nên bấm tiếp theo được tô sáng (giống GitHub Desktop). Dòng trạng thái bên phải báo "Đang …", tiến trình, kết quả hoặc lỗi kèm gợi ý.

**Chưa có repo trên máy?** Tab Repositories → bấm vào repo → **⇣ Clone / Mở bằng Git local**. Bridge clone về `~/GitHub/<tên-repo>` (tự tạo thư mục, dùng token GitHub đã đăng nhập cho repo private, không ghi token vào `.git/config`). Bấm lần sau sẽ mở luôn bản đã clone.

Popup (bấm icon extension) cũng có Fetch Origin / Pull / Push với cùng mặc định.

### Pull / Push nâng cao (v3.1.0)

**Pull**
- Chế độ: `merge`, `rebase`, **rebase giữ merge commit** (`--rebase=merges`), `ff-only`.
- **Xem trước pull** (`POST /api/git/pull/preview`): fetch rồi liệt kê commit sắp nhận, file thay đổi (+/-), cảnh báo nếu có thay đổi chưa commit hoặc có thể conflict.
- Tuỳ chọn: autostash (mặc định bật), prune, lấy/không lấy tag, `--squash`, `--no-commit` (chờ commit tay), strategy option (`ours`/`theirs`/`patience`/… đã whitelist), cho phép unrelated histories, cập nhật submodule, `--unshallow`/`--depth`.
- **Pull tất cả branch** (`POST /api/git/pull/all-branches`): fast-forward mọi branch local có upstream, bỏ qua branch bị lệch.
- **Hoàn tác pull gần nhất** (`POST /api/git/pull/undo`, cần xác nhận): `git reset --keep` về commit trước pull, không mất thay đổi chưa commit.
- Kết quả trả về danh sách commit đã nhận + thống kê file.

**Push**
- **Xem trước push** (`POST /api/git/push/preview`): commit sắp đẩy, file thay đổi, cảnh báo nếu remote đi trước (cần pull trước).
- Tuỳ chọn: push lên nhiều remote cùng lúc, đổi tên branch ở remote, push tới một commit (`upTo`), **dry-run**, `--no-verify`, `--atomic`, `--follow-tags`, push option (`-o`), `--force-with-lease` (kèm SHA) và `--force-if-includes`.
- Dùng `--porcelain` để báo chính xác từng ref: mới, fast-forward, bị từ chối, không đổi.
- Không cho push khi đang merge/rebase dở.

**Chung**
- **Dùng token GitHub đã đăng nhập** cho remote `https://github.com` (mặc định bật) — truyền qua credential helper tạm thời, không ghi token vào `.git/config`.
- **Thanh tiến trình** (SSE `git-progress`) và **lịch sử pull/push** 50 lần gần nhất (`GET /api/git/sync-history`).
- **Rebase dở dang**: thanh trạng thái hiện Continue / Skip / Abort (`/api/git/rebase/*`); Continue bị chặn nếu còn file conflict. Khi resolve conflict trong lúc rebase, "ours" luôn là bản của bạn.
- Lỗi được phân loại kèm gợi ý tiếng Việt (chưa đăng nhập, non-fast-forward, conflict, mạng, quyền…).
- Sync có thể chỉ pull (`pushAfter=false`) và bỏ qua push khi không có gì để đẩy.

### Pull Origin mở rộng (v3.5.0)

Panel **Pull Origin** trong tab Local Git:

- **Chọn remote rõ ràng:** origin / upstream / bất kỳ remote nào của repo
  (lấy từ `GET /api/git/remotes`) — không còn mặc định ngầm là origin.
- **Chọn branch** sẽ pull, **chế độ** merge / rebase / chỉ fast-forward,
  và bật/tắt **autostash** (tự cất thay đổi chưa commit rồi trả lại sau pull).
- **Pull tất cả remote** (`POST /api/git/pull/remotes`): pull lần lượt từng
  remote, mỗi remote báo kết quả riêng; remote nào lỗi thì các remote sau
  vẫn chạy tiếp (trừ khi đang kẹt merge conflict).
- **Dòng upstream** (`GET /api/git/upstream`): hiện `Upstream:
  origin/main • ahead 0 behind 2`, hoặc "Chưa có upstream" nếu branch chưa
  gắn với remote nào.
- **Worktrees** (`GET /api/git/worktrees`, `POST /api/git/worktree/add|remove`):
  tạo/xoá worktree để làm nhiều branch cùng lúc mà không cần clone lại.
- **Sơ đồ commit** (`GET /api/git/graph`): `git log --graph --all` tối đa
  200 dòng.

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
│   ├── bridge-server.js           # Bridge v3.0.2: Git local + GitHub API + SSE + auto-update + auto-sync + zip + API v3 + connection-test + CORS localhost/null
│   ├── native-host.js             # Native Messaging host v3.6.0 (stdio 4-byte LE + JSON, chỉ chạy 2 launcher có sẵn, không in token)
│   ├── native-host.bat            # Wrapper chạy native-host.js (đích của manifest)
│   ├── native-host-manifest.json.example  # Mẫu manifest (placeholder YOUR_EXTENSION_ID_HERE) — file thật đã gitignore
│   ├── register-native-host.bat / unregister-native-host.bat  # Đăng ký / gỡ host 1 lần (Windows, ghi registry HKCU...NativeMessagingHosts)
│   ├── register-native-host.sh    # Đăng ký host 1 lần (macOS/Linux, ghi ~/.config/google-chrome/NativeMessagingHosts/)
│   ├── package.json               # version 3.7.1, scripts start/test/test:v21/test:v3/test:v301/test:v302/test:all/test:v360/test:v361/test:v370
│   ├── start-mac-linux.sh         # Chạy bridge (macOS/Linux)
│   ├── start-windows.bat          # Chạy bridge (Windows) — CRLF + ASCII, kiểm tra Node/cổng, đợi /health, ghi bridge-start.log
│   ├── start-windows.ps1          # Chạy bridge (Windows, PowerShell) — phương án 2 khi .bat bị chặn
│   ├── bridge-doctor.bat          # Chẩn đoán Windows — ghi bridge-doctor-report.txt
│   └── bridge-doctor.sh           # Chẩn đoán macOS/Linux — ghi bridge-doctor-report.txt
├── extension/
│   ├── manifest.json              # Manifest MV3 ở extension/ (Load unpacked từ đây)
│   ├── native-bridge.js           # v3.6.0: gọi Native Messaging host (nút KHỞI ĐỘNG BRIDGE)
│   ├── background.js              # Service worker: mở dashboard
│   ├── popup.html / popup.js / popup.css
│   └── dashboard.html / dashboard.js / dashboard.css   # Dashboard kiểu github.com
├── tests/
│   ├── run-all.js                 # Chạy cả 15 suite (tự khởi động bridge)
│   ├── bridge-v2-test.js          # Test v2: mock GitHub + bridge thật + dashboard vm
│   ├── bridge-v21-test.js         # Test v2.1: push/pull thật + OAuth Web Flow + auto-sync
│   ├── bridge-v3-test.js          # Test v3.0: chẩn đoán đăng nhập + zip + API v3 + git local mới
│   ├── bridge-v301-test.js        # Test v3.0.1: fix "Failed to fetch" (bridge tắt thật + CORS + login gate + start script)
│   ├── bridge-v302-test.js        # Test v3.0.2: .bat CRLF/ASCII + .ps1 + doctor + launcher đợi /health
│   ├── bridge-v350-test.js        # Test v3.5.0: pull origin trên git thật + mock-OAuth end-to-end + Actions/repo pages/worktrees
│   ├── native-host-test.js        # Test v3.6.0: host Native Messaging thật (framed stdio + start-bridge/get-token/status/setup-env + không lộ token)
│   ├── bat-test.js                # Test .bat/.ps1/.sh theo byte + cấu trúc + register/unregister native host (176 checks)
│   ├── bridge-client.js           # (nằm ở extension/) helper fetch tập trung: dịch lỗi mạng sang tiếng Việt
│   ├── extension-test.js          # Test UI v3.0.1 (cần bridge chạy)
│   ├── validate-manifest.js       # Kiểm tra cả 2 manifest
│   └── load-from-root-test.js     # Kiểm tra Load unpacked từ root/extension
└── docs/
    └── BRIDGE_V2.md               # Chẩn đoán "Bridge disconnected" + kiến trúc v2/v2.1/v3.0/v3.0.1/v3.0.2/v3.6.0 + số liệu test
```

---

## 12. Bảo mật — token lưu ở đâu

| Token | Lưu ở đâu | Ai thấy được |
|---|---|---|
| **Token GitHub (PAT/OAuth access token)** | `bridge/.github-config.json` và `GITHUB_PAT` trong `bridge/.env` trên máy bạn (cả hai gitignore; quyền 0600 trên POSIX) | Chỉ bridge — **không gửi raw token cho extension, không log, không commit** |
| **OAuth App Client Secret** | `bridge/.github-oauth.json` và `GITHUB_OAUTH_CLIENT_SECRET` trong `bridge/.env` (cả hai gitignore; quyền 0600 trên POSIX) | Chỉ bridge (đổi code lấy token) — **không gửi cho extension, không log, không commit** |
| **Token bridge** | `bridge/.bridge-token` trên máy bạn, mode 0600, đã gitignore; bản copy trong `chrome.storage` của extension (hoặc `BRIDGE_TOKEN` trong `bridge/.env`) | Extension (để gọi API bridge), bạn (copy từ terminal) |
| **Native host 1 chạm** (v3.6.0) | `bridge/native-host-manifest.json` (sinh bởi `register-native-host.bat` / `.sh`, đã gitignore — chứa đường dẫn tuyệt đối + Extension ID) + registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pixijs.github.bridge` (Windows) hoặc `~/.config/google-chrome/NativeMessagingHosts/com.pixijs.github.bridge.json` (macOS/Linux) | Chỉ Chrome (để tìm host) — **không chứa token/secret nào**; host chỉ chạy 2 launcher có sẵn trong `bridge/` và chỉ trả token bridge cho extension đã đăng ký trong `allowed_origins` |
| **Cài đặt** (URL bridge, repo local, auto-update) | `chrome.storage` | Chỉ extension |

- Extension **không bao giờ** giữ token GitHub thô hay Client Secret. Mọi lệnh
  GitHub đều đi qua bridge; bridge gắn token khi gọi `api.github.com`.
- Bridge chỉ nghe trên **127.0.0.1** (localhost) — máy khác trong mạng không
  kết nối được.
- **Đừng bao giờ** commit file `.github-config.json`, `.github-oauth.json`,
  `.bridge-token`, `.bridge-state.json`, **`bridge/.env`** lên GitHub, đừng gửi token/secret qua
  chat/email, đừng dán chúng vào issue công khai. Lỡ lộ token GitHub → vào
  <https://github.com/settings/tokens> → **Revoke** ngay rồi tạo token mới.
  Lỡ lộ Client Secret → vào OAuth App → **Generate a new client secret**.

---

## 13. Xử lý lỗi thường gặp

### Không mở được start-windows.bat (đúp chuột không chạy / cửa sổ nháy rồi tắt) (v3.0.2)

**Dấu hiệu:** đúp chuột vào `bridge\start-windows.bat` mà cửa sổ chỉ
nháy lên rồi tắt ngay, hoặc không hiện gì cả — bridge không chạy nên
extension báo Disconnected và không đăng nhập được.

**Nguyên nhân đã kiểm chứng:** file `.bat` ở các bản trước v3.0.2 là
UTF-8 với xuống dòng LF (không có CR) và chứa ký tự ngoài ASCII
(em-dash) — cmd.exe trên Windows mong đợi file `.bat` có CRLF nên đọc
sai lệnh, cửa sổ tắt trước khi kịp hiện lỗi. Từ v3.0.2 file đã viết lại
đúng chuẩn (CRLF từng dòng, ASCII thuần, không BOM), kiểm tra từng bước
(Node → file → cổng → chạy → đợi `/health`), ghi log ra
`bridge\bridge-start.log` và giữ cửa sổ mở ở mọi đường thoát lỗi.

**Kiểm tra theo thứ tự:**

1. **Đã giải nén ZIP chưa?** Tải repo dạng ZIP thì phải giải nén ra một
   thư mục rồi mới chạy. **Đừng** đúp chuột vào file `.bat` khi nó còn
   nằm trong ZIP (Windows mở file trong thư mục tạm, thiếu
   `bridge-server.js` nên tắt ngay).
2. **Đã cài Node.js 12+ chưa?** Mở cmd, gõ `node -v` — phải thấy
   `v12.x` trở lên. Chưa có thì cài tại <https://nodejs.org/> (bản LTS),
   cài xong đóng hết cửa sổ cmd rồi chạy lại file `.bat`.
3. **Windows SmartScreen chặn file tải từ internet?** Chuột phải file
   `.bat` → **Properties** → nếu có mục **Unblock** ở dưới thì tích vào
   → **OK**, rồi đúp chuột lại. Hoặc khi màn hình xanh SmartScreen hiện
   lên, bấm **More info → Run anyway**.
4. **Antivirus chặn file `.bat`?** Tạm tắt phần mềm diệt virus, hoặc
   thêm thư mục `Extention-github-desktop` vào danh sách loại trừ, rồi
   thử lại. Nếu vẫn bị chặn, dùng phương án 5.
5. **Thử file PowerShell thay thế:** chuột phải
   `bridge\start-windows.ps1` → **Run with PowerShell**. Nếu PowerShell
   báo lỗi về ExecutionPolicy thì mở PowerShell rồi chạy:
   `powershell -ExecutionPolicy Bypass -File .\start-windows.ps1`
   (chạy trong thư mục `bridge`).
6. **Chạy tay bằng cmd (luôn được):** mở cmd, gõ
   `cd <đường-dẫn-tới-thư-mục-bridge>` rồi gõ `node bridge-server.js`.
   Nếu hiện `Listening: http://127.0.0.1:17321` là bridge đã chạy —
   lỗi chỉ nằm ở file `.bat`, không phải ở bridge.
7. **Vẫn lỗi — gửi log lại:** đúp `bridge\bridge-doctor.bat` (nó kiểm
   tra Node, file, cổng 17321, quyền ghi rồi ghi báo cáo ra
   `bridge\bridge-doctor-report.txt`), rồi gửi 2 file
   `bridge\bridge-start.log` và `bridge\bridge-doctor-report.txt` lại
   để được giúp. Trên Mac/Linux dùng `bridge/bridge-doctor.sh` thay
   thế.

**Nhớ:** cửa sổ bridge **phải để mở** trong lúc dùng extension. Đóng
cửa sổ là tắt bridge. File `.bat` v3.0.2 khi chạy đúng sẽ in
`Bridge da chay: http://127.0.0.1:17321` + dòng `TOKEN:` — dán TOKEN đó
vào ô Bridge token trong extension rồi mới bấm đăng nhập.

**Giới hạn kiểm thử nói thật (v3.5.0):** `cmd.exe` không chạy được trên
Linux nên các file `.bat` ở đây **không được chạy thử trên Windows thật**
— chúng được kiểm chứng bằng byte + cấu trúc trong `tests/bat-test.js`
(105 checks: CRLF từng dòng, ASCII thuần, không BOM, label/goto đúng,
`setlocal`/`endlocal` cân bằng, mọi `exit /b 1` đều có `pause` trước).
Bước cuối cùng vẫn cần bạn: đúp chuột vào `start-windows.bat` trên máy
Windows thật và xem nó in ra "Bridge da chay" hay không.

### "ERROR: Failed to fetch" khi bấm đăng nhập (v3.0.1)

**Dấu hiệu:** bấm CONNECT GITHUB / Device Flow / PAT thì báo
`Failed to fetch` (từ v3.0.1 extension sẽ báo tiếng Việt thay cho dòng
này, nhưng nguyên nhân thì như nhau).

**Nguyên nhân số 1 (gần như luôn đúng): bridge chưa chạy.** `Failed to
fetch` nghĩa là trình duyệt không nhận được phản hồi nào từ bridge —
thường vì terminal chạy bridge đã tắt, hoặc bạn chưa chạy bridge lần nào.

**Kiểm tra theo thứ tự:**

1. **Mở bridge trước:** Windows đúp `bridge/start-windows.bat`;
   macOS/Linux chạy `bridge/start-mac-linux.sh`. Đợi terminal hiện
   `Listening: http://127.0.0.1:17321`.
2. **Kiểm tra bridge có nghe không:** mở trình duyệt, vào
   `http://127.0.0.1:17321/health` — phải thấy JSON `{"ok":true,
   "version":"3.0.2", ...}`. Không thấy → bridge chưa chạy (hoặc sai
   cổng, xem bước 4).
3. **Nhìn đèn trong extension:** đèn phải xanh mới bấm đăng nhập. Từ
   v3.0.1, khi bridge tắt thì các nút đăng nhập **bị mờ + hiện khung
   "Bridge chưa chạy"** kèm 3 bước mở bridge và nút **"Thử lại"** —
   làm theo khung đó.
4. **Sai cổng:** nếu bạn chạy bridge bằng `BRIDGE_PORT` khác 17321 thì
   sửa **Bridge URL** trong popup cho khớp (ví dụ
   `http://127.0.0.1:18080`).
5. **Vẫn lỗi:** bấm **"Chẩn đoán kết nối"** trong dashboard — nó kiểm
   tra từng bước (bridge trả lời không → đúng cổng không → CORS có qua
   không → `/health` có ok không → `/oauth/status` ra sao) và hiện kết
   quả từng bước bằng tiếng Việt. Chụp màn hình 5 bước đó nếu cần hỏi
   thêm.
6. **Mở dashboard ngoài extension:** nếu bạn mở `dashboard.html`
   trực tiếp từ file (`file://`) thì trình duyệt chặn fetch về bridge —
   dashboard sẽ hiện banner cảnh báo. Luôn mở dashboard từ **popup của
   extension** (bấm icon extension → "Mở Dashboard").

### "Bridge disconnected" / đèn đỏ — bridge chưa chạy

**Dấu hiệu:** popup/dashboard đỏ, bấm gì cũng báo lỗi kết nối.

1. Kiểm tra terminal chạy bridge còn mở không. Nếu tắt rồi → chạy lại
   (mục 3).
2. Kiểm tra bridge có đang nghe không: mở trình duyệt, vào
   `http://127.0.0.1:17321/health` — phải thấy JSON `{"ok":true,
   "version":"3.0.2", ...}`. Không thấy → bridge chưa chạy (hoặc sai cổng).
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

### Gõ email/mật khẩu vào ô đăng nhập không nhận (v3.0)

- **Đây không phải lỗi của extension.** GitHub đã tắt xác thực bằng mật khẩu
  cho app bên thứ ba từ 2020. **Không app nào** (kể cả app chính chủ khác)
  được phép nhận mật khẩu GitHub của bạn trực tiếp.
- **Cách đúng:** đăng nhập bằng tài khoản thật **trên trang github.com** —
  bấm **CONNECT GITHUB** (OAuth Web Flow) hoặc **Device Flow** (nhập mã 6 ký
  tự tại github.com/device). Tài khoản bật 2FA vẫn đăng nhập được bình thường
  trên github.com.
- **Hoặc dán token PAT** (không phải mật khẩu): tạo tại
  <https://github.com/settings/tokens> — token bắt đầu bằng `ghp_…`
  (classic) hoặc `github_pat_…` (fine-grained), scope `repo` + `read:user`.
- Bấm **"Kiểm tra đăng nhập"** trong khung đăng nhập để bridge chẩn đoán
  từng bước và chỉ đúng chỗ hỏng.

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
# Chạy TẤT CẢ (khuyên dùng) — tự khởi động bridge, chạy 15 suite, tắt bridge:
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
node tests/bridge-v3-test.js         # 108 checks: chẩn đoán đăng nhập + PAT guard + zip + API v3 + git local mới
node tests/bridge-v301-test.js       # 64 checks: fix "Failed to fetch" (bridge tắt thật + CORS + login gate + start script)
node tests/bridge-v302-test.js       # 82 checks: .bat CRLF/ASCII + .ps1 + doctor (chạy thật) + launcher đợi /health
node tests/bridge-v310-test.js       # 55 checks: pull/push mở rộng (preview, autostash, undo, rebase, all-branches)
node tests/bridge-v311-test.js       # toolbar luôn hiện (recent/find repo, fetch từng remote, clone, publish branch)
node tests/bridge-v350-test.js       # pull origin trên git thật + mock-OAuth end-to-end + Actions/repo pages/worktrees
node tests/native-host-test.js      # host Native Messaging thật: framed stdio + start-bridge/get-token/status/setup-env + không lộ token
node tests/bat-test.js               # 176 checks: .bat/.ps1/.sh theo byte + cấu trúc (không cần Windows) + register/unregister native host
node tests/extension-test.js         # 93 checks: Git local + UI v3.0.1 (CẦN bridge đang chạy ở 17321)
```

### Kết quả đã chạy v3.5.0 (2026-11-23, 2 vòng liên tiếp — xem chi tiết trong `docs/BRIDGE_V2.md`)

| Suite | Vòng 1 | Vòng 2 |
|---|---|---|
| `bridge-v2-test.js` | 58 passed, 0 failed | 58 passed, 0 failed |
| `bridge-v21-test.js` | 107 passed, 0 failed | 107 passed, 0 failed |
| `bridge-v3-test.js` | 108 passed, 0 failed | 108 passed, 0 failed |
| `bridge-v301-test.js` | 64 passed, 0 failed | 64 passed, 0 failed |
| `bridge-v302-test.js` | 82 passed, 0 failed | 82 passed, 0 failed |
| `bridge-v310-test.js` | 55 passed, 0 failed | 55 passed, 0 failed |
| `bridge-v311-test.js` | 27 passed, 0 failed | 27 passed, 0 failed |
| `bridge-v350-test.js` | 70 passed, 0 failed | 70 passed, 0 failed |
| `bat-test.js` | 105 passed, 0 failed | 105 passed, 0 failed |
| `extension-test.js` | ALL CHECKS PASSED (93) | ALL CHECKS PASSED (93) |
| `validate-manifest.js` | 18/18 | 18/18 |
| `load-from-root-test.js` | 7/7 | 7/7 |

`bridge-v350-test.js` kiểm tra bằng repo git thật (bare origin + bare
upstream + 2 clone): pull origin main/branch, pull với autostash trên cây
đang bẩn, pull --rebase gặp conflict rồi resolve, pull tất cả remote,
undo pull, upstream; mock-OAuth end-to-end (start → callback → đổi code
lấy token → `/me` + `/user/emails` với email chính
`nguyenvu16592b@gmail.com`); các route mới Actions, commit detail,
compare, languages/contributors/topics, issue/PR detail, worktrees,
graph, blame, file history. `bat-test.js` kiểm tra `.bat`/`.ps1`/`.sh`
bằng byte + cấu trúc (không chạy `cmd.exe` trên Linux).

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

- **v3.7.1 (2026-11-25)** — **Chạy được trên Node.js 12:** hạ yêu cầu
  tối thiểu từ 16.13 xuống **12.0.0** — sửa 5 chỗ dùng cú pháp/API sau
  Node 12 trong `bridge-server.js` (`??` ở `normalizeRepo` và
  rate-limit, `?.()` ở auto-update tick) thành cách viết tương đương
  chạy được trên Node 12 (code `.env` sync mới của v3.7.0 đã không dùng
  cú pháp mới nên giữ nguyên); hạ cổng kiểm tra phiên bản trong
  `start-windows.bat` / `.ps1` / `.sh` và `bridge-doctor` xuống 12;
  `engines` trong `package.json` thành `>=12.0.0`. Đã kiểm chứng bằng
  Node 12.22.12 thật (suite mới `tests/node12-test.js` 14/14, chạy bridge
  bằng `BRIDGE_NODE`). Lưu ý: Node 12 đã hết hỗ trợ từ 2022, nên nếu cài
  được bản mới hơn thì vẫn nên dùng bản LTS mới nhất; toàn bộ suite test
  còn lại vẫn chạy trên Node hiện tại (chỉ bridge là chạy được trên 12).
  Test: 15 suite.
- **v3.7.0 (2026-11-24)** — Cấu hình GitHub auto-update đầy đủ hơn:
  `GITHUB_AUTO_UPDATE_ENABLED`, chu kỳ `GITHUB_AUTO_UPDATE_INTERVAL_SECONDS`
  (15–3600 giây) và `GITHUB_AUTO_SYNC` được đọc từ `.env` khi khởi động,
  tự cập nhật vào `.env` khi đổi trong dashboard; PAT/OAuth nhập từ dashboard
  cũng tự sync vào `.env`, và sign-out xóa PAT. Credentials vẫn được lưu trong
  các file config riêng hiện có. Ghi `.env` atomic, giữ nguyên secrets/comments và
  đặt mode 0600; dashboard cho biết trạng thái sync. Wizard Windows và
  macOS/Linux hỏi cấu hình auto-update. Test mới xác nhận ghi/khôi phục
  sau restart và bảo vệ permission.

- **v3.6.0 (2026-11-23)** — **Nút 1 chạm mở bridge:** popup và
  dashboard có nút **KHỞI ĐỘNG BRIDGE** — bấm 1 lần là bridge tự chạy
  lên rồi extension tự lấy token và kết nối, không cần mở
  `start-windows.bat` / terminal bằng tay nữa. Cơ chế: Native Messaging
  host `bridge/native-host.js` (tên `com.pixijs.github.bridge`, giao
  thức stdio 4-byte little-endian length + JSON, actions
  `start-bridge` / `setup-env` / `get-token` / `status`, chỉ chạy 2
  launcher có sẵn trong `bridge/`, không bao giờ in token ra stdout);
  cài host 1 lần bằng `bridge/register-native-host.bat` (dán Extension
  ID từ `chrome://extensions`, ghi registry key
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pixijs.github.bridge`
  + sinh manifest) hoặc `bridge/register-native-host.sh` trên
  macOS/Linux; gỡ bằng `bridge/unregister-native-host.bat`; quyền
  `nativeMessaging` trong manifest. **Giới hạn nói thật:** extension
  không thể tự chạy `.bat` nên bắt buộc cài host 1 lần bằng tay;
  `.bat` đăng ký mới chỉ kiểm chứng bằng bytes + cấu trúc trên Linux,
  chưa test thật trên Windows (chưa ghi registry thật, chưa bấm nút
  trên Chrome thật). Test: 14 suite (suite mới
  `tests/native-host-test.js` 27/27; `tests/bat-test.js` 176/176 gồm
  mục [9] kiểm tra register/unregister).
- **v3.5.1 (2026-11-23)** — **Cấu hình tự động bằng file `.env` (mở lên
  là dùng được):** bridge tự đọc `bridge/.env` khi khởi động —
  `BRIDGE_TOKEN` ổn định (không đổi mỗi lần tải lại), `GITHUB_PAT` tự
  đăng nhập GitHub, `GITHUB_OAUTH_CLIENT_ID/SECRET` tự cấu hình OAuth
  App, `DEFAULT_REPO_PATH` tự chọn repo; biến môi trường thật luôn thắng
  `.env`; PAT sai hoặc repo không tồn tại chỉ ghi cảnh báo, bridge vẫn
  chạy. Thêm `bridge/.env.example` (mẫu an toàn, không có secret thật),
  `bridge/setup-env.bat` / `bridge/setup-env.sh` (hỏi 3 giá trị 1 lần rồi
  ghi `bridge/.env` 0600, tự sinh bridge token ổn định); `.env` đã
  gitignore, **không bao giờ** đẩy lên GitHub. Test: 13 suite (suite mới
  `tests/env-test.js` 22/22).
- **v3.5.0 (2026-11-23)** — "Giống github.com hơn nữa": **tab Actions**
  (workflows, runs, jobs, log, Rerun/Cancel); **trang repo mở rộng**
  (chi tiết commit, blame, lịch sử file, compare `base...head`, chi tiết
  issue/PR + bình luận, languages/contributors/topics); **command palette**
  (Ctrl+K); **giao diện tối kiểu Primer** (lưu trong chrome.storage);
  **Pull Origin mở rộng** (chọn remote/branch/mode/autostash, pull tất cả
  remote, xem upstream, worktrees, sơ đồ commit); **kiểm tra đăng nhập
  thật** (hiện email chính, cảnh báo nếu không phải
  `nguyenvu16592b@gmail.com`); sửa `start-windows.bat` /
  `bridge-doctor.bat` thiếu `endlocal` và `start-mac-linux.sh` chứa
  em-dash. Test: 12 suite, 2 vòng liên tiếp đều qua (suite mới
  `bridge-v350-test.js` và `bat-test.js` 105/105).
- **v3.1.1 (2026-11-23)** — Thêm **thanh công cụ luôn hiện** (Repository / Branch / Fetch origin / Pull origin / Push origin / Publish branch) — trước đây nút Fetch/Pull/Push nằm sâu trong tab Local Git nên khó thấy. Nút **Clone / Mở bằng Git local** trong trang repo. Sửa bridge: Fetch và Clone giờ dùng token GitHub đã đăng nhập (repo private trước đây lỗi xác thực), Fetch từng remote riêng, báo lỗi rõ khi chưa có remote, Clone tự tạo thư mục cha; API mới `/api/repo/recent`, `/api/repo/find`. Sửa popup: kết quả Fetch/Pull/Push không còn bị "Token accepted" ghi đè; Pull dùng autostash, Push tự publish branch mới. Test: 10 suite qua trên Node 16.13.0 và 20; test end-to-end bằng Chromium thật `tests/e2e-toolbar.js` 49/49.
- **v3.1.0 (2026-11-23)** — Mở rộng pull/push (xem trước, pull tất cả branch, hoàn tác pull, rebase giữ merge commit, squash/no-commit, strategy option, push nhiều remote, dry-run, atomic, follow-tags, push option, force-with-lease + force-if-includes, porcelain), dùng token GitHub cho remote HTTPS, tiến trình SSE, lịch sử pull/push, thanh Continue/Skip/Abort khi rebase dở. **Hạ yêu cầu Node.js xuống 16.13.0**: bỏ `fetch`/`Readable.fromWeb`/`AbortSignal.timeout`, thay bằng `http`/`https` có sẵn. Sửa lỗi `start-windows.bat` đọc nhầm số phiên bản Node (Node 22.11 bị coi là quá cũ). Test: 9 suite đều qua trên Node 16.13.0 và Node 20 (suite mới `bridge-v310-test.js`: 55/55).
- **v3.0.2 (2026-11-23)** — Sửa triệt để lỗi không mở được
  `start-windows.bat` (đúp chuột không chạy / cửa sổ nháy rồi tắt):
  file `.bat` viết lại đúng chuẩn Windows (CRLF từng dòng, ASCII thuần,
  không BOM — bản cũ là UTF-8 + LF + chứa em-dash nên cmd.exe đọc sai),
  kiểm tra từng bước (Node.js 18+ → file `bridge-server.js` → cổng
  17321 → chạy → đợi `/health` tối đa 10 lần), ghi log ra
  `bridge-start.log`, mọi đường thoát lỗi đều giữ cửa sổ mở, cổng bận
  thì kiểm tra `/health` để biết có phải bridge đã chạy sẵn không; thêm
  `start-windows.ps1` (phương án 2 khi `.bat` bị SmartScreen/antivirus
  chặn), `bridge-doctor.bat` / `bridge-doctor.sh` (chẩn đoán và ghi
  `bridge-doctor-report.txt` để gửi lại khi cần giúp); hướng dẫn trong
  dashboard nhắc tới `.ps1` và doctor; README mục 3 + mục 13 thêm
  checklist xử lý lỗi `.bat` theo thứ tự (giải nén ZIP → cài Node →
  Unblock/SmartScreen → thử `.ps1` → chạy tay bằng cmd → gửi log).
  Xem `docs/BRIDGE_V2.md` (mục v3.0.2) và README mục 13.
- **v3.0.1 (2026-11-23)** — Sửa lỗi `ERROR: Failed to fetch` khi đăng
  nhập: helper fetch tập trung `extension/bridge-client.js` (mọi lỗi mạng
  dịch thành `BRIDGE_UNREACHABLE` + thông báo tiếng Việt "Bridge chưa
  chạy — chạy bridge trước rồi bấm lại", không bao giờ hiện "Failed to
  fetch" thô); mọi nút đăng nhập kiểm tra `/health` trước, bridge tắt thì
  nút bị vô hiệu hoá + hiện hướng dẫn mở bridge ngay tại chỗ; panel
  "Chẩn đoán kết nối" kiểm tra 5 bước (bridge → cổng → CORS → `/health`
  → `/oauth/status`); bridge thêm route `GET /api/connection-test` và
  CORS cho `localhost` + origin `null`, log origin lạ; start script
  kiểm tra node, giữ cửa sổ mở khi lỗi; banner cảnh báo khi mở dashboard
  ngoài extension. Xem `docs/BRIDGE_V2.md` (mục v3.0.1) và README mục 13.
- **v3.0.0 (2026-11-23)** — Sửa triệt để lỗi đăng nhập + Download .zip +
  thêm nhiều tính năng: chẩn đoán đăng nhập từng bước
  (`GET /api/github/login/diagnostics`, 6 check tiếng Việt), PAT chặn ngay
  email/mật khẩu (`INVALID_TOKEN_FORMAT`), OAuth start báo rõ khi chưa cấu
  hình App (`OAUTH_APP_NOT_CONFIGURED`), wizard đăng nhập 3 cách không còn
  ô mật khẩu (Device Flow có đếm ngược, PAT kiểm tra định dạng ở client);
  Download .zip (repo GitHub kể cả private + archive repo local); quản lý
  repo (tạo/fork/star/xóa/sửa mô tả), issues (tạo/bình luận/đóng-mở), PRs
  (tạo/merge/đóng), releases (liệt kê/tạo/tải asset), sửa/xóa/upload file
  qua API, tìm code trong repo, notifications, trang hồ sơ, git local thêm
  (cherry-pick/revert/reset/tags), trang Cài đặt. Xem `docs/BRIDGE_V2.md`
  (mục v3.0.0).
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
