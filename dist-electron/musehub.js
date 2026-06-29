"use strict";
/**
 * MuseHub SDK Integration Stub
 *
 * The native MuseHub SDK (libMuseClientSdk.*.dylib) is disabled to avoid
 * macOS Gatekeeper blocking. The types are preserved for future integration
 * once the SDK is properly code-signed/notarized.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.initMuseSdk = initMuseSdk;
exports.getMuseHubUserInfo = getMuseHubUserInfo;
exports.finalizeMuseSdk = finalizeMuseSdk;
exports.isMuseHubSession = isMuseHubSession;
exports.startMuseHubSession = startMuseHubSession;
exports.checkAndIncrementUsage = checkAndIncrementUsage;
exports.getCachedEntitlement = getCachedEntitlement;
/**
 * Attempt to initialize the MuseSDK native library.
 * STUB: Always returns false. Native SDK disabled to avoid Gatekeeper blocking.
 */
function initMuseSdk() {
    console.log('[musehub] Native SDK disabled — MuseHub integration not active');
    return false;
}
/**
 * Get the MuseHub user info.
 * STUB: Always returns null.
 */
function getMuseHubUserInfo() {
    return null;
}
/**
 * Finalize the MuseSDK session.
 * STUB: No-op.
 */
function finalizeMuseSdk() {
    // No-op
}
/**
 * Check if this is a MuseHub session.
 * STUB: Always returns false.
 */
function isMuseHubSession() {
    return false;
}
// ─── Backend Communication ───────────────────────────────────────────────────
const WAVI_API_BASE = process.env.WAVI_API_BASE_URL || 'https://wavi.stream';
/**
 * Register/retrieve the entitlement for this MuseHub session.
 * STUB: Always returns null (not a MuseHub session).
 */
async function startMuseHubSession(_store) {
    return null;
}
/**
 * Check + increment usage before an AI Mix action.
 * STUB: Always allows (non-MuseHub sessions use Stripe/Privy billing).
 */
async function checkAndIncrementUsage(_store) {
    // Non-MuseHub sessions allow unconditionally (existing Stripe/Privy flow)
    return { allowed: true, remaining: Infinity, limit: Infinity, used: 0 };
}
/**
 * Get the cached entitlement from the local store.
 * STUB: Always returns null.
 */
function getCachedEntitlement(_store) {
    return null;
}
