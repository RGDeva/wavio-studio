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
import ProjectDetailPreview from './ProjectDetailPreview';
import {
  previewProjects, previewLinks, previewVersions, previewActivity,
  PREVIEW_STATES, type PreviewState,
} from './fixtures';
import {
  LINK_STATE_PRESENTATION, LINK_GROUP_META, LINK_GROUP_ORDER,
  linkGroupForState, type LinkState, type LinkGroup,
} from '../../lib/projectLinks';

/** Synthetic Project Link rows — one per honest state — for the Links preview. */
const PREVIEW_LINK_STATES: { state: LinkState; label: string; url: string }[] = [
  { state: 'server-confirmed', label: 'Summer EP — master', url: 'https://wavi.stream/project-link/aaa' },
  { state: 'cached', label: 'Late Night Bounce', url: 'https://wavi.stream/project-link/bbb' },
  { state: 'reconciliation-needed', label: 'Client review v3', url: 'https://wavi.stream/project-link/ccc' },
  { state: 'offline', label: 'Demo for label', url: 'https://wavi.stream/project-link/ddd' },
  { state: 'failed', label: 'Collab share', url: 'https://wavi.stream/project-link/eee' },
  { state: 'permission-denied', label: 'Restricted mix', url: 'https://wavi.stream/project-link/fff' },
  { state: 'legacy-local-only', label: 'Old listen link', url: 'https://wavi.stream/listen/ggg' },
  { state: 'unsupported-contract', label: 'Project Pack (beta)', url: 'https://wavi.stream/project-link/hhh' },
  { state: 'expired', label: 'Time-boxed preview', url: 'https://wavi.stream/project-link/iii' },
  { state: 'revoked', label: 'Withdrawn share', url: 'https://wavi.stream/project-link/jjj' },
];

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
  const [view, setView] = useState<'home' | 'project' | 'links'>('home');

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-surface">
        <span className="font-brand font-bold text-sm">UI Preview</span>
        <span className="text-meta text-muted-fg">synthetic fixtures · dev-only</span>
        <div className="flex items-center gap-1 ml-3">
          <Button size="compact" variant={view === 'home' ? 'primary' : 'ghost'} onClick={() => setView('home')}>Home</Button>
          <Button size="compact" variant={view === 'project' ? 'primary' : 'ghost'} onClick={() => setView('project')}>Project Detail</Button>
          <Button size="compact" variant={view === 'links' ? 'primary' : 'ghost'} onClick={() => setView('links')}>Links</Button>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {PREVIEW_STATES.map((s) => (
            <Button key={s} size="compact" variant={s === state ? 'primary' : 'ghost'} onClick={() => setState(s)}>{s}</Button>
          ))}
        </div>
      </div>

      {view === 'project' && (
        <div className="flex-1 overflow-hidden bg-background flex justify-center py-4">
          <ProjectDetailPreview state={state} />
        </div>
      )}

      {view === 'links' && (
        <div className="flex-1 overflow-y-auto bg-background">
          <div className="max-w-3xl mx-auto p-6 space-y-5">
            <PageHeader
              title="Links"
              subtitle="Every honest Project Link state, grouped as the workspace groups them. Synthetic — no network."
              status={<StatusBadge tone="beta" label="Preview" />}
            />
            {/* Empty + error exemplars (states 11 & 12) */}
            <div className="grid grid-cols-2 gap-4">
              <Surface variant="inset" className="p-4">
                <EmptyState icon={Link2} title="No links yet" description="Create a link from a synced project." />
              </Surface>
              <Surface variant="inset" className="p-4">
                <ErrorState title="Couldn't load your links" description="Local link registry unavailable." retryLabel="Try again" onRetry={() => {}} />
              </Surface>
            </div>
            {LINK_GROUP_ORDER.map((group: LinkGroup) => {
              const rows = PREVIEW_LINK_STATES.filter((r) => linkGroupForState(r.state) === group);
              if (!rows.length) return null;
              const meta = LINK_GROUP_META[group];
              return (
                <section key={group} className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <h2 className="text-sm font-semibold text-fg-secondary">{meta.title}</h2>
                    <span className="text-meta text-fg-quaternary">{rows.length} · {meta.hint}</span>
                  </div>
                  <div className="space-y-2">
                    {rows.map((r) => {
                      const pres = LINK_STATE_PRESENTATION[r.state];
                      return (
                        <Surface key={r.state} variant="base" className="border border-hairline p-4">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-fg truncate">{r.label}</span>
                            <StatusBadge tone={pres.tone} label={pres.label} title={pres.note} />
                            <span className="ml-auto text-meta text-fg-quaternary font-mono">{r.state}</span>
                          </div>
                          <p className="text-meta text-fg-quaternary font-mono truncate mt-0.5">{r.url}</p>
                          <p className="text-meta text-fg-quaternary mt-1.5">{pres.note}</p>
                        </Surface>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      {view === 'home' && offline && (
        <div className="px-4 py-1.5 bg-warning/10 border-b border-warning/20 text-xs text-warning">
          You are offline — changes will sync when the connection returns.
        </div>
      )}

      {view === 'home' && (
      <div className="flex flex-1 overflow-hidden">
        {/* Shell mock nav */}
        <nav aria-label="Preview navigation" className="w-52 flex-shrink-0 bg-background border-r border-border py-3 px-2 space-y-0.5">
          {SURFACES.map((s, i) => (
            <div key={s} aria-current={i === 1 ? 'page' : undefined}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${i === 1 ? 'bg-layer-3 text-foreground' : 'text-fg-quaternary'}`}>
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
                  <h2 className="text-sm font-semibold text-fg-tertiary mb-3 uppercase tracking-wider">Projects</h2>
                  <div className="grid grid-cols-2 gap-3">
                    {previewProjects.map((p) => (
                      <Surface key={p.id} variant="interactive" className="p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-foreground/90 truncate">{p.name}</span>
                          <SyncStatusBadge status={state === 'missing-file' ? 'missing' : state === 'partial-sync' ? 'uploading' : p.status} />
                        </div>
                        <div className="mt-1 text-meta text-muted-fg font-mono">{p.daw} · {p.stems} stems · {p.size} · v{p.version}</div>
                      </Surface>
                    ))}
                  </div>
                </section>

                <section>
                  <h2 className="text-sm font-semibold text-fg-tertiary mb-3 uppercase tracking-wider">Project Links</h2>
                  <Surface className="divide-y divide-border">
                    {previewLinks.map((l) => (
                      <div key={l.id} className="flex items-center justify-between px-3 py-2.5">
                        <span className="text-sm text-foreground/85 truncate">{l.label}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-meta text-muted-fg font-mono">{l.opened} opens</span>
                          <StatusBadge tone={l.status === 'revoked' ? 'error' : 'success'} label={l.status === 'revoked' ? 'Revoked' : 'Active'} />
                        </div>
                      </div>
                    ))}
                  </Surface>
                </section>

                <div className="grid grid-cols-2 gap-6">
                  <section>
                    <h2 className="text-sm font-semibold text-fg-tertiary mb-3 uppercase tracking-wider">Versions</h2>
                    <Surface className="divide-y divide-border">
                      {previewVersions.map((v) => (
                        <div key={v.id} className="px-3 py-2.5">
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-foreground/85">v{v.n}</span>
                            <span className="text-meta text-muted-fg font-mono">{v.date}</span>
                          </div>
                          <div className="text-meta text-muted-fg mt-0.5">{v.author} — {v.summary}</div>
                        </div>
                      ))}
                    </Surface>
                  </section>
                  <section>
                    <h2 className="text-sm font-semibold text-fg-tertiary mb-3 uppercase tracking-wider">Activity</h2>
                    <Surface className="divide-y divide-border">
                      {previewActivity.map((a) => (
                        <div key={a.id} className="flex items-center justify-between px-3 py-2.5">
                          <span className="text-sm text-foreground/80 truncate">{a.text}</span>
                          <span className="text-meta text-muted-fg font-mono">{a.when}</span>
                        </div>
                      ))}
                    </Surface>
                  </section>
                </div>

                <section>
                  <h2 className="text-sm font-semibold text-fg-tertiary mb-3 uppercase tracking-wider">Assistant</h2>
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
      )}
    </div>
  );
}
