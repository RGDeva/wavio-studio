/**
 * Writing the portable handoff to disk.
 *
 * Separated from `main.ts` for one reason that matters: this is the code whose
 * correctness depends on real filesystem behaviour — containment, unreadable
 * sources, truncated writes, checksums that disagree — and none of that can be
 * tested through an Electron IPC handler. The filesystem primitives are
 * injected, so the golden paths run against a real temporary directory while
 * the failure modes can be provoked deliberately.
 *
 * The invariants it enforces, in order:
 *
 *   1. Every destination is containment-checked at the moment of writing, not
 *      only when planned.
 *   2. A source that cannot be read is a reported failure, never a skip.
 *   3. Bytes are hashed before writing and the result is verified after, so a
 *      truncated write cannot become a valid handoff.
 *   4. A recorded checksum that disagrees marks the asset unreliable and
 *      fails the whole handoff.
 *   5. Metadata is generated LAST, from what was measured.
 */
import * as path from 'path';
import { isDestinationSafe } from './restoreArchive';
import type { HandoffPlan, VerifiedCopy } from './portablePackage';

export interface MaterializeFs {
  mkdirSync: (p: string, opts: { recursive: true }) => void;
  readFileSync: (p: string) => Buffer;
  writeFileSync: (p: string, data: Buffer | string, enc?: 'utf8') => void;
  statSync: (p: string) => { size: number };
  /** sha256 hex of a buffer, using the project's existing convention. */
  sha256: (data: Buffer) => string;
}

export interface MaterializeResult {
  /** False whenever anything is missing, escaped or mismatched. */
  ok: boolean;
  root: string;
  verified: VerifiedCopy[];
  failures: Array<{ path: string; reason: string }>;
  checksumMismatches: string[];
  metadataFiles: string[];
  /** Set when the whole operation could not proceed. */
  error?: string;
}

export function materializeHandoff(plan: HandoffPlan, fsys: MaterializeFs): MaterializeResult {
  const base: MaterializeResult = {
    ok: false, root: plan.root, verified: [], failures: [], checksumMismatches: [], metadataFiles: [],
  };
  if (plan.refusal) return { ...base, error: plan.refusal };

  const verified: VerifiedCopy[] = [];
  const failures: MaterializeResult['failures'] = [];

  try {
    fsys.mkdirSync(plan.root, { recursive: true });
    for (const dir of plan.dirs) fsys.mkdirSync(path.join(plan.root, dir), { recursive: true });

    for (const copy of plan.copies) {
      if (!isDestinationSafe(plan.root, copy.to)) {
        failures.push({ path: copy.to, reason: 'destination escapes the handoff folder' });
        continue;
      }
      const dest = path.join(plan.root, copy.to);

      let bytes: Buffer;
      try {
        bytes = fsys.readFileSync(copy.from);
      } catch {
        // Indexed but unreadable: a missing asset. Reported, never skipped —
        // a handoff short a stem is a different thing from one that never had
        // it, and only the first is a bug the user needs to know about.
        failures.push({ path: copy.to, reason: 'source file could not be read' });
        continue;
      }

      const sha256 = fsys.sha256(bytes);
      const mismatch = !!copy.expectedSha256 && copy.expectedSha256 !== sha256;

      fsys.writeFileSync(dest, bytes);
      // Verify the RESULT, not just the source.
      const written = fsys.statSync(dest);
      if (written.size !== bytes.length) {
        failures.push({ path: copy.to, reason: 'written file size does not match the source' });
        continue;
      }

      verified.push({
        to: copy.to, bucket: copy.bucket, role: copy.role,
        bytes: bytes.length, sha256, ...(mismatch ? { mismatch: true } : {}),
      });
    }

    // Metadata last, from what was actually measured.
    const metadataFiles: string[] = [];
    for (const file of plan.buildMetadata(verified)) {
      if (!isDestinationSafe(plan.root, file.relativePath)) {
        return { ...base, verified, failures, error: 'Refusing to write metadata outside the handoff folder.' };
      }
      fsys.writeFileSync(path.join(plan.root, file.relativePath), file.contents, 'utf8');
      metadataFiles.push(file.relativePath);
    }

    const checksumMismatches = verified.filter((v) => v.mismatch).map((v) => v.to);
    return {
      // An incomplete or unreliable handoff is not a success, even though the
      // folder exists and the metadata describes it accurately.
      ok: failures.length === 0 && checksumMismatches.length === 0,
      root: plan.root, verified, failures, checksumMismatches, metadataFiles,
    };
  } catch (e: any) {
    return { ...base, verified, failures, error: `Could not build the handoff: ${e?.message ?? 'unknown error'}` };
  }
}
