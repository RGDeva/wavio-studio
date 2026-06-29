import { useState, useCallback } from 'react';
import { FolderOpen, RefreshCw, UploadCloud, CheckCircle2, AlertCircle, Music2, FileAudio } from 'lucide-react';
import { api } from '../lib/api';
import { formatBytes } from '../lib/utils';

export function AbletonPage({ visible: _visible }: { visible?: boolean }) {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const selectFolder = useCallback(async () => {
    setLoading(true); setResult(null);
    try {
      const r = await api.ableton.selectFolder();
      if (!r.canceled && r.snapshot) { setSnapshot(r.snapshot); setFolderPath(r.folderPath ?? null); }
    } catch {}
    setLoading(false);
  }, []);

  const sync = useCallback(async () => {
    if (!snapshot) return;
    setSyncing(true); setResult(null);
    try {
      const token = await api.auth.getToken();
      if (!token) { setResult({ ok: false, msg: 'Not authenticated — add token in Settings.' }); setSyncing(false); return; }
      const r = await api.ableton.syncToCloud(snapshot, token);
      setResult(r.success ? { ok: true, msg: `Synced! Cloud ID: ${r.cloudProjectId ?? 'created'}` } : { ok: false, msg: r.error ?? 'Sync failed' });
    } catch (e: any) { setResult({ ok: false, msg: e?.message ?? 'Error' }); }
    setSyncing(false);
  }, [snapshot]);

  const ROLE_COLOR: Record<string,string> = { project:'text-cyan-400', audio:'text-amber-300', midi:'text-pink-300', clip:'text-violet-300', preset:'text-emerald-300' };

  return (
    <div className="h-full overflow-y-auto p-6 max-w-2xl mx-auto space-y-6">
      <div><h1 className="text-xl font-bold text-white flex items-center gap-2"><Music2 className="w-5 h-5 text-cyan-400"/>DAW Sync</h1><p className="text-xs text-white/30 mt-0.5">Scan any DAW folder and sync to Wavi cloud</p></div>
      <div className="bg-white/3 border border-white/8 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div><p className="text-sm font-medium text-white">Project Folder</p><p className="text-xs text-white/30 truncate max-w-xs mt-0.5">{folderPath ?? 'No folder selected'}</p></div>
          <button onClick={selectFolder} disabled={loading} className="flex items-center gap-2 px-4 py-2 bg-white/8 hover:bg-white/12 border border-white/10 rounded-xl text-sm text-white/70 hover:text-white transition-all disabled:opacity-40">
            {loading ? <RefreshCw className="w-4 h-4 animate-spin"/> : <FolderOpen className="w-4 h-4"/>}
            {loading ? 'Scanning…' : 'Select Folder'}
          </button>
        </div>
        {snapshot && (
          <div className="border-t border-white/5 pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <div><p className="text-base font-semibold text-white">{snapshot.sessionName}</p><p className="text-xs text-white/40">{snapshot.source}</p></div>
              <div className="flex gap-4">
                {snapshot.bpm > 0 && <div className="text-right"><p className="text-lg font-bold text-cyan-400">{snapshot.bpm}</p><p className="text-[10px] text-white/30">BPM</p></div>}
                <div className="text-right"><p className="text-lg font-bold text-white">{snapshot.detectedFiles?.length ?? 0}</p><p className="text-[10px] text-white/30">Files</p></div>
              </div>
            </div>
            <div className="space-y-1 max-h-52 overflow-y-auto">
              {(snapshot.detectedFiles ?? []).map((f: any, i: number) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/3">
                  <FileAudio className="w-3.5 h-3.5 text-white/25 flex-shrink-0"/>
                  <span className="flex-1 text-xs text-white/70 truncate">{f.name}</span>
                  <span className={`text-[10px] font-medium ${ROLE_COLOR[f.role]??'text-white/30'}`}>{f.role}</span>
                  <span className="text-[10px] text-white/25">{formatBytes(f.size)}</span>
                </div>
              ))}
            </div>
            <button onClick={sync} disabled={syncing} className="w-full flex items-center justify-center gap-2 py-2.5 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/30 rounded-xl text-sm text-cyan-300 font-medium transition-all disabled:opacity-40">
              {syncing ? <RefreshCw className="w-4 h-4 animate-spin"/> : <UploadCloud className="w-4 h-4"/>}
              {syncing ? 'Syncing…' : 'Sync to Wavi Cloud'}
            </button>
          </div>
        )}
      </div>
      {result && (
        <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm ${result.ok ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-300'}`}>
          {result.ok ? <CheckCircle2 className="w-4 h-4 flex-shrink-0"/> : <AlertCircle className="w-4 h-4 flex-shrink-0"/>}
          {result.msg}
        </div>
      )}
    </div>
  );
}
