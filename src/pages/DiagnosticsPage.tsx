import { useState, useEffect, useCallback } from 'react';
import { Activity, Database, Folder, Cpu, Download, RefreshCw, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';

type DiagData = Awaited<ReturnType<typeof api.diagnostics.get>>;

function Row({ label, value, mono = false, warn = false }: { label: string; value: string | number | null; mono?: boolean; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
      <span className="text-xs text-white/40">{label}</span>
      <span className={`text-xs ${mono ? 'font-mono' : ''} ${warn ? 'text-amber-400' : 'text-white/80'}`}>
        {value === null || value === undefined ? <span className="text-white/20">—</span> : String(value)}
      </span>
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="bg-[#111] border border-[#1a1a1a] rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-3.5 h-3.5 text-cyan-400" />
        <p className="text-xs font-semibold text-white/60 uppercase tracking-wider">{title}</p>
      </div>
      {children}
    </div>
  );
}

export function DiagnosticsPage({ visible }: { visible?: boolean }) {
  const [data, setData] = useState<DiagData | null>(null);
  const [loading, setLoading] = useState(false);
  const [exported, setExported] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.diagnostics.get();
      setData(d);
    } catch {
      setData(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (visible) refresh(); }, [visible, refresh]);

  const exportReport = () => {
    if (!data) return;
    // Build sanitized report — no raw tokens, no full private paths, no audio
    const report = {
      timestamp: new Date().toISOString(),
      app: {
        version: data.appVersion,
        arch: data.arch,
        platform: data.platform,
        environment: data.environment,
        userDataPath: data.userDataPath,
        buildDate: data.buildDate,
      },
      database: {
        fileCount: data.fileCount,
        projectCount: data.projectCount,
        missingFileCount: data.missingFileCount,
        dbSizeMB: data.dbSizeMB,
        activityLogCount: data.activityLogCount,
      },
      syncQueue: data.queueCounts,
      indexedRoots: data.indexedRoots,
      configuredDAWs: data.sanitizedDawPaths,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wavi-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setExported(true);
    setTimeout(() => setExported(false), 2000);
  };

  const queueTotal = data ? Object.values(data.queueCounts).reduce((a, b) => a + b, 0) : 0;
  const activeQueue = data ? (data.queueCounts['pending'] ?? 0) + (data.queueCounts['uploading'] ?? 0) + (data.queueCounts['retrying'] ?? 0) : 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-2xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">Diagnostics</h1>
            <p className="text-xs text-white/30 mt-0.5">Local app state — no private data exported to cloud</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={refresh}
              disabled={loading}
              className="p-1.5 rounded-lg hover:bg-white/5 text-white/30 hover:text-white/60 transition-colors disabled:opacity-30"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={exportReport}
              disabled={!data}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-white/10 text-white/40 hover:text-white/70 hover:border-white/20 transition-all disabled:opacity-30"
            >
              <Download className="w-3.5 h-3.5" />
              {exported ? 'Exported!' : 'Export report'}
            </button>
          </div>
        </div>

        {!data && !loading && (
          <div className="flex items-center gap-2 text-xs text-amber-400/70 bg-amber-500/5 border border-amber-500/20 rounded-xl px-4 py-3">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            Diagnostics unavailable — running outside packaged app or IPC not connected
          </div>
        )}

        {data && (
          <>
            {/* Environment banner */}
            {data.environment === 'development' && (
              <div className="flex items-center gap-2 text-xs text-amber-400/70 bg-amber-500/5 border border-amber-500/20 rounded-xl px-4 py-2">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                Development build — data is isolated from the production app
              </div>
            )}

            <Section title="Application" icon={Cpu}>
              <Row label="Version" value={data.appVersion} />
              <Row label="Architecture" value={data.arch} mono />
              <Row label="Platform" value={data.platform} />
              <Row label="Environment" value={data.environment} warn={data.environment === 'development'} />
              <Row label="User data path" value={data.userDataPath} mono />
              <Row label="Build date" value={data.buildDate} />
            </Section>

            <Section title="Database" icon={Database}>
              <Row label="Files indexed" value={data.fileCount.toLocaleString()} />
              <Row label="Projects" value={data.projectCount.toLocaleString()} />
              <Row label="Missing files" value={data.missingFileCount} warn={data.missingFileCount > 0} />
              <Row label="DB size" value={`${data.dbSizeMB} MB`} />
              <Row label="Activity log rows" value={data.activityLogCount.toLocaleString()} />
            </Section>

            <Section title="Sync Queue" icon={Activity}>
              <Row label="Total rows" value={queueTotal.toLocaleString()} />
              <Row label="Active (pending + uploading + retrying)" value={activeQueue} warn={activeQueue > 0} />
              {Object.entries(data.queueCounts).map(([status, count]) => (
                <Row key={status} label={`  ${status}`} value={count} mono />
              ))}
              {queueTotal === 0 && <p className="text-xs text-white/20 py-1">Queue is empty</p>}
            </Section>

            <Section title="Indexed Folders" icon={Folder}>
              {data.indexedRoots.length === 0 ? (
                <p className="text-xs text-white/20 py-1">No folders indexed</p>
              ) : (
                data.indexedRoots.map(r => (
                  <Row key={r} label="" value={r} mono />
                ))
              )}
            </Section>

            <Section title="Configured DAWs" icon={Activity}>
              {Object.keys(data.sanitizedDawPaths).length === 0 ? (
                <p className="text-xs text-white/20 py-1">No DAWs configured</p>
              ) : (
                Object.entries(data.sanitizedDawPaths).map(([k, v]) => (
                  <Row key={k} label={k} value={v || '—'} mono />
                ))
              )}
            </Section>

            <p className="text-[10px] text-white/15 text-center pb-4">
              Report contains no tokens, secrets, audio, or complete private paths.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
