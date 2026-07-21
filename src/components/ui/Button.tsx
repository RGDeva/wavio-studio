import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Button — first shared desktop primitive (P3-1a).
 *
 * Restrained, operational styling on the design tokens. No gradients, glow,
 * glass, or oversized pills. Native <button> for full keyboard accessibility;
 * a visible focus-visible ring; consistent icon spacing; explicit loading and
 * disabled states.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'outline';
export type ButtonSize = 'default' | 'compact' | 'icon';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-white/10 active:bg-white/[0.06]',
  ghost: 'bg-transparent text-white/70 hover:bg-white/[0.06] hover:text-white/90',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80',
  outline: 'bg-transparent text-white/80 border border-border hover:bg-white/[0.04] hover:border-white/20',
};

const SIZES: Record<ButtonSize, string> = {
  default: 'h-8 px-3 text-xs gap-1.5',
  compact: 'h-7 px-2.5 text-[11px] gap-1',
  icon: 'h-8 w-8 p-0 justify-center',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'default', loading = false, disabled, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap select-none',
        'transition-colors duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        'disabled:opacity-40 disabled:pointer-events-none',
        '[&_svg]:w-3.5 [&_svg]:h-3.5 [&_svg]:shrink-0',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
});
