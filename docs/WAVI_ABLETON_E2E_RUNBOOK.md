# Ableton Same-DAW Round-Trip — E2E Runbook (WS-006 step 3)

Turnkey checklist for the **founder-attended** session that unblocks the Ableton
reference milestone. Everything up to this point (adapter WS-006 steps 1–2,
wavi-media, capabilities, assistant safety) is automated and green; this runbook
covers only the parts that require a **real Ableton install + a signed-in Wavi
session**, which an autonomous cycle cannot perform.

Maps to `docs/WAVI_ACCEPTANCE_TEST_INDEX.md §D` and the WS-006 packet.
Run on the adapter branch once it is chosen for release:
`refactor/ableton-adapter` (currently @ `2d182029`, trunk-current).

---

## 0. Prerequisites (one-time)

- macOS with **Ableton Live 11+** installed at `/Applications`.
- **Node 22**: `source ~/.nvm/nvm.sh && nvm use 22` (repo `.nvmrc`).
- A **signed-in Wavi account** (founder) — the publish/link/preview steps hit the
  real API. Export the token the run needs (never commit it; DR-011/DR-012):
  ```bash
  export WAVI_AUTH_TOKEN=…        # founder session token
  ```
- Isolated test SQLite fixture present (tests only): `npm run test:setup-native`.
- A **disposable** Ableton project (do NOT use real client work): a tiny `.als`
  with one audio clip referencing one sample, saved as a **Project**
  (File → Save → "Collect All and Save" so an `Ableton Project Info/` folder
  exists). Put it under a Wavi-watched folder.

Sanity (must be green before starting):
```bash
source ~/.nvm/nvm.sh && nvm use 22
npm run build:electron && npx tsc -p tsconfig.json --noEmit   # both tsc clean
npm test                                                       # full suite, 0 skips
```

---

## 1. Launch two isolated app instances

Use **two OS user profiles or two builds** so sender and recipient don't share
one local DB. Simplest: a QA build for the recipient, dev for the sender.

```bash
# Sender (dev):
npm run dev
# Recipient (QA build, distinct bundle id / scheme wavi-qa://):
npm run build:mac:qa && open "release/mac-arm64/Wavi Studio*.app"
```
The QA build registers `wavi-qa://` (channel isolation, config.ts BUNDLE_ID) so a
deep link routes to the recipient instance, not the dev one.

---

## 2. Creator flow (sender)  →  §D "publish → link"

1. Sender app → **Folders**: confirm the disposable project's folder is watched;
   Dashboard shows it detected as an **Ableton** project (adapter id `ableton`).
2. Open **Project Detail** → confirm:
   - Compatibility card shows **"Open in Ableton Live · Available"** (from
     `daw:getCapabilities`).
   - latest bounce plays via `wavi-media://` (no `file://`, no errors).
3. Wait for **Synced** (or click **Sync This Project**).
4. **Publish Version** → confirm one immutable version is created
   (`project:publishVersion` → `{ versionNumber, fileCount }`).
5. **Project Link** → choose contents (native project + master + stems) and
   permissions (allow open-in-DAW + download) → **Create & Copy**
   (`project:createLink` → `linkUrl`, `trackingId`).

**Pass:** link URL copied; publish returned `created:true` with the expected
`fileCount`; retry of publish returns `skipped:true` (no duplicate version).

---

## 3. Browser preview  →  §D "browser preview → 200"

Open the link URL in a browser (recipient page is Codex-owned; desktop only
consumes it):
- Preview audio plays; project title/BPM/key correct.
- `GET` of the link returns **200**; the download/open-options reflect the
  granted permissions.

**Pass:** 200 + preview plays + correct metadata. (If the page 500s or shows
missing media, STOP — that is a Codex/web handoff item, not desktop.)

---

## 4. Recipient open + restore  →  §D "restore to fresh dir → SHA-256 match → opens in Ableton → no Temp Project"

1. On the link page click **Open in Ableton** → it invokes the deep link
   `wavi://open-project/<token>` (dev) / `wavi-qa://open-project/<token>` (QA).
   The recipient app receives `project:open-link`.
2. Recipient app resolves permission (`restore:resolve`), picks a **fresh empty
   destination** (`restore:pickDestination`), and runs `restore:start`.
   Watch `restore:progress`: `verify_progress` → `verify_complete` →
   `restore_complete`.
3. **Hash verification (evidence):** for every restored file, compare against the
   manifest. The app already fails the restore on mismatch, but capture the table:
   ```bash
   cd "<restore destination>"
   find . -type f -not -path '*/Ableton Project Info/*' -print0 \
     | xargs -0 shasum -a 256 | sort
   ```
   Paste this table into the handoff; it must match the sender's originals:
   ```bash
   # sender side, same command in the source project dir
   ```
4. Confirm the restored folder contains the **`Ableton Project Info/`** directory
   (adapter `manifestExtras` guarantees it is packed even when empty).
5. Ableton opens the restored `.als` automatically (or via **Open in DAW**).

**Pass (all required):**
- SHA-256 table identical (sender vs restored), excluding volatile paths.
- Ableton opens the project and does **NOT** show the **"Temp Project"** banner.
- **No missing-media** warnings (the `Ableton Project Info/` marker + relative
  sample paths resolve).

If Ableton shows "Temp Project" or missing media → STOP and report: likely the
`Ableton Project Info/` folder or a relative sample path was not packed
(adapter `manifestExtras` / `safeRelativePath` regression). Do not change
manifest content/order without founder sign-off (DR-013).

---

## 5. Duplicate-restore + revoke  →  §D "duplicate-restore dialog → revoke kills resolve"

1. Trigger **Open in Ableton** again for the same link → the app must show the
   **duplicate-restore dialog** (`restore:checkExisting` → `restore:openExisting`
   path), not silently create a second copy.
2. Back on the sender, **revoke** the link (`project:revokeLink` /
   `links:revoke`). Then attempt `restore:resolve` again on the recipient → it
   must **fail to resolve** (link dead).

**Pass:** duplicate dialog appears; post-revoke resolve fails cleanly.

---

## 6. Contribution return (milestone item)  →  child version

1. In Ableton (recipient), make a trivial edit and save.
2. Publish a **child version** from the recipient's restored project.
3. On the sender, confirm the child version appears **linked to the original
   project**, records the **parent version**, and the **original version is
   unchanged** (immutable). No unrelated project is created.

**Pass:** child version present, parent recorded, original intact.

---

## 7. Evidence to capture in the handoff

- [ ] Publish result JSON (`versionNumber`, `fileCount`, second publish `skipped`)
- [ ] Link URL + browser **200** + preview screenshot
- [ ] **SHA-256 table** (sender vs restored) — identical
- [ ] Screenshot: Ableton open, **no "Temp Project"**, no missing media
- [ ] Screenshot: duplicate-restore dialog
- [ ] Post-revoke resolve failure
- [ ] Child-version linkage (parent recorded, original immutable)
- [ ] `git rev-parse --short HEAD` of the branch under test

On all-green, WS-006 step 3 is satisfied and the Ableton reference milestone's
live items can be marked complete. Then the terminal message
`ABLETON REFERENCE MILESTONE COMPLETE — FL IMPLEMENTATION PLAN READY` may be
emitted (once FL packets, already framed in `WAVI_FL_STUDIO_API_MCP_AUDIT.md`,
are confirmed ready).

---

## Troubleshooting quick map

| Symptom | Likely cause | Owner |
|---|---|---|
| Link page 500 / missing media in browser | recipient-page / storage | Codex (web) |
| "Temp Project" in Ableton | `Ableton Project Info/` not packed | desktop adapter |
| Missing sample after restore | relative path / `safeRelativePath` | desktop adapter |
| Hash mismatch | upload/download corruption or exclusion drift | desktop |
| Deep link opens wrong instance | scheme/channel (`wavi://` vs `wavi-qa://`) | desktop config |
| Restore writes outside chosen dir | path containment (restore.security) | desktop (P0 — stop) |
