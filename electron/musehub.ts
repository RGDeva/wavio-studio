/**
 * MuseHub SDK Integration for Wavi Desktop
 *
 * On startup:
 *   1. Initialize MuseSDK via native module (ffi-napi or prebuilt binding)
 *   2. Call MuseSdk_getUserInfo() to get the MuseHub UUID
 *   3. Send UUID to Wavi backend → receive entitlement/usage
 *   4. Finalize SDK session
 *
 * If MuseSDK is not available (not launched from MuseHub), we silently skip.
 */

import Store from 'electron-store';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MuseHubUserInfo {
  uuid: string;
  email?: string;
}

export interface MuseHubEntitlement {
  id: string;
  musehub_uuid: string;
  email: string | null;
  user_id: string | null;
  product_id: string | null;
  sku: string | null;
  subscription_option: string | null;
  status: 'active' | 'trial' | 'expired' | 'cancelled' | 'refunded';
  event_type: string | null;
  monthly_mix_limit: number;
  monthly_mixes_used: number;
  current_period_start: string | null;
  current_period_end: string | null;
}

export interface MuseHubSessionResult {
  entitlement: MuseHubEntitlement;
  allowed: boolean;
}

export interface MuseHubUsageResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  used: number;
  reason?: string;
}

// ─── SDK Stub ────────────────────────────────────────────────────────────────
// MuseSDK is a native library (.dylib / .dll) loaded via ffi or a prebuilt
// Node addon. The actual binding depends on the SDK distribution from MuseHub.
// Below is the integration contract — replace the stub with real bindings
// once the MuseSDK native library is available.

let _sdkInitialized = false;
let _cachedUserInfo: MuseHubUserInfo | null = null;

/**
 * Attempt to initialize the MuseSDK native library.
 * Returns true if the SDK is available and initialized.
 */
export function initMuseSdk(): boolean {
  try {
    // TODO: Replace with actual native binding load
    // Example with ffi-napi:
    //   const lib = ffi.Library('libMuseSDK', {
    //     'MuseSdk_init': ['int', []],
    //     'MuseSdk_getUserInfo': ['string', []],
    //     'MuseSdk_finalize': ['void', []],
    //   });
    //   const initResult = lib.MuseSdk_init();
    //   if (initResult !== 0) return false;

    // For now, check if a MuseHub launch arg or env var was passed
    const museUuid = process.env.MUSEHUB_UUID || process.argv.find(a => a.startsWith('--musehub-uuid='))?.split('=')[1];
    if (!museUuid) {
      console.log('[musehub] No MuseHub UUID detected — SDK not initialized (standalone launch)');
      return false;
    }

    _cachedUserInfo = {
      uuid: museUuid,
      email: process.env.MUSEHUB_EMAIL || undefined,
    };
    _sdkInitialized = true;
    console.log('[musehub] SDK initialized, uuid:', museUuid.slice(0, 8) + '...');
    return true;
  } catch (err: any) {
    console.warn('[musehub] SDK init failed:', err?.message ?? err);
    return false;
  }
}

/**
 * Get the MuseHub user info (UUID + optional email).
 * Returns null if SDK was not initialized or user is not logged in.
 */
export function getMuseHubUserInfo(): MuseHubUserInfo | null {
  if (!_sdkInitialized || !_cachedUserInfo) return null;

  // TODO: Replace with actual SDK call
  // const raw = lib.MuseSdk_getUserInfo();
  // return JSON.parse(raw);

  return _cachedUserInfo;
}

/**
 * Finalize the MuseSDK session. Call on app quit.
 */
export function finalizeMuseSdk(): void {
  if (!_sdkInitialized) return;
  // TODO: lib.MuseSdk_finalize();
  _sdkInitialized = false;
  console.log('[musehub] SDK finalized');
}

export function isMuseHubSession(): boolean {
  return _sdkInitialized && _cachedUserInfo !== null;
}

// ─── Backend Communication ───────────────────────────────────────────────────

const WAVI_API_BASE = process.env.WAVI_API_BASE_URL || 'https://wavi.stream';

/**
 * Register/retrieve the entitlement for this MuseHub session.
 * Called once at startup after SDK init succeeds.
 */
export async function startMuseHubSession(store: Store): Promise<MuseHubSessionResult | null> {
  const userInfo = getMuseHubUserInfo();
  if (!userInfo) return null;

  try {
    const resp = await fetch(`${WAVI_API_BASE}/api/musehub/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        musehub_uuid: userInfo.uuid,
        email: userInfo.email,
        user_id: store.get('userId', null) as string | null,
      }),
    });

    if (!resp.ok) {
      console.error('[musehub] session error:', resp.status, await resp.text().catch(() => ''));
      return null;
    }

    const result: MuseHubSessionResult = await resp.json();

    // Cache entitlement locally
    store.set('musehub_entitlement', result.entitlement);
    store.set('musehub_uuid', userInfo.uuid);

    console.log(`[musehub] session started — status=${result.entitlement.status} limit=${result.entitlement.monthly_mix_limit} used=${result.entitlement.monthly_mixes_used}`);
    return result;
  } catch (err: any) {
    console.error('[musehub] session fetch failed:', err?.message ?? err);
    return null;
  }
}

/**
 * Check + increment usage before an AI Mix action.
 * Returns whether the action is allowed.
 */
export async function checkAndIncrementUsage(store: Store): Promise<MuseHubUsageResult> {
  const museUuid = store.get('musehub_uuid', null) as string | null;

  // If not a MuseHub session, allow unconditionally (existing Stripe/Privy flow)
  if (!museUuid) {
    return { allowed: true, remaining: Infinity, limit: Infinity, used: 0 };
  }

  try {
    const resp = await fetch(`${WAVI_API_BASE}/api/musehub/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ musehub_uuid: museUuid }),
    });

    if (!resp.ok) {
      console.warn('[musehub] usage check failed:', resp.status);
      // Fail open for now — don't block user if backend is down
      return { allowed: true, remaining: -1, limit: -1, used: -1 };
    }

    const result: MuseHubUsageResult = await resp.json();

    // Update cached entitlement
    const cached = store.get('musehub_entitlement', null) as MuseHubEntitlement | null;
    if (cached) {
      cached.monthly_mixes_used = result.used;
      store.set('musehub_entitlement', cached);
    }

    return result;
  } catch (err: any) {
    console.warn('[musehub] usage check error:', err?.message ?? err);
    return { allowed: true, remaining: -1, limit: -1, used: -1 };
  }
}

/**
 * Get the cached entitlement from the local store (no network call).
 */
export function getCachedEntitlement(store: Store): MuseHubEntitlement | null {
  return (store.get('musehub_entitlement', null) as MuseHubEntitlement | null);
}
