/**
 * Gate for the development-only UI preview harness (P3-1b).
 *
 * Pure + unit-testable (no import.meta access here). The caller passes the
 * build-time `dev` flag (`import.meta.env.DEV`) and the current URL search. The
 * harness activates ONLY when the build is a development build AND the operator
 * explicitly opts in with `?ui-preview` (or `?ui-preview=1`).
 *
 * In a production build `dev` is statically false, so this returns false and the
 * harness never activates — and because callers guard the harness import with
 * the same `import.meta.env.DEV` constant, the harness code is dead-code
 * eliminated from production bundles entirely.
 */
export interface PreviewEnv {
  /** import.meta.env.DEV at the call site. */
  dev: boolean;
}

export function isUiPreviewEnabled(env: PreviewEnv, search: string): boolean {
  if (!env || env.dev !== true) return false; // never active outside a dev build
  try {
    return new URLSearchParams(search ?? '').has('ui-preview');
  } catch {
    return false;
  }
}
