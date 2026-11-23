# PixiJS Engine × GitHub Desktop Sync

Chrome Extension MV3 + local Node.js Git bridge. Built as a working local Git integration starter, not a direct GitHub Desktop API client.

## What is included
- `extension/`: Manifest V3 extension, popup, full-page workspace dashboard.
- `bridge/`: Node.js local HTTP bridge using Git CLI, no npm dependencies.
- Real repository selection, status, stage/unstage, stage all, commit, fetch, fast-forward-only pull, push, branch list/checkout, commit history and text diff.
- Explicit bridge token; server binds only to `127.0.0.1`.

## Requirements
- Google Chrome or Chromium.
- Node.js 18+.
- Git installed and available on PATH.
- A local Git repository. GitHub authentication should be configured through Git Credential Manager or SSH before push/pull.

## 1. Start local bridge
Open a terminal in `bridge/` and run:

```bash
node bridge-server.js
```

The first run generates `bridge/.bridge-token` and prints the token. Keep the terminal open. The bridge listens only on `127.0.0.1:17321`.

## 2. Install extension
1. Extract the ZIP.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `extension/` folder (not the project root).
6. Open the extension and choose **Open Full Workspace**.
7. Paste the token printed by the bridge and click **Connect Bridge**.
8. Enter the full local repository path and click **Connect Repository**.

Chrome does not install an extension directly from a ZIP in Developer mode; load the extracted `extension/` folder.

## GitHub Desktop
GitHub Desktop does not expose a general-purpose public local API for arbitrary UI control. This project uses Git CLI for actual Git operations and includes an `Open GitHub Desktop` protocol-handler attempt. If the protocol handler is not registered on your OS, open GitHub Desktop manually and add/open the same repository. The extension does not claim to read GitHub Desktop's private internal state.

## Supported API operations
`GET /health` (bridge status), `POST /api/repo/select`, `GET /api/git/status`, `POST /api/git/stage`, `POST /api/git/unstage`, `POST /api/git/stage-all`, `POST /api/git/commit`, `POST /api/git/fetch`, `POST /api/git/pull`, `POST /api/git/push`, `GET /api/git/branches`, `POST /api/git/checkout`, `GET /api/git/log`, `GET /api/git/diff?path=...`.

All `/api/*` routes require `Authorization: Bearer <token>`.

## Safety notes / current limits
- Pull is `git pull --ff-only`; it refuses non-fast-forward merges rather than creating surprise merge commits.
- Branch checkout refuses when the working tree is dirty.
- File paths are repository-relative and validated against traversal.
- No reset, force-push, auto-discard, token storage for GitHub, or arbitrary shell command endpoint.
- This starter does not yet implement file explorer editing, embedded code editor, local preview server/live reload, full PixiJS object inspector, merge conflict UI, stash UI, tags, PRs, Actions, or GitHub API panels. Those require separate modules and testing.
- Git operations run with the current OS user's permissions. Use only on repositories you trust.

## Troubleshooting
- **Bridge disconnected:** keep the Node terminal open; check `http://127.0.0.1:17321/health`.
- **Unauthorized:** copy the exact token printed by the bridge into the dashboard.
- **Git not found:** install Git and ensure `git --version` works in the same terminal environment.
- **Push/Pull authentication:** configure Git Credential Manager or SSH outside this extension.
- **Repository rejected:** verify the path contains a `.git` directory and is a valid Git worktree.
