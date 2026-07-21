import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './Button';
import { cn } from '../../lib/utils';

/**
 * ErrorState — clear failure surface (P3-1b).
 * Description + retry + optional collapsible technical detail. The detail is for
 * a message/stack only; callers must not pass secrets or raw local paths.
 */
export interface ErrorStateProps {
  title?: string;
  description?: string;
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  detail,
  onRetry,
  retryLabel = 'Try again',
  className,
}: ErrorStateProps) {
  const [showDetail, setShowDetail] = useState(false);
  return (
    <div className={cn('flex flex-col items-center justify-center text-center gap-3 py-12 px-6', className)} role="alert">
      <div className="w-9 h-9 rounded-lg bg-destructive/10 border border-destructive/20 flex items-center justify-center">
        <AlertTriangle className="w-4 h-4 text-destructive" />
      </div>
      <div className="max-w-md">
        <p className="text-sm font-semibold text-foreground/85">{title}</p>
        {description && <p className="text-xs text-muted-fg mt-1 leading-relaxed">{description}</p>}
      </div>
      <div className="flex items-center gap-2 mt-1">
        {onRetry && <Button variant="secondary" size="compact" onClick={onRetry}>{retryLabel}</Button>}
        {detail && (
          <Button variant="ghost" size="compact" onClick={() => setShowDetail((v) => !v)} aria-expanded={showDetail}>
            {showDetail ? 'Hide details' : 'Details'}
          </Button>
        )}
      </div>
      {showDetail && detail && (
        <pre className="mt-1 max-w-md max-h-32 overflow-auto rounded bg-black/40 border border-border px-3 py-2 text-[11px] text-muted-fg font-mono text-left break-all whitespace-pre-wrap">
          {detail}
        </pre>
      )}
    </div>
  );
}
