/**
 * Deterministic SYNTHETIC fixtures for the dev-only UI preview harness (P3-1b).
 * No real project names, file paths, emails, tokens, artwork, or private data —
 * everything here is invented and stable across runs.
 */
export const previewProjects = [
  { id: 'px1', name: 'Midnight Sketch', daw: 'Ableton Live', status: 'synced', stems: 8, size: '41 MB', version: 3 },
  { id: 'px2', name: 'Aurora Loop', daw: 'FL Studio', status: 'uploading', stems: 5, size: '22 MB', version: 1 },
  { id: 'px3', name: 'Paper Planes', daw: 'Pro Tools', status: 'failed', stems: 12, size: '88 MB', version: 7 },
  { id: 'px4', name: 'Low Tide', daw: 'Ableton Live', status: 'paused', stems: 4, size: '17 MB', version: 2 },
];

export const previewFiles = [
  { name: 'master.wav', rel: '/preview/Midnight Sketch/master.wav', size: '18 MB', role: 'master', synced: true },
  { name: 'kick.wav', rel: '/preview/Midnight Sketch/stems/kick.wav', size: '3 MB', role: 'stem', synced: true },
  { name: 'melody.mid', rel: '/preview/Midnight Sketch/melody.mid', size: '4 KB', role: 'midi', synced: false },
  { name: 'cover.png', rel: '/preview/Midnight Sketch/cover.png', size: '512 KB', role: 'artwork', synced: false },
];

export const previewLinks = [
  { id: 'lk1', label: 'Midnight Sketch — full project', kind: 'project', status: 'active', opened: 4 },
  { id: 'lk2', label: 'Aurora Loop — listen', kind: 'listen', status: 'active', opened: 12 },
  { id: 'lk3', label: 'Old draft', kind: 'project', status: 'revoked', opened: 0 },
];

export const previewVersions = [
  { id: 'v3', n: 3, author: 'You', date: '2 hours ago', summary: 'Updated master + added sax' },
  { id: 'v2', n: 2, author: 'Collaborator B', date: 'yesterday', summary: 'Alternate bassline (branch)' },
  { id: 'v1', n: 1, author: 'You', date: '3 days ago', summary: 'Initial publish' },
];

export const previewActivity = [
  { id: 'a1', kind: 'version', text: 'Published v3 of “Midnight Sketch”', when: '2h ago' },
  { id: 'a2', kind: 'link', text: 'Project Link opened', when: '3h ago' },
  { id: 'a3', kind: 'sync', text: 'Sync resumed', when: '5h ago' },
];

export const previewFolders = [
  { path: '/preview/Music/Ableton', projects: 6 },
  { path: '/preview/Music/FL Projects', projects: 9 },
];

export type PreviewState =
  | 'populated' | 'loading' | 'empty' | 'error'
  | 'offline' | 'permission-denied' | 'partial-sync' | 'missing-file' | 'success';

export const PREVIEW_STATES: PreviewState[] = [
  'populated', 'loading', 'empty', 'error',
  'offline', 'permission-denied', 'partial-sync', 'missing-file', 'success',
];
