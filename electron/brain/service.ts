/**
 * Project Brain — the service that composes the pure modules over real state.
 *
 * Dependencies are injected rather than imported so this is testable under
 * plain Node: `db.ts` binds the Electron-ABI better-sqlite3 and cannot be
 * loaded by vitest. That constraint is why so much of this codebase grew
 * hand-copied test mirrors; injection avoids adding another one.
 *
 * This is the layer a later local LLM agent talks to. It returns data, never
 * prose, and never a filesystem path.
 */
import { parseBrainQuery, isEmptyQuery } from './query';
import { rankRecords, groupHitsByProject, type BrainRecord, type BrainHit } from './retrieval';
import {
  planFactWrite, believedFacts, type ProjectFact, type FactInput, type FactKind,
} from './memory';
import { buildContextPack, summarizePack, type ContextPack, type PackFile, type PackVersion, type PackProject, type PackIssue } from './contextPack';
import type { IndexTruth } from './memory';

/** Raw row shapes, matching the db queries. */
export interface RawRecordRow {
  id: string; project_id: string; name: string; project_name: string;
  daw_type: string | null; role: string | null; file_type: string | null;
  bpm: number | null; key_note: string | null; status: string | null; modified_at: string | null;
}

export interface RawFactRow {
  id: string; project_id: string; key: string; value: string;
  kind: string; source_origin: string; source_producer: string;
  observed_at: string; superseded_at: string | null;
}

export interface BrainDeps {
  getRecords: () => { projects: RawRecordRow[]; files: RawRecordRow[] };
  getFactRows: (projectId: string) => RawFactRow[];
  getBelievedFactRow: (projectId: string, key: string) => RawFactRow | null;
  insertFact: (row: RawFactRow) => void;
  supersedeFact: (id: string, supersededAt: string) => void;
  /** Project identity + files + versions for a context pack. */
  getProjectPackInput: (projectId: string) => {
    project: PackProject; files: PackFile[]; versions: PackVersion[]; issues: PackIssue[]; indexTruth: IndexTruth;
  } | null;
  now: () => string;
  newId: () => string;
}

function toRecord(row: RawRecordRow, kind: BrainRecord['kind']): BrainRecord {
  return {
    id: row.id, kind, projectId: row.project_id,
    name: row.name ?? '', projectName: row.project_name ?? '',
    dawType: row.daw_type ?? null, role: row.role ?? null, fileType: row.file_type ?? null,
    bpm: row.bpm ?? null, keyNote: row.key_note ?? null,
    status: row.status ?? null, modifiedAt: row.modified_at ?? null,
  };
}

function toFact(row: RawFactRow): ProjectFact {
  return {
    id: row.id, projectId: row.project_id, key: row.key, value: row.value,
    kind: (row.kind === 'stated' ? 'stated' : 'derived') as FactKind,
    source: { origin: row.source_origin as ProjectFact['source']['origin'], producer: row.source_producer },
    observedAt: row.observed_at, supersededAt: row.superseded_at,
  };
}

export interface SearchResult {
  query: ReturnType<typeof parseBrainQuery>;
  hits: BrainHit[];
  byProject: ReturnType<typeof groupHitsByProject>;
  /** True when the query asked for nothing — the caller should prompt, not guess. */
  empty: boolean;
}

export interface RememberResult {
  ok: boolean;
  action: 'insert' | 'supersede' | 'noop' | 'reject';
  reason?: string;
}

export function createBrainService(deps: BrainDeps) {
  return {
    /**
     * Deterministic retrieval across every indexed project.
     *
     * An empty query returns nothing rather than everything: "show me
     * something" is a question the brain cannot answer honestly, and
     * returning the whole index would look like a ranked answer.
     */
    search(queryText: string, limit = 50): SearchResult {
      const referenceYear = new Date(deps.now()).getUTCFullYear();
      const query = parseBrainQuery(queryText ?? '', referenceYear);
      if (isEmptyQuery(query)) {
        return { query, hits: [], byProject: [], empty: true };
      }
      const raw = deps.getRecords();
      const records = [
        ...raw.projects.map((r) => toRecord(r, 'project')),
        ...raw.files.map((r) => toRecord(r, 'file')),
      ];
      const hits = rankRecords(records, query, { now: deps.now(), limit });
      return { query, hits, byProject: groupHitsByProject(hits), empty: false };
    },

    /** Everything currently believed about a project, attributed. */
    recall(projectId: string): ProjectFact[] {
      return believedFacts(deps.getFactRows(projectId).map(toFact));
    },

    /**
     * Record something about a project. Append-only: an unchanged value is a
     * no-op, a changed one supersedes, and an invalid or unattributable write
     * is rejected rather than stored.
     */
    remember(input: { projectId: string; key: string; value: string; kind: FactKind; origin: 'index' | 'user' | 'agent'; producer: string }): RememberResult {
      const now = deps.now();
      const fact: FactInput = {
        projectId: input.projectId, key: input.key, value: input.value, kind: input.kind,
        source: { origin: input.origin, producer: input.producer }, observedAt: now,
      };
      const currentRow = deps.getBelievedFactRow(input.projectId, input.key);
      const plan = planFactWrite(currentRow ? toFact(currentRow) : null, fact, now);

      switch (plan.action) {
        case 'reject': return { ok: false, action: 'reject', reason: plan.reason };
        case 'noop': return { ok: true, action: 'noop', reason: plan.reason };
        case 'supersede':
          deps.supersedeFact(plan.supersedeId, plan.supersededAt);
          deps.insertFact(rowFor(plan.fact, deps.newId()));
          return { ok: true, action: 'supersede' };
        case 'insert':
          deps.insertFact(rowFor(plan.fact, deps.newId()));
          return { ok: true, action: 'insert' };
      }
    },

    /** The bounded, attributed snapshot a model consumes. */
    contextPack(projectId: string): { pack: ContextPack; summary: string } | null {
      const base = deps.getProjectPackInput(projectId);
      if (!base) return null;
      const pack = buildContextPack({
        project: base.project,
        files: base.files,
        versions: base.versions,
        facts: deps.getFactRows(projectId).map(toFact),
        indexTruth: base.indexTruth,
        issues: base.issues,
      });
      return { pack, summary: summarizePack(pack) };
    },
  };
}

function rowFor(fact: FactInput, id: string): RawFactRow {
  return {
    id, project_id: fact.projectId, key: fact.key, value: fact.value, kind: fact.kind,
    source_origin: fact.source.origin, source_producer: fact.source.producer,
    observed_at: fact.observedAt, superseded_at: null,
  };
}

export type BrainService = ReturnType<typeof createBrainService>;
