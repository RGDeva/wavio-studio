import { useState, useEffect, useCallback } from 'react';
import { Wifi, WifiOff, RefreshCw, Shield, Terminal } from 'lucide-react';
import { api } from '../lib/api';

interface BridgeStatus {
  port: number;
  host: string;
  tokenExists: boolean;
  tokenPerm: string;
  tokenHint: string;
  online: boolean;
}

interface CompanionPing {
  lastSeen: Date | null;
  requestCount: number;
}

export function BridgeStatusPanel() {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [companion, setCompanion] = useState<CompanionPing>({ lastSeen: null, requestCount: 0 });
  const [httpOnline, setHttpOnline] = useState<boolean | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.bridge.getStatus();
      setStatus(s);

      // Directly ping the bridge /health from renderer (same machine, CORS *)
      if (s?.online) {
        try {
          const r = await fetch(`http://${s.host}:${s.port}/health`, { signal: AbortSignal.timeout(1500) });
          setHttpOnline(r.ok);
          // Heuristic: check if any recent bridge_ activity indicates a companion connection
          const activity = await api.activity.getAll();
          const bridgeEntries = activity.filter((a: any) => String(a.type ?? '').startsWith('bridge_'));
          if (bridgeEntries.length > 0) {
            const latest = bridgeEntries[0];
            const ts = latest.created_at ? new Date(latest.created_at) : null;
            setCompanion({ lastSeen: ts, requestCount: bridgeEntries.length });
          }
        } catch {
          setHttpOnline(false);
        }
      } else {
        setHttpOnline(false);
      }
    } catch {
      setStatus(null);
      setHttpOnline(false);
    } finally {
      setLoading(false);
      setLastRefresh(new Date());
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10_000); // refresh every 10s
    return () => clearInterval(interval);
  }, [refresh]);

  function fmtTime(d: Date | null) {
    if (!d) return 'never';
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return d.toLocaleTimeString();
  }

  const dot = (ok: boolean | null) => (
    <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
      ok === null ? 'bg-white/20' : ok ? 'bg-emerald-400' : 'bg-red-500'
    }`} />
  );

  return (
    <div className="bg-[#111] border border-[#1a1a1a] rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a1a]">
        <div className="flex items-center gap-2">
          {httpOnline ? (
            <Wifi className="w-4 h-4 text-emerald-400" />
          ) : (
            <WifiOff className="w-4 h-4 text-red-400" />
          )}
          <h2 className="text-sm font-semibold text-white/60">Local Bridge</h2>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
            httpOnline ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
          }`}>
            {httpOnline === null ? '…' : httpOnline ? 'Online' : 'Offline'}
          </span>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="p-1 rounded text-white/30 hover:text-white/60 transition-colors disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Rows */}
      <div className="divide-y divide-[#1a1a1a]">
        <Row icon={<Terminal className="w-3.5 h-3.5 text-cyan-400" />} label="Endpoint">
          <code className="text-[11px] text-white/60 font-mono">
            {status ? `http://${status.host}:${status.port}` : '—'}
          </code>
        </Row>

        <Row icon={<Shield className="w-3.5 h-3.5 text-violet-400" />} label="Token">
          <div className="flex items-center gap-2">
            {dot(status?.tokenExists ?? null)}
            <span className="text-[11px] text-white/50">
              {status?.tokenExists
                ? <>exists · perm <code className="text-white/70 font-mono">{status.tokenPerm}</code> · <code className="text-white/40 font-mono">{status.tokenHint}</code></>
                : 'not found'}
            </span>
          </div>
        </Row>

        <Row icon={<Wifi className="w-3.5 h-3.5 text-emerald-400" />} label="HTTP /health">
          <div className="flex items-center gap-2">
            {dot(httpOnline)}
            <span className="text-[11px] text-white/50">
              {httpOnline === null ? 'checking…' : httpOnline ? 'responding' : 'no response'}
            </span>
          </div>
        </Row>

        <Row icon={<span className="text-[11px]">🤖</span>} label="Companion">
          <div className="flex items-center gap-2">
            {dot(companion.requestCount > 0 ? true : null)}
            <span className="text-[11px] text-white/50">
              {companion.requestCount > 0
                ? `${companion.requestCount} bridge action${companion.requestCount !== 1 ? 's' : ''} · last ${fmtTime(companion.lastSeen)}`
                : 'no activity yet'}
            </span>
          </div>
        </Row>
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-[#1a1a1a] flex items-center justify-between">
        <p className="text-[10px] text-white/20">
          Listens on 127.0.0.1 only · Token auth required
        </p>
        <p className="text-[10px] text-white/20">
          refreshed {fmtTime(lastRefresh)}
        </p>
      </div>
    </div>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 gap-4">
      <div className="flex items-center gap-2 min-w-[100px]">
        {icon}
        <span className="text-[11px] text-white/40">{label}</span>
      </div>
      <div className="flex-1 text-right">{children}</div>
    </div>
  );
}
