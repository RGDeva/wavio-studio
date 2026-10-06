/**
 * Does the allowlist describe the tools that actually exist?
 *
 * The allowlist names arguments by hand. A name that disagrees with the
 * canonical tool produces the most confusing failure available: a proposal
 * that passes every agent gate and is then rejected by the tool's own input
 * validation, for a reason the user never sees. A hand-written mirror of
 * someone else's contract drifts — this one already did, declaring `fileId`
 * for a tool whose parameter is `fileName`.
 *
 * So rather than restate the contract, these tests EXTRACT it from the tool
 * source. A fixture that encodes our own assumption would prove nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTION_ALLOWLIST } from './agentActions';

const SOURCE = readFileSync(join(__dirname, '..', 'copilotTools', 'localTools.ts'), 'utf8');

/** Parameter names the real tool declares, read out of its own source. */
function declaredParams(tool: string): Set<string> {
  const start = SOURCE.indexOf(`name: '${tool}'`);
  if (start < 0) throw new Error(`tool ${tool} not found in localTools.ts`);
  const end = SOURCE.indexOf('execution:', start);
  expect(end).toBeGreaterThan(start);
  const block = SOURCE.slice(start, end);

  const names = new Set<string>();
  for (const m of block.matchAll(/(\w+):\s*\{\s*type:/g)) names.add(m[1]);
  // The shared `projectIdParam` spread contributes `projectId`.
  if (block.includes('...projectIdParam')) names.add('projectId');
  return names;
}

describe('the allowlist matches the real tool contracts', () => {
  it('every allowlisted tool exists in the registry source', () => {
    for (const name of Object.keys(ACTION_ALLOWLIST)) {
      expect(SOURCE).toContain(`name: '${name}'`);
    }
  });

  it('every allowed argument is one the canonical tool actually declares', () => {
    for (const [name, entry] of Object.entries(ACTION_ALLOWLIST)) {
      const real = declaredParams(name);
      for (const arg of entry.allowed) {
        expect(real, `${name}.allowed contains "${arg}"`).toContain(arg);
      }
    }
  });

  it('every required argument is one the canonical tool actually declares', () => {
    // This is the check that would have caught `fileId`.
    for (const [name, entry] of Object.entries(ACTION_ALLOWLIST)) {
      const real = declaredParams(name);
      for (const arg of entry.required) {
        expect(real, `${name}.required contains "${arg}"`).toContain(arg);
      }
    }
  });

  it('declares every argument the tool requires, so a proposal can succeed', () => {
    // The inverse direction: an argument the TOOL requires but the allowlist
    // omits means the agent can only ever propose something incomplete.
    for (const [name, entry] of Object.entries(ACTION_ALLOWLIST)) {
      const start = SOURCE.indexOf(`name: '${name}'`);
      const block = SOURCE.slice(start, SOURCE.indexOf('execution:', start));
      for (const m of block.matchAll(/(\w+):\s*\{\s*type:\s*'[^']+',\s*description:[^}]*\}/g)) {
        const isOptional = /required:\s*false/.test(m[0]);
        if (!isOptional) expect(entry.required, `${name} must require "${m[1]}"`).toContain(m[1]);
      }
    }
  });

  it('every mutating entry is a tool the registry itself gates', () => {
    // The agent's confirmation requirement must not be the ONLY thing standing
    // between a model and a mutation; the tool has to gate it too.
    for (const [name, entry] of Object.entries(ACTION_ALLOWLIST)) {
      if (!entry.mutating) continue;
      const start = SOURCE.indexOf(`name: '${name}'`);
      const block = SOURCE.slice(start, SOURCE.indexOf('run:', start));
      expect(block, `${name} must set requiresConfirmation in the registry`).toContain('requiresConfirmation: true');
    }
  });

  it('withholds the destructive and access-granting tools that DO exist', () => {
    // Each of these is implemented and reachable by a human; none is
    // proposable by the agent. Asserting the registry has them keeps this
    // honest — it is a withholding, not an absence.
    for (const withheld of ['revoke_project_link', 'invite_collaborator', 'open_file', 'publish_version']) {
      expect(SOURCE + readFileSync(join(__dirname, '..', 'copilotTools', 'index.ts'), 'utf8'))
        .toContain(`name: '${withheld}'`);
      expect(ACTION_ALLOWLIST[withheld]).toBeUndefined();
    }
  });
});
