import { useState, useEffect } from 'react';
import { LogOut, ExternalLink, Shield, Cpu, HardDrive, Zap, BarChart2, Music2, FolderOpen, Pause, Play } from 'lucide-react';
import { api } from '../lib/api';
import { BridgeStatusPanel } from '../components/BridgeStatusPanel';

interface PlanInfo {
  plan: string;
  usage: { file_count: number; total_bytes: number };
  limits: { max_files: number; max_storage_bytes: number; display_name: string; price_monthly_cents: number; stem_splitting: boolean; version_history: boolean };
}

function formatBytes(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`;
  return `${(b / 1e3).toFixed(0)} KB`;
}

interface SettingsPageProps {
  onLogout: () => void;
  visible?: boolean;
}

export function SettingsPage({ onLogout }: SettingsPageProps) {
  const [autoStart, setAutoStart] = useState(false);
  const [syncOnSave, setSyncOnSave] = useState(true);
  const [chunkSizeMB, setChunkSizeMB] = useState(5);
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [planInfo, setPlanInfo] = useState<PlanInfo | null>(null);
  const [dawPaths, setDawPaths] = useState<Record<string, string>>({});
  const [syncPaused, setSyncPaused] = useState(false);
  const [systemPause, setSystemPause] = useState<'auth' | 'limit' | null>(null);

  useEffect(() => {
    api.sync.isPausedByUser().then(setSyncPaused);
    // Distinguish a user pause from system pauses so the UI can explain
    // accurately why nothing is uploading — Resume cannot clear auth/limit.
    api.sync.getStatus().then((s) => {
      if (s === 'paused:auth') setSystemPause('auth');
      else if (s === 'paused:limit') setSystemPause('limit');
    });
  }, []);

  useEffect(() => {
    Promise.all([
      api.settings.get('autoStart'),
      api.settings.get('syncOnSave'),
      api.settings.get('chunkSizeMB'),
      api.settings.get('maxConcurrent'),
      api.settings.get('dawPaths'),
    ]).then(([a, s, c, m, d]) => {
      if (a !== undefined) setAutoStart(a);
      if (s !== undefined) setSyncOnSave(s);
      if (c !== undefined) setChunkSizeMB(c);
      if (m !== undefined) setMaxConcurrent(m);
      if (d !== undefined) setDawPaths(d ?? {});
    });

    // Fetch plan + usage
    api.auth.getToken().then(async (token) => {
      if (!token) return;
      try {
        const res = await fetch(`${window.waviAPI.config.apiBase}/desktop/index`, {
          headers: { Authorization: `Bearer ${token}`, 'X-Desktop-Action': 'plan' },
        });
        if (res.ok) setPlanInfo(await res.json());
      } catch { /* non-fatal */ }
    });
  }, []);

  const handleLogout = async () => {
    await api.auth.clearToken();
    onLogout();
  };

  const Toggle = ({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) => (
    <button
      onClick={() => onChange(!value)}
      className={`relative w-10 h-5 rounded-full transition-colors ${value ? 'bg-cyan-500' : 'bg-white/10'}`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${value ? 'left-5' : 'left-0.5'}`}
      />
    </button>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-bold text-white">Settings</h1>
          <p className="text-xs text-white/30 mt-0.5">Configure Wavi Studio behavior</p>
        </div>

        {/* Sync settings */}
        <Section title="Sync" icon={<Cpu className="w-4 h-4 text-cyan-400" />}>
          <SettingRow
            label="Sync on save"
            description="Automatically queue upload whenever a project file is saved"
          >
            <Toggle value={syncOnSave} onChange={(v) => { setSyncOnSave(v); api.settings.set('syncOnSave', v); }} />
          </SettingRow>
          <SettingRow
            label="Chunk size"
            description="Upload chunk size for resumable uploads"
          >
            <select
              value={chunkSizeMB}
              onChange={(e) => { const v = Number(e.target.value); setChunkSizeMB(v); api.settings.set('chunkSizeMB', v); }}
              className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500/50"
            >
              {[1, 2, 5, 10, 20].map((n) => (
                <option key={n} value={n}>{n} MB</option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            label="Max concurrent uploads"
            description="Number of files uploaded simultaneously"
          >
            <select
              value={maxConcurrent}
              onChange={(e) => { const v = Number(e.target.value); setMaxConcurrent(v); api.settings.set('maxConcurrent', v); }}
              className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500/50"
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            label={systemPause ? 'Sync blocked' : syncPaused ? 'Sync paused' : 'Sync running'}
            description={systemPause === 'auth'
              ? 'Sync is blocked because your session expired. Sign in again to continue — Resume alone won\'t restart uploads.'
              : systemPause === 'limit'
              ? 'Sync is blocked because your plan storage limit was reached. Free up space or upgrade — Resume alone won\'t restart uploads.'
              : syncPaused
              ? 'You paused sync. Nothing uploads until you resume — this persists across app restarts. In-flight uploads finish first.'
              : 'Pause to stop all uploads until you resume. The pause persists across app restarts.'}
          >
            <button
              onClick={async () => {
                if (syncPaused) { await api.sync.resume(); setSyncPaused(false); }
                else { await api.sync.pause(); setSyncPaused(true); }
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                syncPaused ? 'bg-cyan-600 hover:bg-cyan-500 text-white' : 'bg-white/10 hover:bg-white/15 text-white/70'
              }`}
            >
              {syncPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              {syncPaused ? 'Resume Sync' : 'Pause Sync'}
            </button>
          </SettingRow>
        </Section>

        {/* System */}
        <Section title="System" icon={<HardDrive className="w-4 h-4 text-violet-400" />}>
          <SettingRow
            label="Launch at login"
            description="Start Wavi Studio automatically when you log in"
          >
            <Toggle value={autoStart} onChange={(v) => { setAutoStart(v); api.settings.set('autoStart', v); }} />
          </SettingRow>
        </Section>

        {/* Plan & Usage */}
        <div className="bg-[#111] border border-[#1a1a1a] rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1a1a1a]">
            <BarChart2 className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-white/60">Plan & Storage</h2>
          </div>
          <div className="px-4 py-4 space-y-4">
            {planInfo ? (() => {
              const { plan, usage, limits } = planInfo;
              const filePct = limits.max_files === -1 ? 0
                : Math.min(100, Math.round((usage.file_count / limits.max_files) * 100));
              const storagePct = limits.max_storage_bytes === -1 ? 0
                : Math.min(100, Math.round((usage.total_bytes / limits.max_storage_bytes) * 100));
              const nearLimit = filePct >= 80 || storagePct >= 80;
              return (
                <>
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                      plan === 'free' ? 'bg-white/10 text-white/50'
                      : plan === 'pro' ? 'bg-cyan-500/20 text-cyan-400'
                      : 'bg-violet-500/20 text-violet-400'
                    }`}>
                      {limits.display_name}
                    </span>
                    {plan === 'free' && (
                      <button
                        onClick={() => api.shell.openExternal('https://wavi.stream/pricing')}
                        className="flex items-center gap-1.5 text-xs bg-cyan-500 hover:bg-cyan-400 text-black font-semibold px-3 py-1.5 rounded-lg transition-colors"
                      >
                        <Zap className="w-3 h-3" />
                        Upgrade to Pro
                      </button>
                    )}
                  </div>

                  {/* Files bar */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-white/40">Files</span>
                      <span className={nearLimit && filePct >= 80 ? 'text-amber-400' : 'text-white/40'}>
                        {usage.file_count} / {limits.max_files === -1 ? '∞' : limits.max_files}
                      </span>
                    </div>
                    <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${filePct >= 90 ? 'bg-red-500' : filePct >= 80 ? 'bg-amber-400' : 'bg-cyan-500'}`}
                        style={{ width: limits.max_files === -1 ? '10%' : `${filePct}%` }}
                      />
                    </div>
                  </div>

                  {/* Storage bar */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-white/40">Storage</span>
                      <span className={nearLimit && storagePct >= 80 ? 'text-amber-400' : 'text-white/40'}>
                        {formatBytes(usage.total_bytes)} / {limits.max_storage_bytes === -1 ? '∞' : formatBytes(limits.max_storage_bytes)}
                      </span>
                    </div>
                    <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${storagePct >= 90 ? 'bg-red-500' : storagePct >= 80 ? 'bg-amber-400' : 'bg-emerald-500'}`}
                        style={{ width: limits.max_storage_bytes === -1 ? '10%' : `${storagePct}%` }}
                      />
                    </div>
                  </div>

                  {nearLimit && (
                    <p className="text-[11px] text-amber-400/80">
                      You're approaching your limit. Upgrade to keep syncing.
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2 pt-1">
                    {[
                      { label: 'Stem splitting', ok: limits.stem_splitting },
                      { label: 'Version history', ok: limits.version_history },
                    ].map(({ label, ok }) => (
                      <span key={label} className={`text-[10px] px-2 py-0.5 rounded-full border ${ok ? 'border-emerald-500/30 text-emerald-400' : 'border-white/10 text-white/25 line-through'}`}>
                        {label}
                      </span>
                    ))}
                  </div>
                </>
              );
            })() : (
              <p className="text-xs text-white/30">Loading plan info…</p>
            )}
          </div>
        </div>

        {/* DAW Configuration */}
        <Section title="DAW Applications" icon={<Music2 className="w-4 h-4 text-pink-400" />}>
          <p className="text-xs text-white/40 mb-3">
            Configure which DAW to use when opening a file. Click a slot to browse for the app.
          </p>
          <div className="space-y-2">
            {(['FL Studio', 'Ableton Live', 'Pro Tools', 'Logic Pro'] as const).map((name) => {
              const key = name.toLowerCase().replace(/\s+/g, '_');
              const saved = dawPaths[key];
              return (
                <div key={name} className="flex items-center gap-3 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2.5">
                  <Music2 className="w-3.5 h-3.5 text-white/30 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-white/80">{name}</p>
                    {saved
                      ? <p className="text-[10px] text-cyan-400/70 truncate">{saved}</p>
                      : <p className="text-[10px] text-white/25">Not configured</p>
                    }
                  </div>
                  <button
                    onClick={async () => {
                      const picked = await api.shell.pickApp();
                      if (!picked) return;
                      const next = { ...dawPaths, [key]: picked };
                      setDawPaths(next);
                      api.settings.set('dawPaths', next);
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-[10px] text-white/50 hover:text-white transition-colors"
                  >
                    <FolderOpen className="w-3 h-3" />
                    {saved ? 'Change' : 'Browse'}
                  </button>
                  {saved && (
                    <button
                      onClick={() => {
                        const next = { ...dawPaths };
                        delete next[key];
                        setDawPaths(next);
                        api.settings.set('dawPaths', next);
                      }}
                      className="text-[10px] text-white/25 hover:text-red-400 transition-colors"
                    >✕</button>
                  )}
                </div>
              );
            })}
          </div>
        </Section>

        {/* Local Bridge */}
        <BridgeStatusPanel />

        {/* Security */}
        <Section title="Security" icon={<Shield className="w-4 h-4 text-emerald-400" />}>
          <div className="space-y-3">
            <p className="text-xs text-white/40">
              Your session is encrypted and stored locally using the system keychain.
            </p>
            <button
              onClick={() => api.shell.openExternal('https://wavi.stream/settings/integrations')}
              className="flex items-center gap-2 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              Open account settings
            </button>
          </div>
        </Section>

        {/* Account */}
        <div className="bg-[#111] border border-[#1a1a1a] rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-white/70">Sign out</p>
              <p className="text-xs text-white/30 mt-0.5">Remove your API token from this device</p>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 px-4 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 text-sm rounded-lg transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign out
            </button>
          </div>
        </div>

        <p className="text-center text-[10px] text-white/15">Wavi Studio v1.0.0</p>
      </div>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-[#111] border border-[#1a1a1a] rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1a1a1a]">
        {icon}
        <h2 className="text-sm font-semibold text-white/60">{title}</h2>
      </div>
      <div className="divide-y divide-[#1a1a1a]">{children}</div>
    </div>
  );
}

function SettingRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-3.5 gap-6">
      <div>
        <p className="text-sm text-white/70">{label}</p>
        <p className="text-xs text-white/25 mt-0.5">{description}</p>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
