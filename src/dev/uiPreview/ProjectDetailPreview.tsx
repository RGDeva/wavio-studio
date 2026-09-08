import { useState } from 'react';
import { ExternalLink, Zap, RefreshCw, Package, Link2, FolderOpen, Sparkles, X, ArrowRight, CheckCircle2, Puzzle, File } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { SyncStatusBadge } from '../../components/SyncStatusBadge';
import { Tabs } from '../../components/ui/Tabs';
import { Progress } from '../../components/ui/Progress';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { FileRow } from '../../components/ui/FileRow';
import { EmptyState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import type { PreviewState } from './fixtures';

/**
 * Dev-only deterministic Project Detail examples (P3-1c). Synthetic data only —
 * no real project names/paths/emails/tokens/artwork. Renders the redesigned
 * workspace using the real primitives so screenshots reflect production styling.
 */
const TABS = [
  { id: 'overview', label: 'Overview' }, { id: 'files', label: 'Files' },
  { id: 'versions', label: 'Versions' }, { id: 'dependencies', label: 'Dependencies' },
  { id: 'compatibility', label: 'Compatibility' }, { id: 'activity', label: 'Activity' },
];

const files = [
  { name: 'Midnight Sketch.als', rel: 'Midnight Sketch.als', size: '2.1 MB', synced: true, included: true, missing: false },
  { name: 'master.wav', rel: 'master.wav', size: '18 MB', synced: true, included: true, missing: false },
  { name: 'kick.wav', rel: 'stems/kick.wav', size: '3 MB', synced: true, included: false, missing: false },
  { name: 'vox_take3.wav', rel: 'stems/vox_take3.wav', size: '9 MB', synced: false, included: false, missing: true },
];

export default function ProjectDetailPreview({ state }: { state: PreviewState }) {
  const [tab, setTab] = useState('overview');
  const missing = state === 'missing-file';
  const syncStatus = state === 'partial-sync' || state === 'sync-in-progress' ? 'uploading' : state === 'offline' ? 'paused' : 'synced';
  const completeness = state === 'partial-sync' || state === 'sync-in-progress' ? 62 : missing ? 78 : 100;
  const noNativeDaw = state === 'no-native-daw';

  return (
    <div className="w-[560px] h-full bg-surface border-l border-border flex flex-col mx-auto">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border">
        <div className="w-8 h-8 rounded bg-primary/15 flex items-center justify-center text-primary text-xs font-bold">A</div>
        <div className="flex-1 min-w-0">
          <h2 className="font-brand text-base font-bold text-foreground truncate">Midnight Sketch</h2>
          <div className="flex items-center gap-2 mt-0.5 text-meta text-muted-fg">
            <SyncStatusBadge status={syncStatus} /><span>·</span><span>Ableton Live</span><span>·</span><span className="font-mono">v3</span><span>·</span><span>Jul 9</span>
          </div>
        </div>
        <Button variant="ghost" size="compact"><Sparkles /> Copilot</Button>
        <button aria-label="Close" className="p-1.5 rounded hover:bg-layer-3"><X className="w-4 h-4 text-fg-tertiary" /></button>
      </div>

      <div className="px-5 py-3 border-b border-border-subtle space-y-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="primary"><ExternalLink /> Open in DAW</Button>
          <Button variant="secondary"><Zap /> Sync Changes</Button>
          <Button variant="secondary"><RefreshCw /> Publish Version</Button>
          <Button variant="secondary"><Package /> Share Project</Button>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="compact"><Link2 /> Copy Listen Link</Button>
          <Button variant="ghost" size="compact"><FolderOpen /> Reveal Folder</Button>
        </div>
        {state === 'success' && <p className="text-meta text-primary">Project Link created and copied.</p>}
        {state === 'error' && <p className="text-meta text-destructive">Error: could not publish version.</p>}
      </div>

      <Tabs tabs={TABS} value={tab} onValueChange={setTab} />

      <div className="flex-1 overflow-y-auto" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {state === 'loading' ? (
          <div className="p-5 space-y-3" aria-busy><Skeleton className="h-16" /><Skeleton lines={4} /></div>
        ) : state === 'empty' ? (
          <EmptyState icon={File} title="No files indexed" description="This project has no associated files yet." />
        ) : tab === 'files' ? (
          <div className="py-2">
            <div className="px-4 py-2 flex items-center gap-2"><span className="text-xs font-medium text-fg-quaternary uppercase tracking-wider">Audio</span></div>
            {files.map((f) => (
              <FileRow key={f.name} fileName={f.name} relPath={f.rel} size={f.size} synced={f.synced} included={f.included}
                missing={missing && f.missing} checksum={'sha256-…'} onOpen={() => {}} onReveal={() => {}} />
            ))}
          </div>
        ) : tab === 'versions' ? (
          <div className="p-4 space-y-2">
            {['v3 · updated master', 'v2 · alternate bassline (branch)', 'v1 · initial publish'].map((v, i) => (
              <div key={i} className="flex items-center gap-3 py-2.5 border-b border-border-subtle">
                <CheckCircle2 className="w-3.5 h-3.5 text-primary/50" /><span className="text-sm text-foreground/75">{v}</span>
              </div>
            ))}
          </div>
        ) : tab === 'dependencies' ? (
          <div className="p-5 space-y-4">
            <div><SectionHeader label="Missing files" count={missing ? 1 : 0} />
              {missing ? <div className="flex items-center gap-2 text-meta"><span className="text-foreground/70">vox_take3.wav</span><span className="ml-auto font-mono text-muted-fg">stems/vox_take3.wav</span></div>
                : <p className="text-meta text-muted-fg">All indexed files are present on disk.</p>}
            </div>
            <div><SectionHeader label="Plugins" /><div className="flex items-center gap-2 text-meta text-muted-fg"><Puzzle className="w-3.5 h-3.5" /> Plugin scanning is not yet implemented — plugin dependencies are unknown.</div></div>
          </div>
        ) : tab === 'compatibility' ? (
          <div className="p-5">
            <p className="text-xs font-semibold text-foreground/75 mb-3">{noNativeDaw ? 'Universal Project Pack (DAW project)' : 'Native open in Ableton Live'}</p>
            {(noNativeDaw
              ? [['Open in DAW', 'Project Pack only', 'muted'], ['Native packaging', 'Generic pack', 'muted'], ['Restore', 'Supported', 'ok'], ['Cross-DAW reconstruction', 'Planned', 'muted'], ['Plugin scan', 'Not yet', 'muted'], ['Fidelity report', 'Not yet', 'muted']]
              : [['Open in Ableton Live', 'Available', 'ok'], ['Native packaging', 'Included', 'ok'], ['Restore', 'Supported', 'ok'], ['Cross-DAW reconstruction', 'Planned', 'muted'], ['Plugin scan', 'Not yet', 'muted'], ['Fidelity report', 'Not yet', 'muted']]
            ).map(([l, v, t]) => (
              <div key={l} className="flex items-center justify-between text-meta py-1 border-b border-border-subtle last:border-0">
                <span className="text-muted-fg">{l}</span><span className={t === 'ok' ? 'text-success' : 'text-fg-quaternary'}>{v}</span>
              </div>
            ))}
          </div>
        ) : tab === 'activity' ? (
          <div className="p-4 space-y-1">
            {['Published v3', 'Project Link opened', 'Sync resumed'].map((a, i) => (
              <div key={i} className="flex items-start gap-2 py-1.5 border-b border-border-subtle last:border-0">
                <span className="text-meta text-muted-fg w-32 font-mono">Jul 9</span><span className="text-meta text-foreground/55">{a}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-5 space-y-5">
            <div className="flex items-center gap-3 bg-surface-2 border border-border rounded-lg px-3 py-2">
              <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center">▶</div>
              <div className="flex-1 min-w-0"><p className="text-xs text-foreground/80">master.wav</p>
                <p className="text-meta text-muted-fg">{state === 'playback-error' ? "Couldn't play this file — use Open instead." : 'Latest bounce'}</p></div>
            </div>
            <div className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 border ${missing ? 'text-warning border-warning/20 bg-warning/[0.06]' : 'text-success border-success/20 bg-success/[0.06]'}`}>
              <ArrowRight className="w-3.5 h-3.5 mt-0.5" /> {missing ? '1 file missing on disk — reconnect it before sharing.' : 'Up to date and shared.'}
            </div>
            <div><SectionHeader label="Package" action={<span className="text-meta text-muted-fg font-mono">32 MB</span>} />
              <Progress value={completeness} label="Completeness" />
              <div className="grid grid-cols-3 gap-x-4 gap-y-1.5 mt-3 text-meta">
                {[['Native project', 'Yes'], ['Latest bounce', 'Yes'], ['Stems', '8'], ['MIDI', '2'], ['Synced', missing ? '3/4' : '4/4'], ['Missing', missing ? '1' : '0']].map(([l, v]) => (
                  <div key={l}><p className="text-meta text-muted-fg">{l}</p><p className={`text-xs font-medium ${l === 'Missing' && missing ? 'text-warning' : 'text-foreground/80'}`}>{v}</p></div>
                ))}
              </div>
            </div>
            <div><SectionHeader label="Compatibility" /><StatusBadge tone="synced" label="Native open available" /></div>
          </div>
        )}
      </div>
    </div>
  );
}
