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
const PRODUCTION_WEB = 'https://wavi.stream';

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

/**
 * Public web origin for share links and external navigation.
 * Set WAVI_PUBLIC_URL env var in dev/preview to point at the preview domain.
 * Production default: https://wavi.stream
 */
export const WEB_BASE: string = (() => {
  const override = process.env.WAVI_PUBLIC_URL;
  if (override) return override.replace(/\/$/, '');
  // If API base is overridden to a non-production URL, derive web base from it
  // by stripping the /api suffix (only when the host matches the API host).
  if (IS_DEV_API) {
    const stripped = API_BASE.replace(/\/api$/, '');
    if (stripped !== API_BASE) return stripped;
  }
  return PRODUCTION_WEB;
})();

/** Log the connected environment once at startup (dev builds only). */
export function logApiEnvironment() {
  if (IS_DEV_API) {
    console.log(`[config] ⚠ DEV API: ${API_BASE}`);
  }
}

// ── Build channel ─────────────────────────────────────────────────────────────
// Determines the deep-link protocol scheme, app bundle identity, and which
// auth `channel=` param is sent to the web Auth page. Derived from already-
// validated signals (packaged state + API override) rather than a free-form
// env var, so it can't be spoofed by setting an arbitrary string.
import { resolveChannel, PROTOCOL_SCHEMES, BUNDLE_IDS, type WaviChannel } from './deepLinkValidator';
export type { WaviChannel };

export const CHANNEL: WaviChannel = (() => {
  // Lazy require to avoid pulling electron into non-main-process contexts.
  const { app } = require('electron');
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  return resolveChannel({ isDev, isDevApi: IS_DEV_API });
})();

export const PROTOCOL_SCHEME = PROTOCOL_SCHEMES[CHANNEL];
export const BUNDLE_ID = BUNDLE_IDS[CHANNEL];

/** Returns the desktop auth URL for this channel, including the channel param the web Auth page uses to pick the correct callback scheme. */
export function getAuthUrl(): string {
  return `${WEB_BASE}/auth?desktop=1&channel=${CHANNEL}`;
}
