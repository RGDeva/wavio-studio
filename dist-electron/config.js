"use strict";
/**
 * Centralized API configuration for Wavi Studio desktop.
 *
 * Production default: https://wavi.stream/api
 * Override via WAVI_API_BASE_URL env var (dev/preview only).
 *
 * Safety guard: WAVI_API_BASE_URL=localhost is blocked in production builds
 * (when NODE_ENV === 'production' and app is packaged).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEB_BASE = exports.IS_DEV_API = exports.API_BASE = void 0;
exports.logApiEnvironment = logApiEnvironment;
const PRODUCTION_API = 'https://wavi.stream/api';
const PRODUCTION_WEB = 'https://wavi.stream';
function resolveApiBase() {
    const override = process.env.WAVI_API_BASE_URL;
    if (!override)
        return PRODUCTION_API;
    // Block localhost overrides in packaged production builds
    const isPackaged = typeof process.defaultApp === 'undefined'
        && process.env.NODE_ENV === 'production';
    if (isPackaged && (override.includes('localhost') || override.includes('127.0.0.1'))) {
        console.warn('[config] WAVI_API_BASE_URL localhost blocked in packaged build — using production');
        return PRODUCTION_API;
    }
    return override.replace(/\/$/, ''); // strip trailing slash
}
exports.API_BASE = resolveApiBase();
exports.IS_DEV_API = exports.API_BASE !== PRODUCTION_API;
/**
 * Public web origin for share links and external navigation.
 * Set WAVI_PUBLIC_URL env var in dev/preview to point at the preview domain.
 * Production default: https://wavi.stream
 */
exports.WEB_BASE = (() => {
    const override = process.env.WAVI_PUBLIC_URL;
    if (override)
        return override.replace(/\/$/, '');
    // If API base is overridden to a non-production URL, derive web base from it
    // by stripping the /api suffix (only when the host matches the API host).
    if (exports.IS_DEV_API) {
        const stripped = exports.API_BASE.replace(/\/api$/, '');
        if (stripped !== exports.API_BASE)
            return stripped;
    }
    return PRODUCTION_WEB;
})();
/** Log the connected environment once at startup (dev builds only). */
function logApiEnvironment() {
    if (exports.IS_DEV_API) {
        console.log(`[config] ⚠ DEV API: ${exports.API_BASE}`);
    }
}
