/**
 * Centralized API configuration for Wavi Studio desktop.
 *
 * Production default: https://wavi.stream/api
 * Override via WAVI_API_BASE_URL env var (dev/preview only).
 *
 * Safety guard: WAVI_API_BASE_URL=localhost is blocked in production builds
 * (when NODE_ENV === 'production' and app is packaged).
 */

const PRODUCTION_API = 'https://wavi.stream/api';

function resolveApiBase(): string {
  const override = process.env.WAVI_API_BASE_URL;

  if (!override) return PRODUCTION_API;

  // Block localhost overrides in packaged production builds
  const isPackaged = typeof (process as any).defaultApp === 'undefined'
    && process.env.NODE_ENV === 'production';

  if (isPackaged && (override.includes('localhost') || override.includes('127.0.0.1'))) {
    console.warn('[config] WAVI_API_BASE_URL localhost blocked in packaged build — using production');
    return PRODUCTION_API;
  }

  return override.replace(/\/$/, ''); // strip trailing slash
}

export const API_BASE = resolveApiBase();

export const IS_DEV_API = API_BASE !== PRODUCTION_API;

/** Log the connected environment once at startup (dev builds only). */
export function logApiEnvironment() {
  if (IS_DEV_API) {
    console.log(`[config] ⚠ DEV API: ${API_BASE}`);
  }
}
