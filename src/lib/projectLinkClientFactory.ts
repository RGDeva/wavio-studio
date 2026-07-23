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

/**
 * Bridge the server-authoritative account DID (main → renderer via `auth:account`)
 * into the account-context resolver. A change of DID is an account switch
 * (invalidate epoch); `null` is logout (fail closed). Registered once.
 */
let _accountBridgeRegistered = false;
export function registerAccountBridge(): void {
  if (_accountBridgeRegistered || typeof (api as any).on !== 'function') return;
  _accountBridgeRegistered = true;
  let last: string | null = null;
  (api as any).on('auth:account', (data: { accountId: string | null }) => {
    const did = data?.accountId ?? null;
    if (did === last) return;
    if (!did) { sharedAccountResolver.onLogout(); last = null; return; }
    if (last) sharedAccountResolver.onAccountSwitch();
    sharedAccountResolver.supply(did);
    last = did;
  });
}

export function makeLinkClientDeps(): LinkClientDeps {
  return {
    // Authoritative create/revoke: token + DID stay in main; typed result back.
    createProjectLink: (opts) => api.projectLinks.create({
      projectId: opts.projectId,
      projectVersionId: opts.projectVersionId,
      allowDownload: opts.allowDownload,
      collaboratorMode: opts.collaboratorMode === 'comment' ? 'comment' : 'view',
    }),
    revokeLink: async (opts) => {
      const r = await api.projectLinks.revoke({ trackingId: opts.trackingId });
      // Map the authoritative `{ ok:true }` onto the normalizer's success shape.
      return r?.ok ? { success: true } : r;
    },
    // Account-scoped rows only (legacy/unowned excluded from the active view).
    listLinks: async () => (await api.projectLinks.getScoped()).scoped as unknown as LinkListItem[],
    isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  };
}

export function createProjectLinkClient(): ProjectLinkClient {
  registerAccountBridge();
  const client = new ProjectLinkClient(makeLinkClientDeps());
  client.attachAccountContext(sharedAccountResolver, sharedSessionEpoch);
  return client;
}
