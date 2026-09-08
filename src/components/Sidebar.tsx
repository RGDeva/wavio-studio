import { LayoutDashboard, Link2, Music, FolderOpen, Activity, Settings, Zap, SlidersHorizontal, Wand2, Search, Music2, Stethoscope } from 'lucide-react';
import { cn } from '../lib/utils';
import { api } from '../lib/api';
import type { Page } from '../types';

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  pendingAssociations?: number;
}

const NAV_ITEMS: { id: Page; label: string; icon: React.FC<{ className?: string }> }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'studio', label: 'Studio Sync', icon: SlidersHorizontal },
  { id: 'ableton', label: 'DAW Sync', icon: Music2 },
  { id: 'library', label: 'Library', icon: Music },
  { id: 'links', label: 'Links', icon: Link2 },
  { id: 'folders', label: 'Folders', icon: FolderOpen },
  { id: 'review', label: 'File Review', icon: Wand2 },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'diagnostics', label: 'Diagnostics', icon: Stethoscope },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const navBtn =
  'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-fast ease-out ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background';

export function Sidebar({ currentPage, onNavigate, pendingAssociations = 0 }: SidebarProps) {
  return (
    <nav aria-label="Primary" className="w-52 flex-shrink-0 bg-background border-r border-border flex flex-col py-4">
      <div className="flex-1 px-2 space-y-0.5">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const active = currentPage === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onNavigate(id)}
              aria-current={active ? 'page' : undefined}
              className={cn(navBtn, active ? 'bg-layer-3 text-foreground' : 'text-fg-quaternary hover:text-fg-secondary hover:bg-layer-2')}
            >
              <Icon className={cn('w-4 h-4 shrink-0', active ? 'text-primary' : '')} />
              {label}
              {id === 'review' && pendingAssociations > 0 && (
                <span className="ml-auto flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-meta font-bold">
                  {pendingAssociations > 99 ? '99+' : pendingAssociations}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={() => api.copilot.toggle()}
          className={cn(navBtn, 'bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 hover:border-primary/40')}
        >
          <Zap className="w-4 h-4 shrink-0" />
          Copilot
          <span className="ml-auto text-meta text-fg-quaternary">⌘⇧W</span>
        </button>
      </div>
      <div className="px-4 pt-3 pb-2 border-t border-border">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-success motion-safe:animate-pulse" />
          <span className="text-xs text-muted-fg">Agent running</span>
        </div>
      </div>
    </nav>
  );
}
