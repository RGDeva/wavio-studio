import { LayoutDashboard, Music, FolderOpen, Activity, Settings } from 'lucide-react';
import { cn } from '../lib/utils';
import type { Page } from '../types';

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

const NAV_ITEMS: { id: Page; label: string; icon: React.FC<{ className?: string }> }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'library', label: 'Library', icon: Music },
  { id: 'folders', label: 'Folders', icon: FolderOpen },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar({ currentPage, onNavigate }: SidebarProps) {
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
          </button>
        ))}
      </nav>

      <div className="px-4 pt-4 border-t border-[#1a1a1a]">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-xs text-white/30">Agent running</span>
        </div>
      </div>
    </div>
  );
}
