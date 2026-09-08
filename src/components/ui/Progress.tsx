import { cn } from '../../lib/utils';

/**
 * Progress — package/sync completeness bar (P3-1c). Communicates value with BOTH
 * a numeric label and the bar (never color alone). Accessible progressbar role.
 */
export interface ProgressProps {
  value: number; // 0–100
  label?: string;
  showValue?: boolean;
  className?: string;
}

/** Pure, unit-testable clamp to an integer 0–100. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function progressTone(pct: number): string {
  return pct >= 100 ? 'bg-success' : pct >= 60 ? 'bg-primary' : 'bg-warning';
}

export function Progress({ value, label, showValue = true, className }: ProgressProps) {
  const pct = clampPercent(value);
  const tone = progressTone(pct);
  return (
    <div className={cn('space-y-1', className)}>
      {(label || showValue) && (
        <div className="flex items-center justify-between text-meta">
          {label && <span className="text-muted-fg">{label}</span>}
          {showValue && <span className="text-foreground/70 font-mono tabular-nums">{pct}%</span>}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'Progress'}
        className="h-1.5 rounded-full bg-layer-3 overflow-hidden"
      >
        <div className={cn('h-full rounded-full transition-[width] duration-300 ease-out', tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
