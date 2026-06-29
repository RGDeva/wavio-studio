import { LayoutDashboard, Music, FolderOpen, Activity, Settings, Zap, SlidersHorizontal, Wand2, Search, Music2, Stethoscope } from 'lucide-react';
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
  { id: 'folders', label: 'Folders', icon: FolderOpen },
  { id: 'review', label: 'File Review', icon: Wand2 },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'diagnostics', label: 'Diagnostics', icon: Stethoscope },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar({ currentPage, onNavigate, pendingAssociations = 0 }: SidebarProps) {
  return (
    <div className="w-52 flex-shrink-0 bg-black border-r border-[#1a1a1a] flex flex-col py-4">
      <nav className="flex-1 px-2 space-y-0.5">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all',
              currentPage === id
                ? 'bg-white/8 text-white'
                : 'text-white/40 hover:text-white/70 hover:bg-white/4'
            )}
          >
            <Icon className={cn('w-4 h-4', currentPage === id ? 'text-primary' : '')} />
            {label}
            {id === 'review' && pendingAssociations > 0 && (
              <span className="ml-auto flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-cyan-500 text-black text-[10px] font-bold">
                {pendingAssociations > 99 ? '99+' : pendingAssociations}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="px-2 pb-2">
        <button
          onClick={() => api.copilot.toggle()}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 hover:border-cyan-500/40"
        >
          <Zap className="w-4 h-4" />
          Copilot
          <span className="ml-auto text-[10px] text-white/25">⌘⇧W</span>
        </button>
      </div>
      <div className="px-4 pt-3 pb-2 border-t border-[#1a1a1a]">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-xs text-white/30">Agent running</span>
        </div>
      </div>
    </div>
  );
}
