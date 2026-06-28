# Wavi Studio — Test Matrix

**Date:** 2026-06-27

Legend: ✅ Exists | 🔶 Partial | ❌ Missing

---

## Unit Tests

| Test | File | Status |
|------|------|--------|
| File role classification | `electron/projectAssociation/classifier.test.ts` | ✅ |
| Project association engine | `electron/projectAssociation/engine.test.ts` | ✅ |
| `fileChecksum` returns 64-char hex | to be added in `electron/watcher.test.ts` | ❌ |
| DAW extension detection | `electron/watcher.test.ts` | ❌ |
| File stabilization state machine | `electron/watcher.test.ts` | ❌ |
| Duplicate scan prevention (same checksum) | `electron/watcher.test.ts` | ❌ |
| Queue transitions (pending→uploading→synced) | `electron/syncAgent.test.ts` | ❌ |
| Retry eligibility after `next_retry_at` | `electron/syncAgent.test.ts` | ❌ |
| Restart recovery (retrying rows have time gate) | `electron/syncAgent.test.ts` | ❌ |
| API schema validation (daw-sync request) | `electron/syncAgent.test.ts` | ❌ |
| Path safety (no `../` traversal) | `electron/bridgeServer.test.ts` | ❌ |
| Role classifier — master/stem/MIDI/artwork/ref | `classifier.test.ts` | ✅ (partial) |
| BPM detection returns number or null | `electron/bpmDetector.test.ts` | ❌ |

---

## Integration Tests

| Test | Status |
|------|--------|
| SQLite schema migrations are idempotent on re-open | ❌ |
| Watched folder restored after app restart | ❌ |
| Stable-file detection (file written in chunks) | ❌ |
| `wv_` token validation at `/api/desktop/index` | ❌ |
| presign → PUT → register-asset full roundtrip | ❌ |
| Deduplication: same file uploaded twice, second is a no-op | ❌ |
| Project create → cloud `projectId` returned and stored locally | ❌ |
| Asset registration → appears in Supabase `assets` table | ❌ |
| 401 response → `pausedReason = 'auth'`, queue paused | ❌ |
| 402 response → `pausedReason = 'limit'`, queue paused | ❌ |
| Failed job retry → attempt count increments, backoff applied | ❌ |
| Bridge server `/health` returns 200 with valid token | ❌ |
| Bridge server rejects request with invalid token | ❌ |

---

## Manual Verification Checklist (Pre-Shipping)

### Authentication

- [ ] Launch app cold, click Sign In, complete Privy browser login
- [ ] Deep link redirects back to Studio with `wavi://auth?token=wv_...`
- [ ] Quit and relaunch — sync agent picks up stored token without re-login
- [ ] Revoke token via web app settings — Studio shows "Sign in again" within one poll cycle

### Watched Folders

- [ ] Add a folder containing `.flp`, `.als`, `.ptx` files
- [ ] Projects appear in Dashboard within 30 seconds
- [ ] Quit and relaunch — watched folder is still listed and monitored
- [ ] Remove folder — projects from that folder no longer monitored

### File Detection

- [ ] FL Studio `.flp` detected as FL Studio project
- [ ] Ableton `.als` detected as Ableton project
- [ ] Pro Tools `.ptx` / `.ptf` detected
- [ ] Logic `.logicx` (bundle) detected
- [ ] REAPER `.rpp` detected
- [ ] `.wav`, `.aiff`, `.mp3` classified by role (master/stem/rough/unknown)
- [ ] `.mid` / `.midi` classified as MIDI
- [ ] `.jpg`, `.png` classified as artwork
- [ ] `.zip`, `.tar` classified as archive

### Upload Flow

- [ ] New WAV file copied to watched folder → detected after stabilization
- [ ] Bounce candidate appears in UI with correct role
- [ ] Confirming bounce → file enters sync queue
- [ ] Upload progresses (progress % updates in queue view)
- [ ] After upload: `sync_status = 'synced'` in local DB
- [ ] Asset appears in Supabase `assets` table with correct `project_id`
- [ ] Same file uploaded again → deduplication, no duplicate asset

### Sync Engine Reliability

- [ ] Kill app during upload → relaunch → upload resumes or restarts correctly
- [ ] Disconnect network during upload → item enters retry state
- [ ] Reconnect → retry fires after backoff delay (not immediately)
- [ ] Max retries reached → status = 'failed', visible in UI

### Share Links

- [ ] Create Link button visible on synced project
- [ ] Link created → URL shown in clipboard modal
- [ ] Open link in browser → audio plays
- [ ] Disable download → download button absent on public page

### Privacy

- [ ] Inspect network requests: no local absolute paths in request bodies
- [ ] `storageKey` not exposed in public share page HTML or API response
- [ ] Log files do not contain full local paths

### Edge Cases

- [ ] Two DAW project files in same folder → each gets its own project record
- [ ] Rename DAW project file → Studio updates existing project (does not create duplicate)
- [ ] Delete watched folder from filesystem → Studio shows folder as missing, does not crash
- [ ] 1 KB test file → uploads correctly
- [ ] 100 MB test file → uploads without memory spike
- [ ] Empty folder → no error, watcher idle

---

## End-to-End Test Script (Target)

```
1. Fresh install (new userData directory)
2. Sign in via browser
3. Add ~/Music/TestProject/ containing:
   - TestBeat.flp (or .als)
   - TestBeat_Master.wav (full mix)
   - TestBeat_Drums.wav (stem)
   - TestBeat_Vocals.wav (stem)
4. Wait for discovery (< 30s)
5. Confirm bounce candidates
6. Observe upload queue → all synced
7. Open wavi.stream — project and assets visible
8. Click Create Link → copy URL
9. Open URL in incognito browser → audio plays
10. Quit Studio, relaunch — project still shows as synced
11. Modify TestBeat.flp — new version created locally
12. New version uploaded — no duplicate assets for unchanged stems
```
