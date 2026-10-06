/**
 * Authorization for a proposed action — read from Wavi's own records.
 *
 * A model cannot create permission. It may propose publishing to a project the
 * user can only view, and the correct response is refusal, not an attempt that
 * the server happens to reject. Checking locally also means the refusal is
 * honest about WHY, without leaking a raw server error.
 *
 * The vocabulary here is the existing project-link one — `owner`, `comment`,
 * `view`, with contribution carried separately — and the contribution rule is
 * the one `adoptionAllowsContribution` already encodes: only `comment` may
 * send work back. Nothing new is invented, because a second notion of who may
 * do what is how the two drift apart.
 *
 * Pure: no I/O. The caller supplies the authorization state.
 */

export type ProjectRole = 'owner' | 'comment' | 'view';

export interface ProjectAuthorization {
  role: ProjectRole;
  /**
   * Whether this checkout may publish a child version. For a restored project
   * this is the recorded contribution permission, which exists only alongside
   * the `comment` role.
   */
  canPublishChildVersion: boolean;
}

/** Owner of a local project the user created themselves. */
export const OWNER_AUTHORIZATION: ProjectAuthorization = {
  role: 'owner', canPublishChildVersion: true,
};

export type AuthorizationResult = { ok: true } | { ok: false; reason: string };

/**
 * What each action requires.
 *
 * Sharing is an owner's decision: creating a link to a project you were merely
 * shown would re-share someone else's work under your access, so it is refused
 * locally rather than left to the server.
 */
const REQUIREMENTS: Record<string, (a: ProjectAuthorization) => AuthorizationResult> = {
  create_project_link: (a) => a.role === 'owner'
    ? { ok: true }
    : { ok: false, reason: 'Only the project’s owner can create a Project Link. You have ' + a.role + ' access to this one.' },
  publish_child_version: (a) => a.canPublishChildVersion
    ? { ok: true }
    : { ok: false, reason: a.role === 'owner'
        ? 'This project is yours, so there is no parent version to contribute back to.'
        : 'You have ' + a.role + ' access to this project and cannot send changes back.' },
};

/**
 * Authorize a validated action.
 *
 * Read-only actions need nothing: they inspect what the user can already see.
 * An action with no recorded requirement is permitted only because the
 * allowlist has already decided it is safe — this function narrows, never
 * widens.
 */
export function authorizeAction(
  tool: string,
  authorization: ProjectAuthorization | null,
  mutating: boolean,
): AuthorizationResult {
  if (!mutating) return { ok: true };
  if (!authorization) {
    // A mutation with no known authorization state fails closed. Not knowing
    // is not the same as being allowed.
    return { ok: false, reason: 'Wavi could not confirm your access to this project, so it will not change anything.' };
  }
  const check = REQUIREMENTS[tool];
  return check ? check(authorization) : { ok: true };
}
