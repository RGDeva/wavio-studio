/**
 * Wires the pure ProjectLinkClient to the real IPC surface (P3-2a).
 *
 * Kept separate from projectLinkClient.ts so that module stays dependency-free
 * and testable under the Node vitest env. `isOnline` reads the live navigator
 * flag, so an offline mutation is typed `offline` — never a false success.
 */
import { api, type LinkListItem } from './api';
import { ProjectLinkClient, type LinkClientDeps } from './projectLinkClient';

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
  return new ProjectLinkClient(makeLinkClientDeps());
}
