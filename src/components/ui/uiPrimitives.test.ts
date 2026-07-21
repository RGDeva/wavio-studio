import { describe, it, expect } from 'vitest';
import { nextTabIndex } from './Tabs';
import { clampPercent, progressTone } from './Progress';

describe('Tabs — roving keyboard model (accessibility)', () => {
  it('ArrowRight/Down advance and wrap', () => {
    expect(nextTabIndex('ArrowRight', 0, 3)).toBe(1);
    expect(nextTabIndex('ArrowDown', 2, 3)).toBe(0); // wrap
  });
  it('ArrowLeft/Up go back and wrap', () => {
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2); // wrap
    expect(nextTabIndex('ArrowUp', 2, 3)).toBe(1);
  });
  it('Home/End jump to ends', () => {
    expect(nextTabIndex('Home', 2, 3)).toBe(0);
    expect(nextTabIndex('End', 0, 3)).toBe(2);
  });
  it('ignores other keys and bad input', () => {
    expect(nextTabIndex('Enter', 0, 3)).toBe(-1);
    expect(nextTabIndex('ArrowRight', 0, 0)).toBe(-1);
    expect(nextTabIndex('ArrowRight', -1, 3)).toBe(-1);
  });
});

describe('Progress — value semantics (not color-only)', () => {
  it('clamps to an integer 0–100', () => {
    expect(clampPercent(-10)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(63.6)).toBe(64);
    expect(clampPercent(NaN)).toBe(0);
  });
  it('tone thresholds', () => {
    expect(progressTone(100)).toBe('bg-success');
    expect(progressTone(75)).toBe('bg-primary');
    expect(progressTone(20)).toBe('bg-warning');
  });
});
