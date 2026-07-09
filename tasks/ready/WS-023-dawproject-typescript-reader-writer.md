# WS-023 — DAWproject TypeScript reader/writer

- **ID:** WS-023 · **Priority:** cross-DAW foundation (post-freeze)
- **Product outcome:** Wavi can read and write standards-compatible
  `.dawproject` files natively, hardened against untrusted input.
- **Technical objective:** hand-written TS DAWproject 1.0 reader + writer +
  security-hardened importer, producing/consuming the Session IR.
- **Dependencies:** WAVI_SESSION_IR_SPEC.md, WAVI_DAWPROJECT_SECURITY_MODEL.md.
  Blocks WS-025/WS-026. **Repo:** wavio-studio. **Base:** `spike/dawproject-adoption` tip.
- **Feature branch:** `feat/dawproject-reader-writer`. **Worktree:** `~/wavi-worktrees/dawproject-reader-writer`.
- **Files:** new `electron/adapters/dawproject/` (`types.ts`, `reader.ts`,
  `writer.ts`, `security.ts`, `index.ts`, `__fixtures__/`, `*.test.ts`);
  `electron/adapters/sessionIR/` types come from WS-024 — if WS-024 not yet
  merged, define the IR types here and WS-024 re-homes them.

## Exact requirements
1. Hand-write TS types for the full Project.xsd + MetaData.xsd 1.0 surface
   (commit `ee4dcdde…`). No code generation; no Java runtime.
2. Reader: `.dawproject` ZIP → `{ ir, warnings, fidelity }`. Implements
   every control in the security model (ZIP caps, DOCTYPE reject, depth/node
   caps, IDREF-dangling→downgrade, sha256 verify, disposable-root extraction,
   startup sweep). XML via `fast-xml-parser` with entity processing OFF; ZIP
   via `yauzl`. Unknown elements/attrs preserved in `foreign`.
3. Writer: Session IR → valid `.dawproject` (project.xml + metadata.xml +
   media + plugin state + `wavi/` sidecar) via `yazl`. Deterministic id
   assignment so equal IR ⇒ byte-identical XML.
4. Round-trip: the README §Example `project.xml` (commit-pinned fixture) must
   parse → IR → re-emit → re-parse with identical semantic content, and the
   re-emitted XML must validate against `Project.xsd`.
5. Malicious fixtures (built in tests, not downloaded): DOCTYPE/XXE, zip bomb,
   path-traversal entry, symlink entry, duplicate id, dangling IDREF,
   oversized entry — each asserts a typed rejection or a fidelity downgrade,
   never a throw-through or a write outside root.

## Prohibited
Java/JRE runtime dependency; wiring into any production restore/publish path
(that is WS-024+); vendoring DawVert/ProjectConverter; network at runtime.

## DB/API implications
None (desktop-only, offline).

## Tests
Unit: type round-trip, deterministic ids, foreign-data preservation, each
security control (table-driven from the security model), version gate
(1.0 exact / 1.x warn / ≥2 reject). Optional CI: Java upstream lib as an
oracle validating our emitted XML (behind a `DAWPROJECT_JAVA_ORACLE` flag).

## Interactive acceptance
Load the Bitwig example fixture, re-emit, diff semantic content; open the
re-emitted file in Bitwig (founder gate, optional).

## Security review
The whole security model is this packet's core; reviewer must check every
row of WAVI_DAWPROJECT_SECURITY_MODEL.md against a test.

## Commit / handoff / stop
Conventional commits; push branch; handoff per tasks/README.md. STOP before
touching production adapters. Recommended worker: Builder+Architect review.
