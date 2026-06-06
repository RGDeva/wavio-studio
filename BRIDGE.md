# Wavi Studio Local Bridge

A lightweight HTTP server running inside the Wavi Studio Electron app.  
It exposes project context and tool execution to the Wavi Agent (macOS companion app) via authenticated local HTTP.

---

## Quick Start

```bash
# Start Wavi Studio (bridge auto-starts)
cd /Users/rishig/CascadeProjects/wavio-studio
npm run build      # compile electron TS → dist-electron/
npm run dev        # Vite renderer + Electron

# Verify bridge is running
curl http://127.0.0.1:47821/health
# → {"status":"ok","service":"wavi-studio-bridge","version":"1.0.0","port":47821}

# Read the token
TOKEN=$(cat ~/.wavi/bridge-token)

# Test an authenticated endpoint
curl -H "X-Wavi-Token: $TOKEN" http://127.0.0.1:47821/active-project
```

---

## Security

| Property | Value |
|---|---|
| Bind address | `127.0.0.1` only — never `0.0.0.0` |
| Port | `47821` |
| Auth | `X-Wavi-Token` header — must match `~/.wavi/bridge-token` |
| Token format | Random UUID (v4) |
| Token location | `~/.wavi/bridge-token` |
| Token permissions | `chmod 600` (owner read/write only) |
| Token lifetime | Persisted across restarts; regenerated if missing or malformed |

Only `/health` is unauthenticated (used for polling liveness).  
All other endpoints return `401` without a valid token.

---

## Endpoint Contract

### `GET /health` — no auth
```json
{ "status": "ok", "service": "wavi-studio-bridge", "version": "1.0.0", "port": 47821 }
```

### `GET /active-project`
```json
{
  "project": {
    "id": "uuid",
    "name": "My Beat",
    "dawType": "fl-studio",
    "filePath": "/Users/…/MyBeat.flp",
    "lastModified": "2026-05-31T…",
    "versionCount": 3,
    "cloudId": null
  }
}
```
Returns `{ "project": null }` if no project is open.

### `GET /project-context`
Full project context including all tracked files with BPM, key, role, sync status.

### `GET /project-files`
Array of all files in the active project with metadata.

### `GET /project-versions`
Array of saved versions for the active project.

### `GET /latest-bounce`
Most recent bounce/master/export file. Returns `{ "bounce": null }` if none found.

### `GET /search-files?q=<query>`
Searches across all tracked files. Returns up to 20 results. Empty `q` returns `[]`.

### `POST /open-file`
```json
{ "filePath": "/absolute/path/to/file.wav" }
```
Opens the file with the default system app. File must exist.

### `POST /open-folder`
```json
{ "folderPath": "/absolute/path/to/folder" }
```

### `POST /reveal-file`
```json
{ "filePath": "/absolute/path/to/file.wav" }
```
Reveals the file in Finder. File must exist.

### `POST /generate-midi`
```json
{
  "type": "melody" | "drums" | "chords",
  "key": "C",
  "scale": "minor",
  "tempo": 140,
  "bars": 4
}
```
Generates a MIDI file into the active project folder via the MIDI tool registry.  
Returns `{ "status": "done", "filePath": "…", "fileName": "…" }`.

### `POST /analyze-latest-bounce`
```json
{ "filePath": "/optional/override/path.wav" }
```
Runs audio analysis (BPM, key, duration) on the latest bounce or provided file.

### `POST /log-action`
```json
{
  "action": "some_action_name",
  "message": "Human-readable description",
  "projectId": "optional-uuid",
  "metadata": {}
}
```
Writes an entry to the Wavi Studio activity log. `action` is required.

### `POST /chat`
```json
{
  "messages": [
    { "role": "user", "content": "What's my latest bounce?" }
  ]
}
```
Sends chat messages through the Wavi Copilot LLM (project context auto-injected).  
Returns `{ "reply": "...", "context": { "projectName": "...", "dawType": "..." } }`.  
Used by Wavi Agent's native copilot chat panel for text-based project Q&A.

### `POST /open-copilot-panel`
Toggles the Wavi Studio Copilot overlay window.

---

## Token Management

```typescript
// electron/bridgeServer.ts
const TOKEN_PATH = '~/.wavi/bridge-token';

// At startup:
// 1. Creates ~/.wavi/ directory if missing
// 2. If bridge-token exists and is a valid UUID, reuses it
// 3. Otherwise generates a new UUID and writes it chmod 600
// 4. Falls back to in-memory token if file write fails (companion won't work but Studio won't crash)
```

---

## Running the Validation Suite

```bash
# Full bridge endpoint test (40 assertions)
cd /Users/rishig/CascadeProjects/wavio-studio
node scripts/validate-bridge.cjs
```

---

## Error Codes

| Status | Meaning |
|---|---|
| `200` | Success |
| `400` | Missing required field (e.g. `action`, `filePath`) |
| `401` | Missing or invalid `X-Wavi-Token` |
| `404` | File not found, or unknown route |
| `500` | Internal error (logged to Electron console) |

---

## Bridge Status UI

Available in Wavi Studio → **Settings** → **Local Bridge** section.  
Shows: online/offline state, endpoint, token existence + permissions, last companion activity.

---

## Known Limitations (Phase 1)

- No WebSocket — polling only from Swift side
- No rate limiting (local only, single user)
- `getActiveProject()` returns most recently synced project — no user selection
- File ops require absolute paths; no path traversal protection beyond Electron's `shell` API
- `generate-midi` requires an active project with a `file_path` set to place output

---

## Files

```
electron/bridgeServer.ts     — server implementation
electron/main.ts             — startBridgeServer() / stopBridgeServer() lifecycle
scripts/validate-bridge.cjs  — end-to-end test harness
~/.wavi/bridge-token         — runtime auth token (not in repo)
```
