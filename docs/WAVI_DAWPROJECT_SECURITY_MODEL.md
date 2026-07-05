# DAWproject Import Security Model

**Every imported `.dawproject` file is untrusted.** It is a ZIP of XML plus
arbitrary attacker-chosen entries, arriving over Links from people the user
may not know. This model is normative for the WS-023 reader. Principle: a
malicious file may cause a *clean rejection with a typed error*, never code
execution, resource exhaustion, or a write outside a disposable root.

## 1. ZIP layer (yauzl streaming; never `extract-zip`)

| Threat | Control | Default |
|---|---|---|
| ZIP bomb (total) | cap total decompressed bytes; abort stream when exceeded | 500 MB |
| ZIP bomb (single entry) | cap per-entry decompressed bytes | 200 MB |
| Entry-count explosion | cap number of entries | 10 000 |
| Compression-ratio bomb | reject entries whose ratio exceeds a threshold | 200:1 |
| Path traversal (`../`) | reject any entry whose normalized path escapes root | reject file |
| Absolute paths | reject entries with leading `/` or drive letters | reject file |
| Symlink entries | reject entries with symlink mode bits | reject file |
| Nested-archive recursion | do not auto-extract inner archives; treat as opaque media | — |

Extraction target: a **disposable root** under the app temp dir
(`<tmp>/wavi-dawproject-<uuid>/`), created 0700. Nothing is written
anywhere else during import. On success, validated media is moved atomically
into the version pack; the disposable root is then removed. A **startup
sweep** deletes any orphaned `wavi-dawproject-*` roots left by a prior crash.

## 2. XML layer (fast-xml-parser; entities hard-disabled)

| Threat | Control |
|---|---|
| XXE (external entity) | parser configured with entity processing OFF; **pre-scan raw bytes for `<!DOCTYPE` / `<!ENTITY` and reject before parsing** |
| Billion-laughs / entity expansion | no DTD, no entity expansion — structurally impossible once DOCTYPE is rejected |
| Malformed XML | typed parse error → reject file, no partial import |
| Deep-nesting stack blowup | element depth cap | 64 |
| Node-count explosion | total element cap | 1 000 000 |
| Oversized `project.xml` | cap uncompressed project.xml size | 32 MB |
| Billion attributes | per-node attribute cap | 4 096 |

`project.xml` and `metadata.xml` are the ONLY XML entries parsed. All other
entries are opaque bytes (media, plugin state) — never parsed as XML.

## 3. Reference / identity integrity

- Duplicate `xs:ID` (`id="…"`) values → reject (the format guarantees
  uniqueness; duplicates are an attack or a broken exporter).
- `IDREF` (`track`, `destination`, `parameter`, `reference`) that resolves
  to nothing → **fidelity downgrade, not a crash**: the referencing entity
  is kept, its link dropped, and a `warnings[]` + fidelity `approximated`
  entry recorded. A dangling reference must never throw.
- Reference cycles (clip `reference` chains, channel `destination` loops) →
  detected with a visited-set; cycle broken + warned, never infinite-looped.

## 4. Embedded blobs (plugin state, media)

- Plugin `<State path>` blobs are **size-capped (64 MB)** and treated as
  opaque bytes. They are **never loaded, deserialized, or executed** by Wavi
  — they are only copied into the pack for the *target DAW* to load at the
  user's own risk (same trust boundary as opening any project). Wavi records
  their sha256 and size, nothing more.
- Media files: **MIME sniff (magic bytes) vs. file extension**; on mismatch
  → quarantine (kept out of the pack) + warning. An entry claiming `.wav`
  whose bytes are not RIFF/audio is never presented as playable audio.
- Every embedded file's sha256 is computed and, when the `wavi/session.json`
  manifest is present, **verified against it**; mismatch → reject file
  (tampered artifact).

## 5. Filename hygiene

- Normalize to Unicode NFC; strip control characters and RTL-override
  codepoints; reject reserved device names (`CON`, `NUL`, …) on Windows
  targets; collapse `.`/whitespace-only names. The on-disk name Wavi writes
  is always a sanitized derivation, never the raw ZIP entry name.

## 6. Failure & cleanup contract

- Every import path — success, validation reject, parse error, cap exceeded,
  process crash — leaves **zero** bytes outside the disposable root, and the
  disposable root is removed (immediately on the normal paths; by the
  startup sweep after a crash).
- All rejections are typed (`DawProjectImportError` with a `code`) so the
  restore error taxonomy (WS-020) can render human copy per failure class.
- The reader returns `{ ir, warnings, fidelity }`; a file that parses but
  triggers downgrades imports successfully **with** an honest fidelity
  report — degradation is visible, never silent.

## 7. Out of scope (declared)

Sandboxing the *target DAW's* loading of plugin state is not Wavi's job —
that is the DAW's trust boundary, identical to the user double-clicking any
project. Wavi's guarantee ends at: it never executes the blob, it tells the
user what plugins/state the file carries (compat report), and it never lets
the import escape the disposable root or exhaust the machine.
