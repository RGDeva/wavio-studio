import { useState } from 'react';
import { FolderOpen, Link2, Music, Wand2, Package, ExternalLink } from 'lucide-react';
import { Surface } from '../../components/ui/Surface';
import { PageHeader } from '../../components/ui/PageHeader';
import { Skeleton } from '../../components/ui/Skeleton';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Button } from '../../components/ui/Button';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { SyncStatusBadge } from '../../components/SyncStatusBadge';
import {
  previewProjects, previewLinks, previewVersions, previewActivity,
  PREVIEW_STATES, type PreviewState,
} from './fixtures';

/**
 * Development-only visual preview harness (P3-1b). Renders representative,
 * deterministic states for the priority surfaces using ONLY synthetic fixtures
 * and shared primitives. No auth, no network, no IPC, no filesystem, no DB.
 *
 * Excluded from production bundles: App gates both the import and the render on
 * `import.meta.env.DEV` (see isPreviewEnabled + App.tsx).
 */
const SURFACES = [
  'Application shell', 'Home', 'Projects', 'Project Detail', 'Project Links',
  'Versions', 'Assistant', 'Activity', 'Settings', 'Watched folders',
] as const;

export default function UiPreview() {
  const [state, setState] = useState<PreviewState>('populated');
  const offline = state === 'offline';

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-surface">
        <span className="font-brand font-bold text-sm">UI Preview</span>
        <span className="text-[11px] text-muted-fg">synthetic fixtures · dev-only</span>
        <div className="ml-auto flex items-center gap-1">
          {PREVIEW_STATES.map((s) => (
            <Button key={s} size="compact" variant={s === state ? 'primary' : 'ghost'} onClick={() => setState(s)}>{s}</Button>
          ))}
        </div>
      </div>

      {offline && (
        <div className="px-4 py-1.5 bg-warning/10 border-b border-warning/20 text-xs text-warning">
          You are offline — changes will sync when the connection returns.
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Shell mock nav */}
        <nav aria-label="Preview navigation" className="w-52 flex-shrink-0 bg-background border-r border-border py-3 px-2 space-y-0.5">
          {SURFACES.map((s, i) => (
            <div key={s} aria-current={i === 1 ? 'page' : undefined}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${i === 1 ? 'bg-white/[0.06] text-foreground' : 'text-white/45'}`}>
              <Music className="w-4 h-4" /> {s}
            </div>
          ))}
        </nav>

        <main className="flex-1 overflow-auto bg-surface">
          <PageHeader
            title="Home"
            subtitle="Recent projects and sync health"
            status={<StatusBadge tone={offline ? 'offline' : 'synced'} />}
            actions={<><Button variant="secondary" size="compact"><Package /> Share</Button><Button variant="primary" size="compact"><ExternalLink /> Open</Button></>}
          />

          <div className="px-5 pb-8 space-y-6">
            {state === 'loading' && (
              <Surface className="p-4"><Skeleton lines={4} /></Surface>
            )}

            {state === 'empty' && (
              <Surface><EmptyState icon={FolderOpen} title="No projects detected yet"
                description="Add a watched folder and Wavi will detect your DAW projects automatically."
                action={<Button variant="primary" size="compact"><FolderOpen /> Add folder</Button>} /></Surface>
            )}

            {state === 'error' && (
              <Surface><ErrorState description="Couldn't load your projects."
                detail="PreviewError: synthetic failure (no real data)" onRetry={() => {}} /></Surface>
            )}

            {state === 'permission-denied' && (
              <Surface><EmptyState icon={Link2} title="You don't have access"
                description="This project link is listen-only. Ask the owner for edit access to import it." /></Surface>
            )}

            {(state === 'populated' || state === 'partial-sync' || state === 'missing-file' || state === 'success' || state === 'offline') && (
              <>
                <section>
                  <h2 className="text-sm font-semibold text-white/50 mb-3 uppercase tracking-wider">Projects</h2>
                  <div className="grid grid-cols-2 gap-3">
                    {previewProjects.map((p) => (
                      <Surface key={p.id} variant="interactive" className="p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-foreground/90 truncate">{p.name}</span>
                          <SyncStatusBadge status={state === 'missing-file' ? 'missing' : state === 'partial-sync' ? 'uploading' : p.status} />
                        </div>
                        <div className="mt-1 text-[11px] text-muted-fg font-mono">{p.daw} · {p.stems} stems · {p.size} · v{p.version}</div>
                      </Surface>
                    ))}
                  </div>
                </section>

                <section>
                  <h2 className="text-sm font-semibold text-white/50 mb-3 uppercase tracking-wider">Project Links</h2>
                  <Surface className="divide-y divide-border">
                    {previewLinks.map((l) => (
                      <div key={l.id} className="flex items-center justify-between px-3 py-2.5">
                        <span className="text-sm text-foreground/85 truncate">{l.label}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-[11px] text-muted-fg font-mono">{l.opened} opens</span>
                          <StatusBadge tone={l.status === 'revoked' ? 'error' : 'success'} label={l.status === 'revoked' ? 'Revoked' : 'Active'} />
                        </div>
                      </div>
                    ))}
                  </Surface>
                </section>

                <div className="grid grid-cols-2 gap-6">
                  <section>
                    <h2 className="text-sm font-semibold text-white/50 mb-3 uppercase tracking-wider">Versions</h2>
                    <Surface className="divide-y divide-border">
                      {previewVersions.map((v) => (
                        <div key={v.id} className="px-3 py-2.5">
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-foreground/85">v{v.n}</span>
                            <span className="text-[11px] text-muted-fg font-mono">{v.date}</span>
                          </div>
                          <div className="text-[11px] text-muted-fg mt-0.5">{v.author} — {v.summary}</div>
                        </div>
                      ))}
                    </Surface>
                  </section>
                  <section>
                    <h2 className="text-sm font-semibold text-white/50 mb-3 uppercase tracking-wider">Activity</h2>
                    <Surface className="divide-y divide-border">
                      {previewActivity.map((a) => (
                        <div key={a.id} className="flex items-center justify-between px-3 py-2.5">
                          <span className="text-sm text-foreground/80 truncate">{a.text}</span>
                          <span className="text-[11px] text-muted-fg font-mono">{a.when}</span>
                        </div>
                      ))}
                    </Surface>
                  </section>
                </div>

                <section>
                  <h2 className="text-sm font-semibold text-white/50 mb-3 uppercase tracking-wider">Assistant</h2>
                  <Surface className="p-4 flex items-center gap-3 text-sm text-muted-fg">
                    <Wand2 className="w-4 h-4 text-primary" /> Project-aware assistant (preview) — ask about sync, versions, or compatibility.
                  </Surface>
                </section>

                {state === 'success' && (
                  <div className="text-xs text-success flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-success" /> Project Link created and copied.
                  </div>
                )}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
