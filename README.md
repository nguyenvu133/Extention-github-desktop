# PixiJS Engine × GitHub Desktop Sync

A Chrome extension (Manifest V3) plus a local Node.js bridge that runs **real Git commands** on a repository on your own machine. It is a working local Git client in the browser — not a client for GitHub Desktop's private internals.

**Version 1.0.1**

---

## What is included

| Path | Contents |
|---|---|
| `extension/` | Manifest V3 extension: popup + full-page workspace dashboard |
| `bridge/` | Dependency-free Node.js HTTP bridge that shells out to `git` |
| `tests/` | Functional test harness (runs the real extension code against the real bridge) |

Supported operations: repository selection, status, stage / unstage / stage-all, commit, fetch, fast-forward-only pull, push (with automatic `-u` on a new branch), branch list and checkout, commit history, and text diff (including untracked files).

---

## Requirements

- Google Chrome or Chromium (Manifest V3 support)
- Node.js 18 or newer
- Git installed and on `PATH`
- A local Git repository
- For push/pull: Git credentials configured outside this extension (Git Credential Manager, SSH key, or a PAT in the remote URL)

---

## 1. Start the local bridge

```bash
cd bridge
node bridge-server.js
```

The first run creates `bridge/.bridge-token` (mode `0600`) and prints the token:

```
PixiJS Git Bridge v1.0.1
Listening:  http://127.0.0.1:17321
TOKEN:      8b6454027bbe8876cc54f194a72891b4fc6ab37a70c3f3f8
```

Keep that terminal open. The bridge binds to `127.0.0.1` only.

Convenience launchers: `start-mac-linux.sh` and `start-windows.bat`.

To use a different port: `BRIDGE_PORT=17322 node bridge-server.js` (then change the Bridge URL in the extension).

---

## 2. Install the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the **`extension/`** folder — not the project root
5. Click the extension icon, paste the token, click **SAVE TOKEN**
6. Click **OPEN FULL WORKSPACE**
7. Enter the full path to your local repository and click **CONNECT REPOSITORY**

Chrome cannot install an extension directly from a ZIP in Developer mode — extract it and load the `extension/` folder.

---

## 3. Using it

- **CHANGES / STAGING** — every changed file with its status code. `Diff` shows the patch, `Stage` / `Unstage` toggles it.
- **COMMIT** — summary (required) plus optional description.
- **Fetch / Pull / Push** — in the header. Pull is `--ff-only`; push adds `-u origin <branch>` automatically the first time.
- **Branch** — pick from the dropdown and click **CHECKOUT BRANCH**. Checkout is refused while tracked files have uncommitted changes.
- **COMMIT HISTORY** — the 30 most recent commits.

---

## API reference

All `/api/*` routes require `Authorization: Bearer <token>`. `GET /health` is public so the popup can show a status lamp.

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Bridge status, version, connected repository |
| POST | `/api/repo/select` | Connect a repository by absolute path |
| GET | `/api/repo/current` | Current repository summary |
| GET | `/api/git/status` | Branch + changed files |
| POST | `/api/git/stage` | Stage one path |
| POST | `/api/git/unstage` | Unstage one path |
| POST | `/api/git/stage-all` | Stage everything |
| POST | `/api/git/commit` | Commit staged files |
| POST | `/api/git/fetch` | `git fetch --all --prune` |
| POST | `/api/git/pull` | `git pull --ff-only` |
| POST | `/api/git/push` | `git push` (adds `-u` when needed) |
| GET | `/api/git/branches` | Local branches |
| POST | `/api/git/checkout` | Switch branch |
| GET | `/api/git/log` | Last 30 commits |
| GET | `/api/git/diff?path=…` | Text diff for one path |

---

## Safety model

- Binds to `127.0.0.1` only; never exposed to the network.
- Every `/api/*` call needs the bearer token, compared with `crypto.timingSafeEqual`.
- Git is spawned with `shell: false` — no shell injection surface.
- Paths must be repository-relative; absolute paths and `..` are rejected.
- Pull is `--ff-only`, so it never creates a surprise merge commit.
- Checkout refuses when tracked files are dirty.
- No `reset`, no force-push, no arbitrary shell endpoint.
- `GIT_TERMINAL_PROMPT=0` plus a 120 s timeout, so a missing credential fails fast instead of hanging the bridge.
- CORS echoes only `chrome-extension://` / `moz-extension://` origins.

---

## Tests

With the bridge running:

```bash
node tests/extension-test.js
```

The harness loads `extension/dashboard.js` and `extension/popup.js` unmodified into a minimal DOM + `chrome.*` shim and drives them against the live bridge: connect, status, diff, stage, commit, history, branches, and the bad-token error path.

---

## Known limits

- **GitHub Desktop is not controlled.** The extension runs Git itself. To open the same repository in GitHub Desktop, use **File → Add local repository** with the path shown in the dashboard (there is a **COPY REPOSITORY PATH** button for this).
- No file explorer, embedded code editor, merge-conflict UI, stash UI, tags, PRs, Actions, or GitHub API panel.
- No GitHub token storage — configure Git credentials yourself.
- The bridge runs with your OS user's permissions. Only point it at repositories you trust.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| **BRIDGE DISCONNECTED** | Keep the Node terminal open; check `http://127.0.0.1:17321/health` |
| **Token rejected** | Copy the exact token printed by the bridge (or from `bridge/.bridge-token`) |
| **Port already in use** | Another bridge is running — close it, or set `BRIDGE_PORT` |
| **Git not found** | Install Git and confirm `git --version` works in the same terminal |
| **Push/Pull authentication failed** | Configure Git Credential Manager or SSH outside the extension |
| **Not a Git repository** | The path must contain a `.git` directory |
| **Git author identity is not configured** | `git config --global user.name "…"` and `git config --global user.email "…"` |

---

## License

MIT
