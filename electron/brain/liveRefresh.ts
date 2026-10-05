/**
 * Project Brain — keeping memory current from live filesystem events.
 *
 * Without this, derived project memory only existed when something asked for
 * it: the watcher updated the index, but nothing recomputed what the index
 * now implied, so the brain's remembered facts went stale until a manual
 * rescan. This closes that loop.
 *
 * Three things make it safe to run on every file event:
 *
 *  1. **Coalescing.** Saving a project in a DAW can touch dozens of files in
 *     a second. Each one marks the project dirty; only one recompute runs per
 *     window. Recomputing per event would make a busy save storm the CPU and
 *     the append-only store alike.
 *  2. **Only real changes are written.** `planFactWrite` already no-ops an
 *     unchanged value, so a recompute that finds nothing new writes nothing.
 *     That is what makes it safe for the watcher to over-notify.
 *  3. **A failure never reaches the watcher.** Refreshing memory is strictly
 *     secondary to indexing the file; an error here must not break ingestion,
 *     so every flush is isolated per project.
 *
 * The planner is pure and the scheduler is injected, so the timing behaviour
 * is testable without waiting in real time.
 */
import { deriveProjectMemory, type DeriveFile, type DeriveVersion } from './derive';
import { planFactWrite, type FactInput, type ProjectFact } from './memory';

export interface RefreshPlan {
  /** Projects to recompute now. */
  flush: string[];
  /** Projects held back because they were refreshed too recently. */
  deferred: string[];
}

export interface DirtyEntry {
  projectId: string;
  /** When this project was first marked dirty in the current window. */
  markedAt: string;
  /** When it last completed a refresh, if ever. */
  lastRefreshedAt: string | null;
}

/**
 * Decide which dirty projects to recompute.
 *
 * `minIntervalMs` is a floor per project, not per batch: one project being
 * hammered by a long export must not starve every other project's refresh.
 */
export function planRefreshBatch(
  dirty: DirtyEntry[],
  nowIso: string,
  opts: { minIntervalMs: number; maxPerBatch: number },
): RefreshPlan {
  const now = Date.parse(nowIso);
  const flush: string[] = [];
  const deferred: string[] = [];

  // Oldest-dirty first, so a project that has been waiting cannot be
  // perpetually overtaken by newer activity.
  const ordered = [...dirty].sort((a, b) =>
    a.markedAt.localeCompare(b.markedAt) || a.projectId.localeCompare(b.projectId));

  for (const entry of ordered) {
    if (flush.length >= opts.maxPerBatch) { deferred.push(entry.projectId); continue; }
    const last = entry.lastRefreshedAt ? Date.parse(entry.lastRefreshedAt) : null;
    if (last !== null && Number.isFinite(last) && now - last < opts.minIntervalMs) {
      deferred.push(entry.projectId);
      continue;
    }
    flush.push(entry.projectId);
  }
  return { flush, deferred };
}

export interface RefresherDeps {
  /** Rows needed to recompute a project's derived memory. */
  getDeriveInput: (projectId: string) => {
    projectName: string;
    dawType: string | null;
    files: DeriveFile[];
    versions: DeriveVersion[];
    lastActivityAt: string | null;
  } | null;
  /** Currently-believed fact for a key, or null. */
  getBelievedFact: (projectId: string, key: string) => ProjectFact | null;
  insertFact: (fact: FactInput & { id: string }) => void;
  supersedeFact: (id: string, supersededAt: string) => void;
  newId: () => string;
  now: () => string;
  /** Injected so tests drive timing without waiting. */
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  /** Optional sink for diagnostics; never throws into the caller. */
  log?: (message: string) => void;
}

export interface RefresherOptions {
  /** How long to coalesce a burst before recomputing. */
  debounceMs?: number;
  /** Minimum gap between recomputes of the SAME project. */
  minIntervalMs?: number;
  /** Ceiling on projects recomputed in one flush. */
  maxPerBatch?: number;
}

export interface FlushOutcome {
  refreshed: string[];
  deferred: string[];
  /** Facts actually written (changed) per project. */
  written: Record<string, number>;
  errors: Array<{ projectId: string; message: string }>;
}

/**
 * Marks projects dirty from watcher events and recomputes their derived
 * memory on a coalescing timer.
 */
export function createBrainRefresher(deps: RefresherDeps, options: RefresherOptions = {}) {
  const debounceMs = options.debounceMs ?? 5_000;
  const minIntervalMs = options.minIntervalMs ?? 15_000;
  const maxPerBatch = options.maxPerBatch ?? 25;

  const dirty = new Map<string, DirtyEntry>();
  /** Per-project last-refresh time. Outlives the dirty entry, which is cleared
   *  on flush — otherwise the interval floor would reset every burst. */
  const lastRefreshedAt = new Map<string, string>();
  let timer: unknown = null;
  let stopped = false;

  function arm() {
    if (stopped || timer !== null) return;
    timer = deps.schedule(() => { timer = null; flush(); }, debounceMs);
  }

  /** Recompute one project and write only the facts whose value changed. */
  function refreshProject(projectId: string, nowIso: string): number {
    const input = deps.getDeriveInput(projectId);
    if (!input) return 0;
    const memory = deriveProjectMemory({ projectId, ...input });

    let written = 0;
    for (const fact of memory.facts) {
      const incoming: FactInput = {
        projectId, key: fact.key, value: fact.value,
        kind: 'derived',
        // Only the index may author a derived fact; the watcher IS the index
        // here, which is why this is allowed to say so.
        source: { origin: 'index', producer: 'watcher' },
        observedAt: nowIso,
      };
      const plan = planFactWrite(deps.getBelievedFact(projectId, fact.key), incoming, nowIso);
      if (plan.action === 'insert') {
        deps.insertFact({ ...plan.fact, id: deps.newId() });
        written++;
      } else if (plan.action === 'supersede') {
        deps.supersedeFact(plan.supersedeId, plan.supersededAt);
        deps.insertFact({ ...plan.fact, id: deps.newId() });
        written++;
      }
      // 'noop' and 'reject' write nothing — a recompute that found no change
      // must leave no trace, or the append-only store fills with noise.
    }
    return written;
  }

  function flush(): FlushOutcome {
    const nowIso = deps.now();
    const plan = planRefreshBatch([...dirty.values()], nowIso, { minIntervalMs, maxPerBatch });
    const outcome: FlushOutcome = { refreshed: [], deferred: plan.deferred, written: {}, errors: [] };

    for (const projectId of plan.flush) {
      try {
        const n = refreshProject(projectId, nowIso);
        outcome.refreshed.push(projectId);
        outcome.written[projectId] = n;
        dirty.delete(projectId);
      } catch (e: any) {
        // Isolated per project: refreshing memory is secondary to indexing,
        // and one bad project must not stop the others or reach the watcher.
        outcome.errors.push({ projectId, message: e?.message ?? 'unknown' });
        dirty.delete(projectId);
        deps.log?.(`[brain] refresh failed for ${projectId}: ${e?.message}`);
      }
    }

    // Record the attempt so the per-project floor applies on the next burst.
    // Deferred projects stay in `dirty` and are re-armed below.
    for (const projectId of plan.flush) lastRefreshedAt.set(projectId, nowIso);

    if (dirty.size > 0) arm();
    return outcome;
  }

  return {
    /** Called from the watcher when a file event touched a project. */
    markDirty(projectId: string | null | undefined) {
      if (stopped || !projectId) return;
      if (!dirty.has(projectId)) {
        dirty.set(projectId, {
          projectId,
          markedAt: deps.now(),
          lastRefreshedAt: lastRefreshedAt.get(projectId) ?? null,
        });
      }
      arm();
    },

    /** Force a flush now, bypassing the debounce (used by manual Rescan). */
    flushNow(): FlushOutcome {
      if (timer !== null) { deps.cancel(timer); timer = null; }
      return flush();
    },

    /** Drop the per-project interval floor — manual Rescan is a user asking explicitly. */
    forceRefresh(projectId: string): number {
      const nowIso = deps.now();
      const n = refreshProject(projectId, nowIso);
      lastRefreshedAt.set(projectId, nowIso);
      dirty.delete(projectId);
      return n;
    },

    pendingCount(): number { return dirty.size; },

    stop() {
      stopped = true;
      if (timer !== null) { deps.cancel(timer); timer = null; }
      dirty.clear();
    },
  };
}

export type BrainRefresher = ReturnType<typeof createBrainRefresher>;
