/**
 * One-time migration of the legacy electron-store `memory` blob into
 * project_facts, so Project Brain becomes the single persistent memory.
 *
 * The legacy store was a flat, app-wide JSON object with no provenance and no
 * history. Everything in it is, by definition, something a person typed — so
 * it migrates as explicit user memory (`kind: 'stated'`, `origin: 'user'`),
 * never as derived index memory. Collapsing it into derived facts would make
 * a human assertion indistinguishable from something the watcher computed.
 *
 * Safety rules this planner encodes, because a migration that loses user data
 * is worse than no migration at all:
 *
 *  · **Idempotent.** Re-running produces no duplicates.
 *  · **Non-destructive.** The planner never proposes deleting the legacy blob;
 *    the caller may only clear it AFTER a successful transfer, and even then
 *    the original is left on disk as a rollback path.
 *  · **Never overwrites newer.** A Project Brain record that is newer than the
 *    legacy entry wins — the legacy store is the stale one by then.
 *  · **Malformed input fails safely.** Bad entries are skipped and reported,
 *    never written and never fatal.
 *
 * Pure: no I/O, no Electron, no clock.
 */
import type { FactInput } from './memory';

/** A row already believed in project_facts for the same scope+key. */
export interface ExistingFact {
  id: string;
  key: string;
  kind: 'derived' | 'stated';
  value: string;
  observedAt: string;
}

export type LegacyEntry = unknown;

export interface LegacyMemoryBlob {
  [key: string]: LegacyEntry;
}

export type MigrationAction =
  | { action: 'insert'; key: string; fact: FactInput }
  | { action: 'supersede'; key: string; supersedeId: string; fact: FactInput }
  | { action: 'skip'; key: string; reason: string };

export interface MigrationPlan {
  actions: MigrationAction[];
  /** Entries that will be written (insert + supersede). */
  willWrite: number;
  skipped: Array<{ key: string; reason: string }>;
}

/** The legacy store held either a bare string or `{ value, category, createdAt, updatedAt }`. */
function readLegacy(raw: LegacyEntry): { value: string; category: string; updatedAt: string | null } | null {
  if (typeof raw === 'string') return { value: raw, category: 'note', updatedAt: null };
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.value !== 'string') return null;
    return {
      value: o.value,
      category: typeof o.category === 'string' && o.category ? o.category : 'note',
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
    };
  }
  return null;
}

export const LEGACY_PRODUCER = 'legacy-migration';

/**
 * Plan the migration.
 *
 * `existing` is whatever project_facts already believes for the same (global)
 * scope, keyed by memory key.
 */
export function planLegacyMemoryMigration(
  legacy: LegacyMemoryBlob | null | undefined,
  existing: Map<string, ExistingFact>,
  nowIso: string,
): MigrationPlan {
  const actions: MigrationAction[] = [];
  if (!legacy || typeof legacy !== 'object') {
    return { actions, willWrite: 0, skipped: [] };
  }

  // Sorted so a plan is deterministic and reviewable.
  for (const key of Object.keys(legacy).sort()) {
    if (!key.trim()) {
      actions.push({ action: 'skip', key, reason: 'empty key' });
      continue;
    }
    const parsed = readLegacy(legacy[key]);
    if (!parsed) {
      // Malformed values are reported, never written and never fatal.
      actions.push({ action: 'skip', key, reason: 'unreadable legacy value' });
      continue;
    }

    const fact: FactInput = {
      projectId: null,            // the legacy store was app-wide
      key,
      value: parsed.value,
      kind: 'stated',             // a person typed this; it is not derived
      source: { origin: 'user', producer: LEGACY_PRODUCER },
      observedAt: parsed.updatedAt ?? nowIso,
    };

    const prior = existing.get(key);
    if (!prior) {
      actions.push({ action: 'insert', key, fact });
      continue;
    }

    if (prior.kind === 'derived') {
      // A derived fact occupies this key. Overwriting it with user memory
      // would blur two different kinds of claim, and the index would simply
      // recompute it anyway. Report rather than guess.
      actions.push({ action: 'skip', key, reason: 'a derived fact already holds this key' });
      continue;
    }

    if (prior.value === parsed.value) {
      // Already migrated, or the same thing said twice. Either way: idempotent.
      actions.push({ action: 'skip', key, reason: 'already present with the same value' });
      continue;
    }

    const legacyAt = parsed.updatedAt;
    if (legacyAt && prior.observedAt >= legacyAt) {
      // Project Brain's record is newer; the legacy blob is the stale copy.
      actions.push({ action: 'skip', key, reason: 'a newer Project Brain record already exists' });
      continue;
    }

    actions.push({ action: 'supersede', key, supersedeId: prior.id, fact });
  }

  return {
    actions,
    willWrite: actions.filter((a) => a.action !== 'skip').length,
    skipped: actions.filter((a): a is Extract<MigrationAction, { action: 'skip' }> => a.action === 'skip')
      .map(({ key, reason }) => ({ key, reason })),
  };
}
