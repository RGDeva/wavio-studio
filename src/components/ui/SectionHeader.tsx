import { cn } from '../../lib/utils';

/**
 * SectionHeader — compact labelled divider inside a workspace section (P3-1c).
 * Restrained uppercase label + optional count and trailing action.
 */
export interface SectionHeaderProps {
  label: string;
  count?: number | string;
  action?: React.ReactNode;
  className?: string;
}

export function SectionHeader({ label, count, action, className }: SectionHeaderProps) {
  return (
    <div className={cn('flex items-center gap-2 mb-2', className)}>
      <h3 className="text-[11px] font-semibold text-white/50 uppercase tracking-wider">{label}</h3>
      {count !== undefined && <span className="text-[10px] text-muted-fg font-mono">{count}</span>}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}
