import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, FolderOpen, Music2 } from 'lucide-react';
import { api } from '../lib/api';
import { formatBytes } from '../lib/utils';

const FILTERS = ['all','wav','mp3','aiff','mid','flp','als'] as const;
type Filter = typeof FILTERS[number];

export function SearchPage({ visible }: { visible?: boolean }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(false);
  const [dawPaths, setDawPaths] = useState<Record<string, string>>({});
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>|null>(null);

  useEffect(() => { if (visible) setTimeout(() => inputRef.current?.focus(), 80); }, [visible]);

  useEffect(() => {
    api.settings.get('dawPaths').then((d) => { if (d) setDawPaths(d); });
  }, []);

  const runSearch = useCallback(async (q: string, f: Filter) => {
    if (!q.trim()) { setResults([]); return; }
    setLoading(true);
    try {
      const raw = await api.files.search(q);
      setResults(f === 'all' ? raw : raw.filter((r:any) => r.file_type === f));
    } catch { setResults([]); }
    setLoading(false);
  }, []);

  const onChange = (q: string) => {
    setQuery(q);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => runSearch(q, filter), 280);
  };

  const configuredDaws = Object.entries(dawPaths).filter(([, v]) => !!v);

  const ROLE_COLOR: Record<string,string> = {
    master:'text-amber-300',mix:'text-cyan-300',stem:'text-violet-300',
    reference:'text-emerald-300',sample:'text-blue-300',bounce:'text-orange-300',
  };

  return (
    <div className="h-full flex flex-col" onClick={() => setOpenMenuId(null)}>
      <div className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-white/5 space-y-3">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
          <input ref={inputRef} value={query} onChange={e => onChange(e.target.value)}
            placeholder="Search by name, BPM, key, project…"
            className="w-full bg-white/5 border border-white/10 rounded-xl pl-11 pr-10 py-3 text-sm text-white placeholder-white/25 focus:outline-none focus:border-cyan-500/40 transition-all" />
          {query && <button onClick={() => { setQuery(''); setResults([]); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"><X className="w-4 h-4" /></button>}
        </div>
        <div className="flex gap-1.5">
          {FILTERS.map(f => (
            <button key={f} onClick={() => { setFilter(f); runSearch(query, f); }}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-all ${filter===f?'bg-cyan-500/20 text-cyan-300 border-cyan-500/30':'text-white/35 border-white/8 hover:text-white/60'}`}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading && <div className="text-center py-12 text-white/30 text-sm">Searching…</div>}
        {!loading && query && results.length === 0 && <div className="text-center py-12 text-white/25 text-sm">No results for "{query}"</div>}
        {!loading && !query && <div className="text-center py-16 text-white/20 text-sm">Type to search your library</div>}
        <div className="space-y-1">
          {results.map(f => (
            <div key={f.id} className="relative">
              <div className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/3 hover:bg-white/6 border border-white/5 hover:border-white/10 transition-all text-left group">
                {/* Click row to reveal in Finder */}
                <button className="flex-1 min-w-0 text-left" onClick={() => api.shell.revealInFinder(f.file_path)}>
                  <p className="text-sm text-white font-medium truncate">{f.file_name}</p>
                  <p className="text-xs text-white/30 truncate mt-0.5">{f.project_name ?? 'Standalone'} · {f.file_type?.toUpperCase()}</p>
                </button>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {f.bpm && <span className="text-xs text-cyan-400">{f.bpm} BPM</span>}
                  {f.key_note && <span className="text-xs text-purple-400">{f.key_note}</span>}
                  {f.role && f.role !== 'unknown' && <span className={`text-[10px] font-medium ${ROLE_COLOR[f.role]??'text-white/40'}`}>{f.role}</span>}
                  <span className="text-[10px] text-white/25">{formatBytes(f.file_size)}</span>

                  {/* Reveal in Finder button */}
                  <button
                    title="Reveal in Finder"
                    onClick={(e) => { e.stopPropagation(); api.shell.revealInFinder(f.file_path); }}
                    className="p-1 rounded text-white/20 hover:text-white/60 hover:bg-white/5 transition-colors"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                  </button>

                  {/* Open in DAW dropdown */}
                  {configuredDaws.length > 0 && (
                    <div className="relative">
                      <button
                        title="Open in DAW"
                        onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === f.id ? null : f.id); }}
                        className="p-1 rounded text-white/20 hover:text-pink-400 hover:bg-white/5 transition-colors"
                      >
                        <Music2 className="w-3.5 h-3.5" />
                      </button>
                      {openMenuId === f.id && (
                        <div
                          className="absolute right-0 top-7 z-50 min-w-[140px] rounded-xl border border-white/10 bg-[#111] shadow-2xl py-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {configuredDaws.map(([key, appPath]) => (
                            <button
                              key={key}
                              onClick={() => { api.shell.openWithApp(f.file_path, appPath); setOpenMenuId(null); }}
                              className="w-full px-3 py-2 text-left text-xs text-white/70 hover:bg-white/5 hover:text-white transition-colors"
                            >
                              {key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
