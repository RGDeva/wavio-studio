import { useState, useEffect, useCallback } from 'react';
import { FolderPlus, Trash2, FolderOpen, ExternalLink, Sparkles, Plus, Check } from 'lucide-react';
import { api } from '../lib/api';
import { DawLogo } from '../components/DawLogo';

const DAW_FOLDER_HINTS: Record<string, string> = {
  'FL Studio': 'Image-Line/FL Studio',
  'Pro Tools': 'Pro Tools',
  'Ableton': 'Ableton',
  'Logic': 'Logic',
  'Reaper': 'REAPER Media',
  'GarageBand': 'GarageBand',
  'Cubase': 'Cubase Projects',
  'Studio One': 'Studio One',
};

function guessDaw(folderPath: string): string {
  const lower = folderPath.toLowerCase();
  if (lower.includes('fl studio') || lower.includes('image-line')) return 'FL Studio';
  if (lower.includes('pro tools')) return 'Pro Tools';
  if (lower.includes('ableton')) return 'Ableton Live';
  if (lower.includes('logic')) return 'Logic Pro';
  if (lower.includes('reaper')) return 'Reaper';
  if (lower.includes('garageband')) return 'GarageBand';
  if (lower.includes('cubase')) return 'Cubase';
  if (lower.includes('studio one')) return 'Studio One';
  return 'Unknown';
}

export function FoldersPage() {
  const [folders, setFolders] = useState<string[]>([]);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [addingPath, setAddingPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [f, d] = await Promise.all([
      api.folders.getAll(),
      api.folders.discover(),
    ]);
    setFolders(f);
    setDiscovered(d);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleAdd = async () => {
    setAdding(true);
    try {
      const result = await api.folders.add();
      if (result) await refresh();
    } finally {
      setAdding(false);
    }
  };

  const handleAddPath = async (folderPath: string) => {
    setAddingPath(folderPath);
    try {
      await api.folders.addPath(folderPath);
      await refresh();
    } finally {
      setAddingPath(null);
    }
  };

  const handleRemove = async (folder: string) => {
    await api.folders.remove(folder);
    await refresh();
  };

  const unaddedDiscovered = discovered.filter(d => !folders.includes(d));

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-3xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">Connected Folders</h1>
            <p className="text-xs text-white/30 mt-0.5">
              Wavi Studio watches these folders for DAW project files and audio assets
            </p>
          </div>
          <button
            onClick={handleAdd}
            disabled={adding}
            className="flex items-center gap-2 px-4 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-black text-sm font-semibold rounded-lg transition-colors"
          >
            <FolderPlus className="w-4 h-4" />
            {adding ? 'Selecting…' : 'Browse…'}
          </button>
        </div>

        {/* Auto-discovered folders */}
        {unaddedDiscovered.length > 0 && (
          <div className="bg-[#0d1117] border border-cyan-500/20 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-cyan-400" />
              <p className="text-sm font-semibold text-white/80">DAW folders found on your Mac</p>
              <span className="ml-auto text-[10px] text-white/30">click to add</span>
            </div>
            <div className="space-y-2">
              {unaddedDiscovered.map((folder) => {
                const daw = guessDaw(folder);
                const isAdding = addingPath === folder;
                return (
                  <div
                    key={folder}
                    className="flex items-center gap-3 bg-black/30 rounded-lg px-3 py-2.5 group"
                  >
                    <DawLogo daw={daw} size={28} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-white/70 truncate">{folder.split('/').pop()}</p>
                      <p className="text-[10px] text-white/20 font-mono truncate">{folder}</p>
                    </div>
                    <button
                      onClick={() => handleAddPath(folder)}
                      disabled={isAdding}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 text-xs font-semibold transition-colors disabled:opacity-50 flex-shrink-0"
                    >
                      <Plus className="w-3 h-3" />
                      {isAdding ? 'Adding…' : 'Add'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Watched folders */}
        {folders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <FolderOpen className="w-12 h-12 text-white/10 mb-4" />
            <p className="text-sm text-white/30">No folders connected</p>
            <p className="text-xs text-white/20 mt-1 max-w-xs">
              {unaddedDiscovered.length > 0
                ? 'Add one of the detected folders above, or click Browse to pick any folder.'
                : 'Click Browse to select a folder containing your DAW projects.'}
            </p>
          </div>
        ) : (
          <>
            <p className="text-xs font-semibold text-white/30 uppercase tracking-wider">Watching</p>
            <div className="space-y-2">
              {folders.map((folder) => {
                const daw = guessDaw(folder);
                return (
                  <div
                    key={folder}
                    className="flex items-center gap-3 bg-[#111] border border-[#1a1a1a] hover:border-[#2a2a2a] rounded-xl p-4 group transition-colors"
                  >
                    <DawLogo daw={daw} size={32} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white/80 truncate">
                        {folder.split('/').pop() || folder}
                      </p>
                      <p className="text-xs text-white/20 font-mono truncate">{folder}</p>
                    </div>
                    <div className="flex items-center gap-1.5 mr-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      <span className="text-[10px] text-white/30">Watching</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => api.shell.openPath(folder)}
                        className="p-1.5 rounded-lg hover:bg-white/5 text-white/30 hover:text-white/60 transition-colors"
                        title="Open in Finder"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleRemove(folder)}
                        className="p-1.5 rounded-lg hover:bg-red-500/10 text-white/30 hover:text-red-400 transition-colors"
                        title="Stop watching"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Supported file types */}
        <div className="bg-[#111] border border-[#1a1a1a] rounded-xl p-4">
          <p className="text-xs text-white/40 mb-2 font-medium">Tracked file types</p>
          <div className="flex flex-wrap gap-2">
            {[
              { ext: '.als', label: 'Ableton' },
              { ext: '.flp', label: 'FL Studio' },
              { ext: '.logic', label: 'Logic Pro' },
              { ext: '.ptx', label: 'Pro Tools' },
              { ext: '.rpp', label: 'Reaper' },
              { ext: '.wav', label: 'WAV' },
              { ext: '.aiff', label: 'AIFF' },
              { ext: '.mp3', label: 'MP3' },
              { ext: '.flac', label: 'FLAC' },
              { ext: '.mid', label: 'MIDI' },
              { ext: '.stems', label: 'Stems' },
            ].map(({ ext, label }) => (
              <span key={ext} className="px-2 py-1 text-[10px] font-mono bg-white/5 text-white/40 rounded border border-white/5">
                {ext} <span className="text-white/20">{label}</span>
              </span>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
