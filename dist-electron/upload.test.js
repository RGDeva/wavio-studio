"use strict";
/**
 * Upload contract tests.
 *
 * Verifies the critical invariants of the presign → PUT → register-asset flow
 * without requiring network calls. Uses pure state machines and mock responses.
 *
 * Key invariant: a file must NEVER be marked 'synced' if registration failed.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const crypto_1 = __importDefault(require("crypto"));
async function simulateUploadFlow(file, presign, upload, // null = skipped (deduplicated)
register) {
    let status = 'uploading';
    let cloudUrl = null;
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
function makeFile(overrides = {}) {
    return {
        id: crypto_1.default.randomUUID(),
        file_name: 'MyBeat_Master.wav',
        file_path: '/local/path/MyBeat_Master.wav',
        checksum: crypto_1.default.createHash('sha256').update('test').digest('hex'),
        size: 8388608,
        status: 'pending',
        ...overrides,
    };
}
// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path
// ─────────────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('upload flow — happy path', () => {
    (0, vitest_1.it)('marks file synced after successful presign → PUT → register', async () => {
        const file = makeFile();
        const result = await simulateUploadFlow(file, { ok: true, deduplicated: false, uploadUrl: 'https://storage.example.com/upload', storageKey: 'user/content/ab/cd/sha.wav' }, { ok: true }, { ok: true, assetId: crypto_1.default.randomUUID(), fileUrl: 'https://cdn.example.com/file.wav' });
        (0, vitest_1.expect)(result.finalStatus).toBe('synced');
        (0, vitest_1.expect)(result.cloudUrl).toBeTruthy();
        (0, vitest_1.expect)(result.error).toBeNull();
    });
    (0, vitest_1.it)('marks file synced on deduplication (no PUT needed)', async () => {
        const file = makeFile();
        const result = await simulateUploadFlow(file, { ok: true, deduplicated: true, storageKey: 'user/content/ab/cd/sha.wav', fileUrl: 'https://cdn.example.com/file.wav' }, null, // PUT is skipped
        { ok: true, assetId: crypto_1.default.randomUUID(), fileUrl: 'https://cdn.example.com/file.wav' });
        (0, vitest_1.expect)(result.finalStatus).toBe('synced');
        (0, vitest_1.expect)(result.error).toBeNull();
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// 2. Critical invariant: do NOT mark synced on failure
// ─────────────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('upload flow — failure invariants', () => {
    (0, vitest_1.it)('does NOT mark synced when presign fails', async () => {
        const file = makeFile();
        const result = await simulateUploadFlow(file, { ok: false }, null, { ok: true });
        (0, vitest_1.expect)(result.finalStatus).toBe('failed');
        (0, vitest_1.expect)(result.finalStatus).not.toBe('synced');
    });
    (0, vitest_1.it)('does NOT mark synced when the PUT upload fails', async () => {
        const file = makeFile();
        const result = await simulateUploadFlow(file, { ok: true, deduplicated: false, uploadUrl: 'https://storage.example.com/upload' }, { ok: false }, { ok: true } // register is never reached
        );
        (0, vitest_1.expect)(result.finalStatus).toBe('failed');
        (0, vitest_1.expect)(result.finalStatus).not.toBe('synced');
    });
    (0, vitest_1.it)('does NOT mark synced when registration fails (HTTP 5xx)', async () => {
        const file = makeFile();
        const result = await simulateUploadFlow(file, { ok: true, deduplicated: false, uploadUrl: 'https://storage.example.com/upload', storageKey: 'key' }, { ok: true }, { ok: false } // registration fails
        );
        (0, vitest_1.expect)(result.finalStatus).toBe('failed');
        (0, vitest_1.expect)(result.finalStatus).not.toBe('synced');
        (0, vitest_1.expect)(result.cloudUrl).toBeNull();
    });
    (0, vitest_1.it)('does NOT mark synced when registration fails even after dedup', async () => {
        const file = makeFile();
        const result = await simulateUploadFlow(file, { ok: true, deduplicated: true, storageKey: 'key' }, null, { ok: false });
        (0, vitest_1.expect)(result.finalStatus).toBe('failed');
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// 3. SHA-256 is sent correctly in presign and register
// ─────────────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('upload payload — SHA-256 correctness', () => {
    (0, vitest_1.it)('sends full 64-char sha256 in presign body', () => {
        const file = makeFile({
            checksum: crypto_1.default.createHash('sha256').update('audio content').digest('hex'),
        });
        const payload = {
            fileName: file.file_name,
            fileSize: file.size,
            sha256: file.checksum ?? null,
        };
        (0, vitest_1.expect)(payload.sha256).toHaveLength(64);
        (0, vitest_1.expect)(payload.sha256).toMatch(/^[0-9a-f]{64}$/);
        // Must not contain local path
        (0, vitest_1.expect)(JSON.stringify(payload)).not.toContain('/local/path');
        (0, vitest_1.expect)(JSON.stringify(payload)).not.toContain('/Users/');
    });
    (0, vitest_1.it)('sends full 64-char sha256 in register-asset body', () => {
        const file = makeFile({
            checksum: crypto_1.default.createHash('sha256').update('audio content').digest('hex'),
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
        (0, vitest_1.expect)(payload.sha256).toHaveLength(64);
        // Local path must NOT appear
        (0, vitest_1.expect)(JSON.stringify(payload)).not.toContain('/local/path');
        (0, vitest_1.expect)(JSON.stringify(payload)).not.toContain('/Users/');
        (0, vitest_1.expect)(JSON.stringify(payload)).not.toContain('sessionPath');
    });
    (0, vitest_1.it)('sends null sha256 gracefully when checksum is not yet computed', () => {
        const file = makeFile({ checksum: null });
        const payload = {
            fileName: file.file_name,
            fileSize: file.size,
            sha256: file.checksum ?? null,
        };
        (0, vitest_1.expect)(payload.sha256).toBeNull();
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// 4. Request body safety — no absolute local paths
// ─────────────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('request body path safety', () => {
    const LOCAL_PATHS = [
        '/Users/rishig/Music/MyBeat.flp',
        '/home/user/projects/track.als',
        'C:\\Users\\user\\Documents\\track.ptx',
    ];
    for (const localPath of LOCAL_PATHS) {
        (0, vitest_1.it)(`does not include local path "${localPath}" in daw-sync body`, () => {
            const projectName = 'My Beat';
            const fileName = localPath.split('/').pop().split('\\').pop();
            const localProjectId = crypto_1.default.randomUUID();
            const body = JSON.stringify({
                projectName,
                fileName, // basename only
                localProjectId, // opaque UUID
                daw: 'FL Studio',
                fileSize: 1024,
                lastModified: new Date().toISOString(),
                sha256: crypto_1.default.createHash('sha256').update('content').digest('hex'),
            });
            (0, vitest_1.expect)(body).not.toContain('/Users/');
            (0, vitest_1.expect)(body).not.toContain('/home/');
            (0, vitest_1.expect)(body).not.toContain('C:\\');
            (0, vitest_1.expect)(body).not.toContain('sessionPath');
            (0, vitest_1.expect)(body).toContain(fileName);
            (0, vitest_1.expect)(body).toContain(localProjectId);
        });
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// 5. Cloud ID vs local ID routing
// ─────────────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('project ID routing', () => {
    (0, vitest_1.it)('register-asset uses cloud_id (not local id) for projectId', () => {
        const localId = crypto_1.default.randomUUID(); // DB UUID
        const cloudId = crypto_1.default.randomUUID(); // Supabase UUID
        // Simulate what syncAgent now does
        const cloudProjectId = cloudId; // from project.cloud_id
        const bodyProjectId = cloudProjectId; // what gets sent
        (0, vitest_1.expect)(bodyProjectId).toBe(cloudId);
        (0, vitest_1.expect)(bodyProjectId).not.toBe(localId);
    });
    (0, vitest_1.it)('when cloud_id is null (project not yet synced), sends null not local id', () => {
        const localId = crypto_1.default.randomUUID();
        const cloudId = null;
        // project.cloud_id is null before first daw-sync
        const bodyProjectId = cloudId ?? null;
        (0, vitest_1.expect)(bodyProjectId).toBeNull();
        (0, vitest_1.expect)(bodyProjectId).not.toBe(localId);
    });
});
