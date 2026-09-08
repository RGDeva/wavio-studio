import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * EmptyState — clear, non-decorative empty surface (P3-1b).
 * Title + one-sentence explanation + optional primary/secondary actions. No
 * mandatory illustration; a small optional icon only.
 */
export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon: Icon, action, secondaryAction, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center gap-3 py-12 px-6', className)}>
      {Icon && (
        <div className="w-9 h-9 rounded-lg bg-layer-2 border border-border flex items-center justify-center">
          <Icon className="w-4 h-4 text-muted-fg" />
        </div>
      )}
      <div className="max-w-sm">
        <p className="text-sm font-semibold text-foreground/85">{title}</p>
        {description && <p className="text-xs text-muted-fg mt-1 leading-relaxed">{description}</p>}
      </div>
      {(action || secondaryAction) && (
        <div className="flex items-center gap-2 mt-1">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
