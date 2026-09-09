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
import { safeRelativePath, classifyFileRole, findPreviewCandidate, PUBLISH_EXCLUDE, locateProjectFile, RESTORE_PROJECT_EXTENSIONS } from './common';

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
  // Regression: the shape of a REAL Live 12 set, which the small fixture above
  // cannot represent. Two things broke on genuine files and neither was visible
  // to a compact fixture:
  //   1. MasterTrack tempo sits near the END of the document (measured at byte
  //      293,923 / 334,317 and 154,040 / 194,360 in two real projects), far past
  //      the old 16KB read window.
  //   2. A loose /<Tempo>(?:<[^>]+>\s*)*<Manual …/ scan matches ANY tag, so it
  //      runs to EOF and backtracks to the last <Manual> in the file. The decoy
  //      below reproduces that: a naive scan reports 1 instead of 128.
  it('parses BPM from a real-shaped set: tempo far past 16KB, with a trailing decoy <Manual>', async () => {
    const filler = '      <Track><Name Value="pad" /></Track>\n'.repeat(1200); // ≫16KB
    const big = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="12.0_12402">
  <LiveSet>
    <Tracks>
${filler}    </Tracks>
    <MasterTrack>
      <DeviceChain><Mixer>
        <Tempo>
          <LomId Value="0" />
          <Manual Value="128" />
          <MidiControllerRange><Min Value="60" /><Max Value="200" /></MidiControllerRange>
        </Tempo>
      </Mixer></DeviceChain>
    </MasterTrack>
    <PostTempoDevice><Manual Value="1" /></PostTempoDevice>
  </LiveSet>
</Ableton>`;
    const real = path.join(tmp, 'Real Shaped.als');
    fs.writeFileSync(real, zlib.gzipSync(Buffer.from(big)));
    expect(Buffer.byteLength(big)).toBeGreaterThan(16384);
    expect(big.indexOf('<Tempo>')).toBeGreaterThan(16384);
    expect(await parseAbletonLiveSet(real)).toEqual({ bpm: 128, key: '' });
  });
  // Live 12 emits no KeySignature at all (0 occurrences in both real projects),
  // so a bare <Tonic> can only belong to a device preset and must not be
  // reported as the project key.
  it('ignores a <Tonic> that is not inside a KeySignature element', async () => {
    const stray = path.join(tmp, 'Stray Tonic.als');
    fs.writeFileSync(stray, zlib.gzipSync(Buffer.from(
      '<Ableton><LiveSet><Device><Tonic Value="5" /></Device>' +
      '<MasterTrack><Tempo><Manual Value="90" /></Tempo></MasterTrack></LiveSet></Ableton>'
    )));
    expect(await parseAbletonLiveSet(stray)).toEqual({ bpm: 90, key: '' });
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

describe('capability reporting', () => {
  it('Ableton reports native detect/package/restore/same-DAW open; no cross-DAW/scan/fidelity yet', () => {
    expect(abletonAdapter.capabilities()).toEqual({
      detect: true, packageNative: true, restore: true, sameDawOpen: true,
      crossDawReconstruct: false, scanPlugins: false, fidelityReport: false,
    });
  });
  it('generic DAW reports restore only', () => {
    expect(genericAdapter.capabilities()).toEqual({
      detect: false, packageNative: false, restore: true, sameDawOpen: false,
      crossDawReconstruct: false, scanPlugins: false, fidelityReport: false,
    });
  });
  it('capabilities are honest booleans (no true for unimplemented features)', () => {
    for (const a of [abletonAdapter, genericAdapter]) {
      const c = a.capabilities();
      expect(c.crossDawReconstruct).toBe(false);
      expect(c.scanPlugins).toBe(false);
      expect(c.fidelityReport).toBe(false);
    }
  });
});

describe('restore project-file location (behavior-preserving extraction)', () => {
  it('RESTORE_PROJECT_EXTENSIONS is exactly the pre-extraction set', () => {
    // Must match the inline list restore:start used, in order — DR-013/WS-006.
    expect([...RESTORE_PROJECT_EXTENSIONS]).toEqual(['.als', '.ptx', '.logic', '.flp', '.cpr', '.npr']);
  });

  it('locates a nested DAW project file (recursive, case-insensitive ext)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wavi-restore-loc-'));
    fs.mkdirSync(path.join(d, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(d, 'inner', 'Song.ALS'), Buffer.from('x'));
    expect(locateProjectFile(d)).toBe(path.join(d, 'inner', 'Song.ALS'));
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('returns null when no project file is present, and both adapters delegate to it', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wavi-restore-none-'));
    fs.writeFileSync(path.join(d, 'notes.txt'), Buffer.from('x'));
    fs.writeFileSync(path.join(d, 'kick.wav'), Buffer.from('x'));
    expect(locateProjectFile(d)).toBeNull();
    // Adapters expose the same behavior through the contract method.
    expect(abletonAdapter.locateProjectFile(d)).toBeNull();
    expect(genericAdapter.locateProjectFile(d)).toBeNull();
    const wav = path.join(d, 'x.flp');
    fs.writeFileSync(wav, Buffer.from('x'));
    expect(abletonAdapter.locateProjectFile(d)).toBe(wav); // restore is DAW-agnostic
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('missing directory returns null (no throw)', () => {
    expect(locateProjectFile(path.join(os.tmpdir(), 'wavi-does-not-exist-xyz'))).toBeNull();
  });
});
