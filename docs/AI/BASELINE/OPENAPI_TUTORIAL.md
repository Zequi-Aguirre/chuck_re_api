# AskZack Local API — Actions Guide (v0.2.1)

Each endpoint is accessible at `https://askzack-local.ngrok.app/api/...`
and requires the header:

## 🧠 Context Vertical
GET /api/context/load — Loads the full assistant context.
PUT /api/context/active — Updates runtime context `{ "content": "..." }`

## 🧩 Workspaces Vertical
GET /api/workspaces — List all workspaces.
POST /api/workspaces/active — Set active workspace `{ "workspaceId": "..." }`
POST /api/workspaces/attach — Attach local repo `{ "repoPath": "..." }`

## 🗂️ Projects Vertical
GET /api/projects — List projects.
GET /api/projects/active — Get active project.
POST /api/projects/active — Set active project `{ "projectSlug": "slug", "repoPath": "..." }`

## 🪶 Repo Vertical
GET /api/repo/tree — List repo files.
GET /api/repo/read — Read file `?path=...`
POST /api/repo/search — Search repo `{ "query": "..." }`
POST /api/repo/apply-patch — Apply unified diff patch `{ "patch": "..." }`

## 🧭 Git Vertical
GET /api/git/status — Returns current branch and file state.
GET /api/git/diff — Returns diff for working tree.
POST /api/git/add — Stages file(s) for commit `{ "filepath": "..." }`
POST /api/git/commit — Commits staged changes `{ "message": "..." }`
POST /api/git/push — Pushes branch to remote `{ "remote": "origin", "branch": "..." }`

### Notes
- Author info is no longer required for commits. Local Git config is used.
- Diff and patch operations require unified diff headers.

## 🧠 Dynamic Context Usage
AskZack loads this file dynamically to:
- Verify which endpoints exist.
- Guide GPT Action calls.
- Regenerate or update OpenAPI schema if missing endpoints are detected.

## 🔄 Maintenance Protocol
1. Update `OPENAPI_SPEC.json` and this tutorial when backend routes change.
2. Commit and push changes.
3. Reload context via `/api/context/load`.

`x-api-key: <your_local_key>`
