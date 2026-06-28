# Wavi — Cross-Repo API Contracts

**Date:** 2026-06-27

This document is the single source of truth for every request/response boundary between Wavi Studio (desktop) and the Wavi web application (API). "Current" reflects what the code actually does today. "Required" reflects what it must do.

---

## Auth: Deep-Link Token Exchange

### Current Flow

```
Browser Auth.tsx
  → Privy login
  → getAccessToken() → Privy JWT (~15 min)
  → window.location.href = `wavi://auth?token=${privyJwt}`

Electron main.ts
  → receives deep link
  → stores Privy JWT encrypted via safeStorage
  → syncAgent.setAuthToken(privyJwt)
```

### Problem

Privy JWTs expire in ~15 minutes. After expiration all syncs fail with 401 and the user must re-authenticate. The `create-desktop-token` action is implemented server-side but never used.

### Required Flow

```
Browser Auth.tsx
  → Privy login
  → getAccessToken() → Privy JWT (used once for exchange only)
  → POST /api/desktop/index
      Header: Authorization: Bearer <privyJwt>
      Header: X-Desktop-Action: create-desktop-token
  → Response: { token: "wv_...", expiresAt: "..." }
  → window.location.href = `wavi://auth?token=${wv_token}`

Electron main.ts
  → stores wv_ token encrypted
  → uses wv_ token for all API calls
```

### API: create-desktop-token

**Endpoint:** `POST /api/desktop/index`  
**Header:** `X-Desktop-Action: create-desktop-token`  
**Auth:** Privy JWT (`Bearer <jwt>`)

**Request:** (no body required)

**Response 200:**
```json
{
  "token": "wv_<random64chars>",
  "expiresAt": "2026-07-27T00:00:00Z"
}
```

**Status:** EXISTS in `api/desktop/index.ts` — `handleCreateDesktopToken` function present. **Never called from web app.**

---

## Desktop Sync: daw-sync

**Endpoint:** `POST /api/desktop/index`  
**Header:** `X-Desktop-Action: daw-sync`  
**Auth:** `Bearer wv_<token>` or Privy JWT (fallback)

### Current Request

```json
{
  "projectName": "My Beat",
  "sessionPath": "/Users/rishig/Music/MyBeat.flp",
  "daw": "FL Studio",
  "fileSize": 204800,
  "lastModified": "2026-06-27T10:00:00Z",
  "sha256": "a3f4b2c1"
}
```

**Problems:**
- `sessionPath` is a local absolute path — private data sent to server and stored in logs.
- `sha256` is 16 hex chars (truncated) — should be 64 chars.
- No `localProjectId` — project matched by name only, breaks on rename.

### Required Request

```json
{
  "projectName": "My Beat",
  "fileName": "MyBeat.flp",
  "daw": "FL Studio",
  "fileSize": 204800,
  "lastModified": "2026-06-27T10:00:00Z",
  "sha256": "a3f4b2c1d9e8f7...(64 hex chars)",
  "localProjectId": "uuid-v4-stable-local-id"
}
```

### Current Response 200

```json
{
  "success": true,
  "projectId": "cloud-uuid",
  "message": "Project created"
}
```

**Status:** WORKS but has the bugs above. Response shape matches what syncAgent expects.

---

## Storage: presign

**Endpoint:** `POST /api/storage/presign`  
**Auth:** `Bearer wv_<token>` (desktop) or Privy JWT

### Current Request (from syncAgent)

```json
{
  "fileName": "MyBeat.flp",
  "fileSize": 204800,
  "sha256": "a3f4b2c1",
  "projectId": "cloud-uuid"
}
```

### Current Response 200 (no dedup)

```json
{
  "uploadUrl": "https://supabase.co/storage/v1/object/sign/audio-files/...",
  "storageKey": "<userId>/content/a3/f4/a3f4b2c1.flp",
  "token": "supabase-upload-token",
  "expiresAt": "2026-06-27T11:00:00Z",
  "deduplicated": false
}
```

### Current Response 200 (dedup hit)

```json
{
  "deduplicated": true,
  "storageKey": "<userId>/content/a3/f4/a3f4b2c1.flp",
  "fileUrl": "https://supabase.co/storage/v1/object/public/...",
  "message": "File already exists — deduplication applied"
}
```

**Problem:** `storageKey` embeds the truncated SHA-256 hash from the desktop side, making the content-address path malformed. When hash is full 64 chars this will work correctly.

**Status:** API WORKS. Broken by client-side hash truncation.

---

## Storage: Upload (presigned PUT)

After receiving `uploadUrl`, Studio does:

```
PUT <uploadUrl>
Content-Type: application/octet-stream
Content-Length: <fileSize>
Body: fs.createReadStream(filePath)
```

Supabase accepts signed PUT uploads. This flow is correct — no `readFileSync`, streaming works.

**Status:** VERIFIED WORKING (assuming correct signedUrl format).

---

## Desktop Sync: register-asset

**Endpoint:** `POST /api/desktop/index`  
**Header:** `X-Desktop-Action: register-asset`  
**Auth:** `Bearer wv_<token>`

### Current Request

```json
{
  "fileName": "MyBounce.wav",
  "storageKey": "<userId>/content/.../sha256.wav",
  "fileSize": 8388608,
  "sha256": "a3f4b2c1",
  "projectId": "cloud-uuid",
  "bpm": 140,
  "keyNote": "F#m",
  "duration": 193.4,
  "role": "master",
  "daw": "FL Studio",
  "projectName": "My Beat"
}
```

### Current Response 200

```json
{
  "success": true,
  "assetId": "cloud-asset-uuid",
  "fileUrl": "https://...signed-url...",
  "message": "Asset created"
}
```

**Status:** WORKS. Deduplication by `storage_path` works correctly.

---

## Missing Contracts (not yet implemented)

### create-share-link

**Needed for:** Phase 5 share link flow from desktop.

```
POST /api/desktop/index
X-Desktop-Action: create-share-link

Request:
{
  "projectId": "cloud-uuid",
  "assetIds": ["uuid1", "uuid2"],
  "permissions": {
    "listen": true,
    "downloadMaster": false,
    "downloadStems": false,
    "comment": true
  },
  "visibility": "unlisted",
  "password": null,
  "expiresAt": null
}

Response:
{
  "shareUrl": "https://wavi.stream/s/abc123",
  "trackingId": "abc123"
}
```

### get-project-state

**Needed for:** Desktop reconciliation after restart.

```
GET /api/desktop/index?action=project-state&localProjectId=uuid

Response:
{
  "projectId": "cloud-uuid",
  "versions": [...],
  "assets": [...]
}
```

### project-version (cloud versions)

Currently the web app has no `project_versions` table distinct from `assets`. Local `versions` table exists in Studio. A cloud version model needs to be designed.

---

## Table: Required DB Columns (wavio Supabase)

| Table | Column | Type | Purpose |
|-------|--------|------|---------|
| `projects` | `desktop_id` | TEXT UNIQUE | Stable local project ID for identity across renames |
| `projects` | `daw_type` | TEXT | Source DAW label |
| `projects` | `file_name` | TEXT | Basename only (no path) |

These do not exist today. Adding them requires a migration.
