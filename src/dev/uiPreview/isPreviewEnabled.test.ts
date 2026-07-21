import { describe, it, expect } from 'vitest';
import { isUiPreviewEnabled } from './isPreviewEnabled';

describe('isUiPreviewEnabled — production cannot activate the preview harness', () => {
  it('is DISABLED in a production build even with the opt-in flag', () => {
    expect(isUiPreviewEnabled({ dev: false }, '?ui-preview')).toBe(false);
    expect(isUiPreviewEnabled({ dev: false }, '?ui-preview=1')).toBe(false);
    expect(isUiPreviewEnabled({ dev: false }, '')).toBe(false);
  });

  it('requires BOTH a dev build AND explicit opt-in', () => {
    expect(isUiPreviewEnabled({ dev: true }, '')).toBe(false);        // dev but no opt-in
    expect(isUiPreviewEnabled({ dev: true }, '?other=1')).toBe(false);
    expect(isUiPreviewEnabled({ dev: true }, '?ui-preview')).toBe(true);
    expect(isUiPreviewEnabled({ dev: true }, '?ui-preview=1')).toBe(true);
  });

  it('is defensive against bad input', () => {
    // @ts-expect-error intentional bad env
    expect(isUiPreviewEnabled(null, '?ui-preview')).toBe(false);
    // @ts-expect-error intentional bad env
    expect(isUiPreviewEnabled(undefined, '?ui-preview')).toBe(false);
  });
});
