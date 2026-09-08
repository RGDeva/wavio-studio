import { useRef } from 'react';
import { cn } from '../../lib/utils';

/**
 * Tabs — accessible tablist (P3-1c). Roving tabindex + arrow-key navigation,
 * role=tab/tablist, aria-selected. The caller renders the tabpanel(s) and should
 * give the active panel role="tabpanel" + aria-labelledby={`tab-${value}`}.
 */
export interface TabItem { id: string; label: string; }

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onValueChange: (id: string) => void;
  className?: string;
}

/**
 * Pure roving-tabindex keyboard model (unit-testable without a DOM):
 * returns the next focused tab index for a key, or -1 to ignore the key.
 */
export function nextTabIndex(key: string, current: number, length: number): number {
  if (length <= 0 || current < 0) return -1;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % length;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + length) % length;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  return -1;
}

export function Tabs({ tabs, value, onValueChange, className }: TabsProps) {
  const ref = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === value);
    const next = nextTabIndex(e.key, i, tabs.length);
    if (next < 0) return;
    e.preventDefault();
    onValueChange(tabs[next].id);
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div ref={ref} role="tablist" aria-label="Project sections" onKeyDown={onKeyDown}
      className={cn('flex border-b border-border overflow-x-auto', className)}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onValueChange(t.id)}
            className={cn(
              'px-3.5 py-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-fast ease-out',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
              active ? 'text-primary border-b-2 border-primary -mb-px' : 'text-fg-quaternary hover:text-fg-secondary border-b-2 border-transparent',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
