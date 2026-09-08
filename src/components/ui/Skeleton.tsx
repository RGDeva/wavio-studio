import { cn } from '../../lib/utils';

/**
 * Skeleton — restrained loading placeholder (P3-1b).
 * Respects `prefers-reduced-motion` (pulse disabled). Decorative only, so it is
 * aria-hidden; announce loading via an adjacent live region if needed.
 */
export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Convenience: render N stacked lines. */
  lines?: number;
}

export function Skeleton({ lines, className, ...props }: SkeletonProps) {
  const base = 'rounded bg-layer-3 motion-safe:animate-pulse';
  if (lines && lines > 1) {
    return (
      <div className="space-y-2" aria-hidden {...props}>
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className={cn(base, 'h-3', i === lines - 1 && 'w-2/3', className)} />
        ))}
      </div>
    );
  }
  return <div aria-hidden className={cn(base, 'h-4', className)} {...props} />;
}
