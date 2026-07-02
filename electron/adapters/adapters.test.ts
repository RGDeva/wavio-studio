/**
 * DAW adapter contract tests (Phase F). Pure fs/logic — no Electron, no
 * better-sqlite3. The .als fixture is generated deterministically in a temp
 * dir (gzipped Ableton-shaped XML) rather than committing a binary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';

import { abletonAdapter, getAdapterForFile, getAdapterForProject, getAdapterById, genericAdapter, KNOWN_DAW_PROJECT_EXTENSIONS } from './index';
import { parseAbletonLiveSet, abletonManifestExtras, scanAbletonFolder } from './ableton';
import { safeRelativePath, classifyFileRole, findPreviewCandidate, PUBLISH_EXCLUDE } from './common';

let tmp: string;

const ALS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="12.0_12049">
  <LiveSet>
    <MasterTrack>
      <DeviceChain>
        <Mixer>
          <Tempo><LomId Value="0" /><Manual Value="140" /></Tempo>
        </Mixer>
      </DeviceChain>
    </MasterTrack>
    <KeySignature><Tonic Value="5" /><Scale Value="0" /></KeySignature>
  </LiveSet>
</Ableton>`;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wavi-adapter-test-'));
  // Golden fixture project: root/.als + Ableton Project Info/ + Samples + Backups
  fs.writeFileSync(path.join(tmp, 'Fixture Song.als'), zlib.gzipSync(Buffer.from(ALS_XML)));
  fs.mkdirSync(path.join(tmp, 'Ableton Project Info'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'Samples', 'Imported'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'Samples', 'Imported', 'kick.wav'), Buffer.from('RIFFxxxx'));
  fs.mkdirSync(path.join(tmp, 'Backup'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'Backup', 'old [2026-01-01].als'), zlib.gzipSync(Buffer.from(ALS_XML)));
  fs.writeFileSync(path.join(tmp, 'preview.wav'), Buffer.from('RIFFyyyy'));
});

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('registry', () => {
  it('resolves .als to the Ableton adapter', () => {
    expect(getAdapterForFile('/x/Song.als').id).toBe('ableton');
    expect(getAdapterForFile('/x/Song.ALS').id).toBe('ableton');
  });
  it('falls back to the generic adapter for unadapted DAWs', () => {
    expect(getAdapterForFile('/x/beat.flp').id).toBe('generic');
    expect(getAdapterForFile(null).id).toBe('generic');
    expect(getAdapterById('nope').id).toBe('generic');
  });
  it('resolves by stored daw_type before path', () => {
    expect(getAdapterForProject('ableton', null).id).toBe('ableton');
    expect(getAdapterForProject('Ableton Live', '/x/whatever.txt').id).toBe('ableton');
    expect(getAdapterForProject('fl-studio', '/x/beat.flp').id).toBe('generic');
  });
  it('discovery extension set keeps the exact pre-extraction membership', () => {
    const expected = ['.flp', '.als', '.ptx', '.ptf', '.rpp', '.logic', '.band', '.npr', '.sesx', '.song', '.reason', '.bwproject', '.cpr'];
    expect(new Set(KNOWN_DAW_PROJECT_EXTENSIONS)).toEqual(new Set(expected));
  });
});

describe('classification', () => {
  it('is total — every extension gets a role', () => {
    for (const name of ['a.als', 'a.wav', 'a.mid', 'a.png', 'a.pdf', 'a.zip', 'a.asd', 'a.xyz', 'noext']) {
      expect(typeof classifyFileRole(name, 'misc')).toBe('string');
    }
  });
  it('matches the pre-extraction role table', () => {
    expect(classifyFileRole('Song.als', 'misc')).toBe('project');
    expect(classifyFileRole('kick.wav', 'stem')).toBe('stem');
    expect(classifyFileRole('kick.wav', 'sample')).toBe('sample');
    expect(classifyFileRole('kick.wav', 'misc')).toBe('audio');
    expect(classifyFileRole('clip.asd', 'misc')).toBe('analysis');
    expect(classifyFileRole('cover.png', 'misc')).toBe('artwork');
    expect(classifyFileRole('weird.xyz', 'misc')).toBe('other');
  });
});

describe('pack exclusion (safeRelativePath)', () => {
  const root = '/proj';
  it('returns project-relative paths inside the root', () => {
    expect(safeRelativePath('/proj/Samples/kick.wav', root)).toBe('Samples/kick.wav');
  });
  it('never returns a path outside the root', () => {
    expect(safeRelativePath('/elsewhere/kick.wav', root)).toBeNull();
  });
  it('excludes Backups, Ableton Temp Files, .DS_Store, locks and logs', () => {
    expect(safeRelativePath('/proj/Backups/old.als', root)).toBeNull();
    expect(safeRelativePath('/proj/Ableton Temp Files/x.wav', root)).toBeNull();
    expect(safeRelativePath('/proj/.DS_Store', root)).toBeNull();
    expect(safeRelativePath('/proj/Samples/thing.lock', root)).toBeNull();
    expect(safeRelativePath('/proj/debug.log', root)).toBeNull();
  });
  it('exclusion list itself is unchanged (golden)', () => {
    expect(PUBLISH_EXCLUDE.map((r) => r.source)).toEqual([
      '\\.DS_Store$', 'Thumbs\\.db$', 'desktop\\.ini$',
      '\\._[^/]+$', '\\.lck$', '\\.lock$', '~\\$',
      'Ableton Temp Files', '^Backups$', '\\.db$', '\\.log$', 'node_modules',
    ]);
  });
});

describe('ableton adapter', () => {
  it('parses BPM and key from the fixture .als', async () => {
    const meta = await parseAbletonLiveSet(path.join(tmp, 'Fixture Song.als'));
    expect(meta).toEqual({ bpm: 140, key: 'F' });
  });
  it('returns zeroed metadata for a corrupt file, never throws', async () => {
    const bad = path.join(tmp, 'bad.als');
    fs.writeFileSync(bad, Buffer.from('not gzip'));
    expect(await parseAbletonLiveSet(bad)).toEqual({ bpm: 0, key: '' });
  });
  it('golden manifest extras: Ableton Project Info directory marker, deterministic', () => {
    const a = abletonManifestExtras(path.join(tmp, 'Fixture Song.als'), tmp);
    const b = abletonManifestExtras(path.join(tmp, 'Fixture Song.als'), tmp);
    expect(a).toEqual(b);
    expect(a).toEqual([{
      relativePath: 'Ableton Project Info/',
      fileName: 'Ableton Project Info',
      fileSize: 0,
      sha256: null,
      role: 'directory',
      mimeType: null,
      assetId: null,
    }]);
  });
  it('no extras when the Info directory is absent (and generic adapter never adds extras)', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'wavi-bare-'));
    try {
      expect(abletonManifestExtras(path.join(bare, 'x.als'), bare)).toEqual([]);
      expect(genericAdapter.manifestExtras(path.join(bare, 'x.flp'), bare)).toEqual([]);
    } finally { fs.rmSync(bare, { recursive: true, force: true }); }
  });
  it('scanAbletonFolder detects the project, skips Backups, parses BPM', async () => {
    const snap = await scanAbletonFolder(tmp);
    expect(snap.source).toBe('ableton');
    expect(snap.sessionName).toBe('Fixture Song');
    expect(snap.bpm).toBe(140);
    expect(snap.key).toBe('F');
    const names = snap.detectedFiles.map((f) => f.name);
    expect(names).toContain('Fixture Song.als');
    expect(names).toContain('kick.wav');
    expect(names).not.toContain('old [2026-01-01].als'); // Backup/ (Ableton auto-save) dir skipped
  });
  it('preview candidate convention: root preview.wav wins, subfolder audio ignored', () => {
    const files = [
      { file_path: path.join(tmp, 'Samples', 'Imported', 'kick.wav') },
      { file_path: path.join(tmp, 'preview.wav') },
    ];
    expect(findPreviewCandidate(files, tmp)?.file_path).toBe(path.join(tmp, 'preview.wav'));
    expect(findPreviewCandidate([files[0]], tmp)).toBeNull();
  });
  it('adapter object wires the shared + ableton-specific pieces', () => {
    expect(abletonAdapter.projectExtensions).toEqual(['.als']);
    expect(abletonAdapter.classifyFileRole).toBe(classifyFileRole);
    expect(abletonAdapter.safeRelativePath).toBe(safeRelativePath);
  });
});
