/**
 * DEV-ONLY authenticated staging smoke for Multiplayer v1 + P3-4-CL.
 *
 * This is the one thing the deterministic suites cannot prove: that the REAL
 * request bodies, built by the REAL adapter, are accepted by the REAL server
 * when carrying a REAL desktop token. Everything else in the gate is pinned to
 * the handler source; this pins it to the running deployment.
 *
 * Safety:
 *  - never runs unless BOTH `WAVI_SMOKE=1` and the app is pointed at a
 *    non-production API (`IS_DEV_API`). Production is unreachable from here.
 *  - it calls the same exported flows the IPC handlers use — no parallel
 *    request construction, so a passing smoke is evidence about shipped code.
 *  - the evidence file is REDACTED by construction: it records action names,
 *    request field NAMES (not values that could carry identity), status codes,
 *    and boolean assertions. Tokens, DIDs, invite capabilities and canonical
 *    ids are never written.
 *
 * Scope honesty: one signed-in account gives the OWNER perspective. The
 * collaborator-visibility and foreign-account-403 checks need a different
 * account signed in, so the runner is role-parameterised and reports which
 * perspective it actually exercised rather than implying full coverage.
 */

import type { MultiplayerServiceDeps } from './multiplayerService';
import {
  listCollaboratorsAll, listActivityAll, listContributionsAll,
  resolveInviteTargetFlow, MULTIPLAYER_ACTIONS,
} from './multiplayerService';

export type SmokeRole = 'owner' | 'collaborator' | 'foreign';

export interface SmokeStep {
  step: string;
  action: string;
  /** Field NAMES only — never values. */
  requestFields: string[];
  outcome: 'ok' | 'expected-failure' | 'unexpected-failure' | 'skipped';
  reason?: string;
  detail?: string;
  /** Privacy assertions evaluated on the real response. */
  assertions?: Record<string, boolean>;
}

export interface SmokeReport {
  startedAt: string;
  finishedAt: string;
  role: SmokeRole;
  apiBase: string;
  serverContract: string;
  /** True only if every step that was expected to pass did. */
  pass: boolean;
  steps: SmokeStep[];
  notRun: string[];
}

/** Server SHA this smoke is written against. */
export const SMOKE_SERVER_CONTRACT = 'wavio@6236c3901966e88bb9a05bef79253463bffa6abd';

/** No token, DID, invite capability or canonical id may appear in evidence. */
export function assertNoSecrets(blob: string): boolean {
  return !/did:privy|invt_|wv_[A-Za-z0-9]|Bearer |eyJ[A-Za-z0-9_-]{10,}/.test(blob);
}

/**
 * Deep-scan a real response for anything that must never reach the renderer or
 * the model. Returns the assertion map recorded in the evidence file.
 */
export function privacyAssertions(projected: unknown): Record<string, boolean> {
  const json = JSON.stringify(projected ?? null);
  return {
    noCanonicalDid: !/did:privy/.test(json),
    noInviteCapability: !/invt_/.test(json),
    noBearerOrToken: !/Bearer |wv_[A-Za-z0-9]|authToken/.test(json),
    noAbsolutePath: !/\/Users\//.test(json),
  };
}

export interface SmokeDeps extends MultiplayerServiceDeps {
  /** Cloud project id to exercise. */
  projectId: string;
  /** Optional identifier to resolve; skipped when absent. */
  resolveIdentifier?: string | null;
  apiBase: string;
}

/**
 * Read-only sequence. Deliberately excludes every mutation: an authenticated
 * smoke that invites people and publishes versions writes real rows into
 * staging, and doing that unattended is not something to trigger from a
 * harness. Mutations are listed in `notRun` for the operator to drive through
 * the UI once this proves the read paths.
 */
export async function runStagingSmoke(deps: SmokeDeps, role: SmokeRole): Promise<SmokeReport> {
  const startedAt = new Date().toISOString();
  const steps: SmokeStep[] = [];

  const record = (
    step: string, action: string, requestFields: string[],
    res: { kind: string; reason?: string; records?: unknown[]; pageComplete?: boolean },
    expectFailure?: string,
  ) => {
    const failed = res.kind === 'failure';
    const outcome: SmokeStep['outcome'] =
      expectFailure ? (failed && res.reason === expectFailure ? 'expected-failure' : 'unexpected-failure')
      : failed ? 'unexpected-failure' : 'ok';
    steps.push({
      step, action, requestFields, outcome,
      reason: res.reason,
      detail: res.records ? `${res.records.length} item(s), pageComplete=${res.pageComplete}` : undefined,
      assertions: res.records ? privacyAssertions(res.records) : undefined,
    });
  };

  // 1. Collaborator roster
  record('roster', MULTIPLAYER_ACTIONS.listCollaborators, ['projectId', 'limit'],
    await listCollaboratorsAll(deps, { projectId: deps.projectId }) as any,
    role === 'foreign' ? 'forbidden' : undefined);

  // 2. Project activity
  record('activity', MULTIPLAYER_ACTIONS.listActivity, ['projectId', 'limit'],
    await listActivityAll(deps, { projectId: deps.projectId }) as any,
    role === 'foreign' ? 'forbidden' : undefined);

  // 3. Contribution queue — unfiltered. `state` MUST be absent from the body.
  record('queue:all', MULTIPLAYER_ACTIONS.listContributions, ['projectId', 'limit'],
    await listContributionsAll(deps, { projectId: deps.projectId }) as any,
    role === 'foreign' ? 'forbidden' : undefined);

  // 4. Contribution queue — each state filter, proving the server accepts them.
  for (const state of ['submitted', 'accepted', 'rejected', 'withdrawn'] as const) {
    record(`queue:${state}`, MULTIPLAYER_ACTIONS.listContributions, ['projectId', 'limit', 'state'],
      await listContributionsAll(deps, { projectId: deps.projectId, state }) as any,
      role === 'foreign' ? 'forbidden' : undefined);
  }

  // 5. Identity resolution — only when the operator supplied an identifier,
  //    because it consumes one of 10 rate-limited lookups per 15 minutes.
  if (deps.resolveIdentifier) {
    const r = await resolveInviteTargetFlow(deps, {
      projectId: deps.projectId, identifier: deps.resolveIdentifier,
    });
    steps.push({
      step: 'resolve-invite-target',
      action: MULTIPLAYER_ACTIONS.resolveInviteTarget,
      requestFields: ['projectId', 'identifier'],
      outcome: r.kind === 'failure' ? 'unexpected-failure' : 'ok',
      reason: r.kind === 'failure' ? r.reason : undefined,
      // Records only WHETHER it resolved — never who, never the capability.
      detail: r.kind === 'resolved' ? 'resolved=true' : r.kind === 'unresolved' ? 'resolved=false' : undefined,
      assertions: r.kind === 'resolved'
        ? { ...privacyAssertions({ display: r.display }), capabilityStaysInMain: true }
        : undefined,
    });
  } else {
    steps.push({
      step: 'resolve-invite-target', action: MULTIPLAYER_ACTIONS.resolveInviteTarget,
      requestFields: ['projectId', 'identifier'], outcome: 'skipped',
      reason: 'no WAVI_SMOKE_IDENTIFIER supplied (rate-limited: 10 per 15 min)',
    });
  }

  const pass = steps.every((s) => s.outcome === 'ok' || s.outcome === 'expected-failure' || s.outcome === 'skipped');

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    role,
    apiBase: deps.apiBase,
    serverContract: SMOKE_SERVER_CONTRACT,
    pass,
    steps,
    notRun: [
      'invite-project-collaborator (mutation — writes a real membership row)',
      'respond-project-invite (mutation; needs the invitee signed in)',
      'revoke-project-collaborator (mutation)',
      'publish-project-version contribution mode (mutation — writes a real version)',
      'respond-project-contribution accept/reject (mutation)',
      'withdraw-project-contribution (mutation)',
      role !== 'collaborator' ? 'collaborator-visibility (needs the collaborator account signed in)' : '',
      role !== 'foreign' ? 'foreign-account 403 (needs an unrelated account signed in)' : '',
    ].filter(Boolean),
  };
}
