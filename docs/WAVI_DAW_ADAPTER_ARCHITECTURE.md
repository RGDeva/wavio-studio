# Wavi DAW Adapter Architecture

Goal: make "add a DAW" a bounded, testable task instead of another smear across `main.ts`, `ableton.ts`, and the web pack builder. The adapter is a **desktop-side module contract**; the cloud stays DAW-agnostic (manifests, packs, versions).

## 1. The adapter interface

```ts
// electron/adapters/types.ts
export interface DawAdapter {
  id: 'ableton' | 'fl_studio' | 'pro_tools' | 'logic' | 'reaper' | string;
  displayName: string;

  // Detection
  detectInstallation(): Promise<DawInstallation | null>;          // app present? version?
  isProjectFile(filePath: string): boolean;                       // .als / .flp / .ptx ...
  findProjectRoot(projectFilePath: string): Promise<string>;      // e.g. .als → folder containing "Ableton Project Info/"

  // Classification (pure where possible — unit-testable without I/O)
  classifyEntry(relPath: string): 'required' | 'optional' | 'ignored';
  cacheAndBackupPatterns(): RegExp[];                             // never packed, never synced

  // Analysis
  extractReferencedMedia(projectFilePath: string): Promise<MediaRef[]>;   // samples/audio the project points at
  extractPluginDependencies(projectFilePath: string): Promise<PluginDependency[]>;
  detectPreviewBounce(projectRoot: string): Promise<string | null>;
  extractMetadata(projectFilePath: string): Promise<{ bpm?: number; key?: string; timeSig?: string }>;

  // Publish / restore
  generateManifest(projectRoot: string): Promise<Manifest>;       // relpaths + hashes + roles + required flags
  validate(projectRoot: string, manifest: Manifest): Promise<CompatibilityReport>;
  package(projectRoot: string, manifest: Manifest, out: PackSink): Promise<void>;
  restore(pack: PackSource, destDir: string): Promise<RestoreReport>;  // incl. hash verification, no-Temp-Project guarantees
  launch(projectFilePath: string): Promise<void>;                 // open in the DAW
  versionCompatibility(manifest: Manifest, installation: DawInstallation): CompatibilityReport;

  // Interop (cross-DAW; optional per adapter). Retyped to the Session IR per
  // DR-015 / WAVI_CROSS_DAW_ARCHITECTURE_V2.md — the v1 PortableSession JSON
  // type is superseded. The DAWproject reader/writer is itself an adapter
  // pair producing/consuming SessionIR (WS-023/WS-024).
  exportPortableSession?(projectRoot: string): Promise<SessionIR>;
  importPortableSession?(ir: SessionIR, destDir: string): Promise<string>; // returns generated project file
}
```

Registry: `electron/adapters/index.ts` — `getAdapterForFile(path)`, `getAdapterById(id)`, `allAdapters()`. `discovery.ts`'s `DAW_PROJECT_EXTS` set becomes derived from the registry (single source of truth for "what is a project file").

## 2. What already exists for Ableton (verified) and where it moves

| Contract method | Exists today | Location | Action |
|---|---|---|---|
| `isProjectFile` / detection | ✅ `.als` handling | `discovery.ts`, `ableton.ts` | move behind adapter |
| `findProjectRoot` | ✅ `Ableton Project Info/` marker logic | `ableton.ts` scan + pack code | consolidate |
| `classifyEntry` | ✅ role classification (`getFileRole`), exclusion patterns | split between `ableton.ts` and **wavio's** `project-link/[token].ts` `EXCLUDE_PATTERNS` | desktop adapter becomes the authority; server keeps a defensive copy |
| `extractMetadata` | ✅ gzip-XML `.als` parse → BPM/key (`parseAbletonLiveSet`) | `ableton.ts` | move |
| `generateManifest` + hashes | ✅ publish flow | inline in `main.ts` `project:publishVersion` | extract |
| `package` | ✅ Project Pack w/ relative paths | split desktop/web | desktop packs; web streams |
| `restore` + hash verify + duplicate detection + no-Temp-Project | ✅ | inline in `main.ts` `restore:start` (~line 1453) + `RestoreWindow` | extract to adapter; RestoreWindow stays generic UI |
| `launch` | ✅ `shell.openPath`/`openWithApp` | `main.ts` | thin wrapper |
| `extractPluginDependencies` | ❌ (`.als` XML contains `PluginDevice`/`AuPluginDevice` nodes — parseable with the existing gzip-XML path) | — | new |
| `detectPreviewBounce` | ✅ bounce-candidate logic | `main.ts`/`classifier.ts` | move |
| `validate`/`versionCompatibility` | partial (compat metadata in link flow) | wavio `6afea0a` | formalize |

**Phase "Ableton normalization" = pure refactor**: no behavior change, protected by the existing 349 tests plus new adapter-contract tests (golden-manifest fixtures: tiny real `.als` files in-repo).

## 3. Per-DAW notes (ordering rationale)

1. **Ableton (done → normalize first).** Folder-based projects, open-ish gzip-XML format, existing acceptance-tested flows. The contract is extracted *from* working code, which keeps the interface honest.
2. **FL Studio — next native target.** Single `.flp` binary file (documented enough: community parsers exist; PPQ, patterns, channel/plugin names extractable). Projects are usually one file + samples referenced absolutely or via shared library → `findProjectRoot` is the file's directory; `extractReferencedMedia` matters more than for Ableton (no "collect all and save" convention). Packaging = `.flp` + resolved samples + generated manifest. A `FLStudioStatusPanel` UI shell already exists. Risk: sample path resolution across machines (FL's search-path heuristic must be replicated at restore).
3. **Pro Tools.** `.ptx` sessions with `Audio Files/` folder convention — folder-shaped like Ableton, favorable for packing. Format is closed; do **not** attempt deep parse initially: manifest from filesystem conventions + `Audio Files` + `Session File Backups` exclusion, metadata from user input or bounce analysis. Plugin extraction deferred.
4. **Logic Pro.** `.logicx` package-bundles; macOS-only (fits current desktop). Bundle = folder, packs well. Closed format; same conservative approach as Pro Tools. Alternatives considered: doing Logic before Pro Tools (bigger home-producer overlap with Ableton/FL users) — deferred to Pro Tools first only because pro-collab (send session to mix engineer) is a stated wedge; revisit with user data.
5. **REAPER.** `.rpp` is *plain text and documented* — technically the easiest full parse of the five, including plugin chains and item positions. Ordered last purely on audience size; it is also the best **portable-session import target prototype** because generating a valid `.rpp` is trivial compared to generating `.als`.

## 4. Testing the adapters

- Golden fixtures: minimal real project per DAW committed under `electron/adapters/__fixtures__/` (tiny sample files, hash-pinned).
- Contract test suite runs every adapter against the same assertions: manifest determinism, classify totality (every fixture file gets a class), pack→restore→hash-verify round-trip in a temp dir, cache/backup exclusion.
- Restoration acceptance per DAW mirrors the Ableton acceptance script (open without recovery/Temp behavior) — manual gate per release, automated file-level checks in CI.

## 5. Boundaries

- Adapters never touch `sync_queue`, auth, or IPC directly; they are pure-ish modules called by `main.ts` handlers.
- Adapters never send absolute paths to the cloud (canonical-model invariant 3).
- The web repo consumes manifests/packs only; if server-side needs DAW knowledge (e.g. pack streaming exclusions), it uses a generated JSON of `cacheAndBackupPatterns` exported from the adapter package — not a hand-copied regex list (today's duplication between `ableton.ts` and `project-link/[token].ts` is a drift bug waiting to happen).
