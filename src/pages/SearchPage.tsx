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
    master:'text-warning',mix:'text-primary',stem:'text-accent',
    reference:'text-success',sample:'text-info',bounce:'text-warning',
  };

  return (
    <div className="h-full flex flex-col" onClick={() => setOpenMenuId(null)}>
      <div className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-hairline space-y-3">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-quaternary pointer-events-none" />
          <input ref={inputRef} value={query} onChange={e => onChange(e.target.value)}
            placeholder="Search by name, BPM, key, project…"
            className="w-full bg-layer-2 border border-hairline-strong rounded-xl pl-11 pr-10 py-3 text-sm text-white placeholder-white/25 focus:outline-none focus:border-primary/40 transition-all" />
          {query && <button onClick={() => { setQuery(''); setResults([]); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-quaternary hover:text-fg-tertiary"><X className="w-4 h-4" /></button>}
        </div>
        <div className="flex gap-1.5">
          {FILTERS.map(f => (
            <button key={f} onClick={() => { setFilter(f); runSearch(query, f); }}
              className={`px-2.5 py-1 rounded-lg text-meta font-medium border transition-all ${filter===f?'bg-primary/20 text-primary border-primary/30':'text-fg-quaternary border-hairline-strong hover:text-fg-tertiary'}`}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading && <div className="text-center py-12 text-fg-quaternary text-sm">Searching…</div>}
        {!loading && query && results.length === 0 && <div className="text-center py-12 text-fg-quaternary text-sm">No results for "{query}"</div>}
        {!loading && !query && <div className="text-center py-16 text-fg-quaternary text-sm">Type to search your library</div>}
        <div className="space-y-1">
          {results.map(f => (
            <div key={f.id} className="relative">
              <div className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-layer-1 hover:bg-layer-3 border border-hairline hover:border-hairline-strong transition-all text-left group">
                {/* Click row to reveal in Finder */}
                <button className="flex-1 min-w-0 text-left" onClick={() => api.shell.revealInFinder(f.file_path)}>
                  <p className="text-sm text-white font-medium truncate">{f.file_name}</p>
                  <p className="text-xs text-fg-quaternary truncate mt-0.5">{f.project_name ?? 'Standalone'} · {f.file_type?.toUpperCase()}</p>
                </button>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {f.bpm && <span className="text-xs text-primary">{f.bpm} BPM</span>}
                  {f.key_note && <span className="text-xs text-accent">{f.key_note}</span>}
                  {f.role && f.role !== 'unknown' && <span className={`text-meta font-medium ${ROLE_COLOR[f.role]??'text-fg-quaternary'}`}>{f.role}</span>}
                  <span className="text-meta text-fg-quaternary">{formatBytes(f.file_size)}</span>

                  {/* Reveal in Finder button */}
                  <button
                    title="Reveal in Finder"
                    onClick={(e) => { e.stopPropagation(); api.shell.revealInFinder(f.file_path); }}
                    className="p-1 rounded text-fg-quaternary hover:text-fg-tertiary hover:bg-layer-2 transition-colors"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                  </button>

                  {/* Open in DAW dropdown */}
                  {configuredDaws.length > 0 && (
                    <div className="relative">
                      <button
                        title="Open in DAW"
                        onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === f.id ? null : f.id); }}
                        className="p-1 rounded text-fg-quaternary hover:text-pink-400 hover:bg-layer-2 transition-colors"
                      >
                        <Music2 className="w-3.5 h-3.5" />
                      </button>
                      {openMenuId === f.id && (
                        <div
                          className="absolute right-0 top-7 z-50 min-w-[140px] rounded-xl border border-hairline-strong bg-[#111] shadow-2xl py-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {configuredDaws.map(([key, appPath]) => (
                            <button
                              key={key}
                              onClick={() => { api.shell.openWithApp(f.file_path, appPath); setOpenMenuId(null); }}
                              className="w-full px-3 py-2 text-left text-xs text-fg-secondary hover:bg-layer-2 hover:text-white transition-colors"
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
