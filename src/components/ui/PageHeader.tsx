import { cn } from '../../lib/utils';

/**
 * PageHeader — consistent top-level page header (P3-1b).
 * Compact desktop spacing. Title uses the brand font selectively; body/controls
 * stay on the dense sans stack.
 */
export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, status, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex items-start justify-between gap-4 px-5 pt-4 pb-3', className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1 className="font-brand text-lg font-bold text-foreground truncate">{title}</h1>
          {status}
        </div>
        {subtitle && <p className="text-xs text-muted-fg mt-0.5 truncate">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </header>
  );
}
