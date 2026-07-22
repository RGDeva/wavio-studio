/**
 * Wires the pure ProjectLinkClient to the real IPC surface (P3-2a).
 *
 * Kept separate from projectLinkClient.ts so that module stays dependency-free
 * and testable under the Node vitest env. `isOnline` reads the live navigator
 * flag, so an offline mutation is typed `offline` — never a false success.
 */
import { api, type LinkListItem } from './api';
import { ProjectLinkClient, type LinkClientDeps } from './projectLinkClient';
import { PendingContractAccountResolver, SessionEpoch } from './accountContext';

/**
 * One account-context resolver + session epoch per renderer session (P3-2b
 * prep). Today it always reports `missing-account-context` — the desktop has
 * no canonical account id until the Codex identity contract lands, at which
 * point `sharedAccountResolver.supply(<canonical id>)` activates scoping with
 * no other call-site changes. Logout/account-switch must call `onLogout()` /
 * `onAccountSwitch()` on both the resolver and any live client.
 */
export const sharedSessionEpoch = new SessionEpoch();
export const sharedAccountResolver = new PendingContractAccountResolver(sharedSessionEpoch);

export function makeLinkClientDeps(): LinkClientDeps {
  return {
    createProjectLink: (opts) => api.project.createLink({
      projectId: opts.projectId,
      cloudProjectId: opts.cloudProjectId,
      allowDownload: opts.allowDownload,
      collaboratorMode: opts.collaboratorMode,
    }),
    revokeLink: (opts) => api.links.revoke({ trackingId: opts.trackingId }),
    listLinks: async () => (await api.links.getAll()) as unknown as LinkListItem[],
    isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  };
}

export function createProjectLinkClient(): ProjectLinkClient {
  const client = new ProjectLinkClient(makeLinkClientDeps());
  client.attachAccountContext(sharedAccountResolver, sharedSessionEpoch);
  return client;
}
