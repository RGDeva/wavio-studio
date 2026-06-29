/**
 * MuseHub SDK Integration Stub
 *
 * The native MuseHub SDK (libMuseClientSdk.*.dylib) is disabled to avoid
 * macOS Gatekeeper blocking. The types are preserved for future integration
 * once the SDK is properly code-signed/notarized.
 */

// ─── Types (preserved for future use) ────────────────────────────────────────

export interface MuseHubUserInfo {
  uuid: string;
  email?: string;
  name?: string;
  picture_url?: string;
  sku?: string;
  subscription_option?: string;
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

// ─── Stub Implementations ───────────────────────────────────────────────────

import type Store from 'electron-store';

/**
 * Attempt to initialize the MuseSDK native library.
 * STUB: Always returns false. Native SDK disabled to avoid Gatekeeper blocking.
 */
export function initMuseSdk(): boolean {
  console.log('[musehub] Native SDK disabled — MuseHub integration not active');
  return false;
}

/**
 * Get the MuseHub user info.
 * STUB: Always returns null.
 */
export function getMuseHubUserInfo(): MuseHubUserInfo | null {
  return null;
}

/**
 * Finalize the MuseSDK session.
 * STUB: No-op.
 */
export function finalizeMuseSdk(): void {
  // No-op
}

/**
 * Check if this is a MuseHub session.
 * STUB: Always returns false.
 */
export function isMuseHubSession(): boolean {
  return false;
}

// ─── Backend Communication ───────────────────────────────────────────────────

const WAVI_API_BASE = process.env.WAVI_API_BASE_URL || 'https://wavi.stream';

/**
 * Register/retrieve the entitlement for this MuseHub session.
 * STUB: Always returns null (not a MuseHub session).
 */
export async function startMuseHubSession(_store: Store): Promise<MuseHubSessionResult | null> {
  return null;
}

/**
 * Check + increment usage before an AI Mix action.
 * STUB: Always allows (non-MuseHub sessions use Stripe/Privy billing).
 */
export async function checkAndIncrementUsage(_store: Store): Promise<MuseHubUsageResult> {
  // Non-MuseHub sessions allow unconditionally (existing Stripe/Privy flow)
  return { allowed: true, remaining: Infinity, limit: Infinity, used: 0 };
}

/**
 * Get the cached entitlement from the local store.
 * STUB: Always returns null.
 */
export function getCachedEntitlement(_store: Store): MuseHubEntitlement | null {
  return null;
}
