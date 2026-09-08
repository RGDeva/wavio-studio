import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

/**
 * Surface — intentional container primitive (P3-1b).
 *
 * NOT an automatic card: use it deliberately. `base` is a quiet panel, `inset`
 * recedes, `elevated` lifts with a restrained shadow, `interactive` adds hover +
 * focus affordances for clickable surfaces.
 */
export type SurfaceVariant = 'base' | 'elevated' | 'inset' | 'interactive';

export interface SurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: SurfaceVariant;
}

const VARIANTS: Record<SurfaceVariant, string> = {
  base: 'bg-surface-2 border border-border',
  elevated: 'bg-surface-2 border border-border shadow',
  inset: 'bg-background border border-border-subtle',
  interactive: 'bg-surface-2 border border-border hover:border-hairline-strong hover:bg-layer-1 transition-colors duration-fast ease-out',
};

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { variant = 'base', className, ...props },
  ref,
) {
  return <div ref={ref} className={cn('rounded-lg', VARIANTS[variant], className)} {...props} />;
});
