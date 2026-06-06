"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.initMuseSdk = initMuseSdk;
exports.getMuseHubUserInfo = getMuseHubUserInfo;
exports.finalizeMuseSdk = finalizeMuseSdk;
exports.isMuseHubSession = isMuseHubSession;
exports.startMuseHubSession = startMuseHubSession;
exports.checkAndIncrementUsage = checkAndIncrementUsage;
exports.getCachedEntitlement = getCachedEntitlement;
// ─── SDK Stub ────────────────────────────────────────────────────────────────
// MuseSDK is a native library (.dylib / .dll) loaded via ffi or a prebuilt
// Node addon. The actual binding depends on the SDK distribution from MuseHub.
// Below is the integration contract — replace the stub with real bindings
// once the MuseSDK native library is available.
let _sdkInitialized = false;
let _cachedUserInfo = null;
/**
 * Attempt to initialize the MuseSDK native library.
 * Returns true if the SDK is available and initialized.
 */
function initMuseSdk() {
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
    }
    catch (err) {
        console.warn('[musehub] SDK init failed:', err?.message ?? err);
        return false;
    }
}
/**
 * Get the MuseHub user info (UUID + optional email).
 * Returns null if SDK was not initialized or user is not logged in.
 */
function getMuseHubUserInfo() {
    if (!_sdkInitialized || !_cachedUserInfo)
        return null;
    // TODO: Replace with actual SDK call
    // const raw = lib.MuseSdk_getUserInfo();
    // return JSON.parse(raw);
    return _cachedUserInfo;
}
/**
 * Finalize the MuseSDK session. Call on app quit.
 */
function finalizeMuseSdk() {
    if (!_sdkInitialized)
        return;
    // TODO: lib.MuseSdk_finalize();
    _sdkInitialized = false;
    console.log('[musehub] SDK finalized');
}
function isMuseHubSession() {
    return _sdkInitialized && _cachedUserInfo !== null;
}
// ─── Backend Communication ───────────────────────────────────────────────────
const WAVI_API_BASE = process.env.WAVI_API_BASE_URL || 'https://wavi.stream';
/**
 * Register/retrieve the entitlement for this MuseHub session.
 * Called once at startup after SDK init succeeds.
 */
async function startMuseHubSession(store) {
    const userInfo = getMuseHubUserInfo();
    if (!userInfo)
        return null;
    try {
        const resp = await fetch(`${WAVI_API_BASE}/api/musehub/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                musehub_uuid: userInfo.uuid,
                email: userInfo.email,
                user_id: store.get('userId', null),
            }),
        });
        if (!resp.ok) {
            console.error('[musehub] session error:', resp.status, await resp.text().catch(() => ''));
            return null;
        }
        const result = await resp.json();
        // Cache entitlement locally
        store.set('musehub_entitlement', result.entitlement);
        store.set('musehub_uuid', userInfo.uuid);
        console.log(`[musehub] session started — status=${result.entitlement.status} limit=${result.entitlement.monthly_mix_limit} used=${result.entitlement.monthly_mixes_used}`);
        return result;
    }
    catch (err) {
        console.error('[musehub] session fetch failed:', err?.message ?? err);
        return null;
    }
}
/**
 * Check + increment usage before an AI Mix action.
 * Returns whether the action is allowed.
 */
async function checkAndIncrementUsage(store) {
    const museUuid = store.get('musehub_uuid', null);
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
        const result = await resp.json();
        // Update cached entitlement
        const cached = store.get('musehub_entitlement', null);
        if (cached) {
            cached.monthly_mixes_used = result.used;
            store.set('musehub_entitlement', cached);
        }
        return result;
    }
    catch (err) {
        console.warn('[musehub] usage check error:', err?.message ?? err);
        return { allowed: true, remaining: -1, limit: -1, used: -1 };
    }
}
/**
 * Get the cached entitlement from the local store (no network call).
 */
function getCachedEntitlement(store) {
    return store.get('musehub_entitlement', null);
}
