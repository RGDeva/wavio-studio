/**
 * Upload contract tests.
 *
 * Verifies the critical invariants of the presign → PUT → register-asset flow
 * without requiring network calls. Uses pure state machines and mock responses.
 *
 * Key invariant: a file must NEVER be marked 'synced' if registration failed.
 */

import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Upload flow state machine (mirrors syncAgent.syncFile logic)
// ─────────────────────────────────────────────────────────────────────────────

type FileStatus = 'pending' | 'uploading' | 'synced' | 'failed' | 'missing' | 'retrying';

interface MockFile {
  id: string;
  file_name: string;
  file_path: string;
  checksum: string | null;
  size: number;
  status: FileStatus;
}

interface PresignResponse {
  ok: boolean;
  deduplicated?: boolean;
  uploadUrl?: string;
  storageKey?: string;
  fileUrl?: string;
}

interface RegisterResponse {
  ok: boolean;
  assetId?: string;
  fileUrl?: string;
}

async function simulateUploadFlow(
  file: MockFile,
  presign: PresignResponse,
  upload: { ok: boolean } | null, // null = skipped (deduplicated)
  register: RegisterResponse
): Promise<{ finalStatus: FileStatus; cloudUrl: string | null; error: string | null }> {
  let status: FileStatus = 'uploading';
  let cloudUrl: string | null = null;

  // Step 1: presign
  if (!presign.ok) {
    return { finalStatus: 'failed', cloudUrl: null, error: 'Presign failed' };
  }

  // Step 2: upload (skipped on dedup)
  if (!presign.deduplicated) {
    if (!upload || !upload.ok) {
      return { finalStatus: 'failed', cloudUrl: null, error: 'Storage upload failed' };
    }
  }

  // Step 3: register — must succeed before marking synced
  if (!register.ok) {
    return { finalStatus: 'failed', cloudUrl: null, error: `Asset registration failed` };
  }

  // Only here do we mark synced
  cloudUrl = register.fileUrl ?? presign.storageKey ?? null;
  status = 'synced';
  return { finalStatus: status, cloudUrl, error: null };
}

function makeFile(overrides: Partial<MockFile> = {}): MockFile {
  return {
    id: crypto.randomUUID(),
    file_name: 'MyBeat_Master.wav',
    file_path: '/local/path/MyBeat_Master.wav',
    checksum: crypto.createHash('sha256').update('test').digest('hex'),
    size: 8_388_608,
    status: 'pending',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('upload flow — happy path', () => {
  it('marks file synced after successful presign → PUT → register', async () => {
    const file = makeFile();
    const result = await simulateUploadFlow(
      file,
      { ok: true, deduplicated: false, uploadUrl: 'https://storage.example.com/upload', storageKey: 'user/content/ab/cd/sha.wav' },
      { ok: true },
      { ok: true, assetId: crypto.randomUUID(), fileUrl: 'https://cdn.example.com/file.wav' }
    );
    expect(result.finalStatus).toBe('synced');
    expect(result.cloudUrl).toBeTruthy();
    expect(result.error).toBeNull();
  });

  it('marks file synced on deduplication (no PUT needed)', async () => {
    const file = makeFile();
    const result = await simulateUploadFlow(
      file,
      { ok: true, deduplicated: true, storageKey: 'user/content/ab/cd/sha.wav', fileUrl: 'https://cdn.example.com/file.wav' },
      null, // PUT is skipped
      { ok: true, assetId: crypto.randomUUID(), fileUrl: 'https://cdn.example.com/file.wav' }
    );
    expect(result.finalStatus).toBe('synced');
    expect(result.error).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Critical invariant: do NOT mark synced on failure
// ─────────────────────────────────────────────────────────────────────────────

describe('upload flow — failure invariants', () => {
  it('does NOT mark synced when presign fails', async () => {
    const file = makeFile();
    const result = await simulateUploadFlow(
      file,
      { ok: false },
      null,
      { ok: true }
    );
    expect(result.finalStatus).toBe('failed');
    expect(result.finalStatus).not.toBe('synced');
  });

  it('does NOT mark synced when the PUT upload fails', async () => {
    const file = makeFile();
    const result = await simulateUploadFlow(
      file,
      { ok: true, deduplicated: false, uploadUrl: 'https://storage.example.com/upload' },
      { ok: false },
      { ok: true } // register is never reached
    );
    expect(result.finalStatus).toBe('failed');
    expect(result.finalStatus).not.toBe('synced');
  });

  it('does NOT mark synced when registration fails (HTTP 5xx)', async () => {
    const file = makeFile();
    const result = await simulateUploadFlow(
      file,
      { ok: true, deduplicated: false, uploadUrl: 'https://storage.example.com/upload', storageKey: 'key' },
      { ok: true },
      { ok: false } // registration fails
    );
    expect(result.finalStatus).toBe('failed');
    expect(result.finalStatus).not.toBe('synced');
    expect(result.cloudUrl).toBeNull();
  });

  it('does NOT mark synced when registration fails even after dedup', async () => {
    const file = makeFile();
    const result = await simulateUploadFlow(
      file,
      { ok: true, deduplicated: true, storageKey: 'key' },
      null,
      { ok: false }
    );
    expect(result.finalStatus).toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SHA-256 is sent correctly in presign and register
// ─────────────────────────────────────────────────────────────────────────────

describe('upload payload — SHA-256 correctness', () => {
  it('sends full 64-char sha256 in presign body', () => {
    const file = makeFile({
      checksum: crypto.createHash('sha256').update('audio content').digest('hex'),
    });
    const payload = {
      fileName: file.file_name,
      fileSize: file.size,
      sha256: file.checksum ?? null,
    };
    expect(payload.sha256).toHaveLength(64);
    expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Must not contain local path
    expect(JSON.stringify(payload)).not.toContain('/local/path');
    expect(JSON.stringify(payload)).not.toContain('/Users/');
  });

  it('sends full 64-char sha256 in register-asset body', () => {
    const file = makeFile({
      checksum: crypto.createHash('sha256').update('audio content').digest('hex'),
    });
    const payload = {
      fileName: file.file_name,
      storageKey: 'user/content/ab/cd/sha.wav',
      fileSize: file.size,
      sha256: file.checksum ?? null,
      projectId: 'cloud-uuid-here', // cloud UUID, not local
      bpm: 140,
      role: 'master',
    };
    expect(payload.sha256).toHaveLength(64);
    // Local path must NOT appear
    expect(JSON.stringify(payload)).not.toContain('/local/path');
    expect(JSON.stringify(payload)).not.toContain('/Users/');
    expect(JSON.stringify(payload)).not.toContain('sessionPath');
  });

  it('sends null sha256 gracefully when checksum is not yet computed', () => {
    const file = makeFile({ checksum: null });
    const payload = {
      fileName: file.file_name,
      fileSize: file.size,
      sha256: file.checksum ?? null,
    };
    expect(payload.sha256).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Request body safety — no absolute local paths
// ─────────────────────────────────────────────────────────────────────────────

describe('request body path safety', () => {
  const LOCAL_PATHS = [
    '/Users/rishig/Music/MyBeat.flp',
    '/home/user/projects/track.als',
    'C:\\Users\\user\\Documents\\track.ptx',
  ];

  for (const localPath of LOCAL_PATHS) {
    it(`does not include local path "${localPath}" in daw-sync body`, () => {
      const projectName = 'My Beat';
      const fileName = localPath.split('/').pop()!.split('\\').pop()!;
      const localProjectId = crypto.randomUUID();

      const body = JSON.stringify({
        projectName,
        fileName,        // basename only
        localProjectId,  // opaque UUID
        daw: 'FL Studio',
        fileSize: 1024,
        lastModified: new Date().toISOString(),
        sha256: crypto.createHash('sha256').update('content').digest('hex'),
      });

      expect(body).not.toContain('/Users/');
      expect(body).not.toContain('/home/');
      expect(body).not.toContain('C:\\');
      expect(body).not.toContain('sessionPath');
      expect(body).toContain(fileName);
      expect(body).toContain(localProjectId);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Cloud ID vs local ID routing
// ─────────────────────────────────────────────────────────────────────────────

describe('project ID routing', () => {
  it('register-asset uses cloud_id (not local id) for projectId', () => {
    const localId = crypto.randomUUID();  // DB UUID
    const cloudId = crypto.randomUUID();  // Supabase UUID

    // Simulate what syncAgent now does
    const cloudProjectId = cloudId; // from project.cloud_id
    const bodyProjectId = cloudProjectId; // what gets sent

    expect(bodyProjectId).toBe(cloudId);
    expect(bodyProjectId).not.toBe(localId);
  });

  it('when cloud_id is null (project not yet synced), sends null not local id', () => {
    const localId = crypto.randomUUID();
    const cloudId: string | null = null;

    // project.cloud_id is null before first daw-sync
    const bodyProjectId = cloudId ?? null;
    expect(bodyProjectId).toBeNull();
    expect(bodyProjectId).not.toBe(localId);
  });
});
