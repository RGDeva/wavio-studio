import { describe, it, expect } from 'vitest';
import { toToolCardModel, isStaleForProject } from './assistantToolCard';

describe('assistant tool-result card view-model', () => {
  it('success result → success tone, no failure, not retryable', () => {
    const m = toToolCardModel('inspect_project', { status: 'done', message: 'ok', projectId: 'p1' }, 'My Song');
    expect(m).toMatchObject({ action: 'Inspect project', tone: 'success', projectLabel: 'My Song', retryable: false });
    expect(m.failureReason).toBeUndefined();
  });

  it('error result → error tone, failure reason, retryable', () => {
    const m = toToolCardModel('list_local_versions', { status: 'error', error: 'db boom' }, 'My Song');
    expect(m.tone).toBe('error');
    expect(m.failureReason).toBe('db boom');
    expect(m.retryable).toBe(true);
  });

  it('needs_confirmation → pending tone, not retryable', () => {
    const m = toToolCardModel('reveal_file', { status: 'needs_confirmation', message: 'Confirm?' }, 'My Song');
    expect(m.tone).toBe('pending');
    expect(m.retryable).toBe(false);
  });

  it('server-blocked → blocked tone, reason shown, NOT retryable', () => {
    const m = toToolCardModel('create_project_link', { status: 'error', error: 'contract pending', blockedReason: 'server_contract_pending' }, 'My Song');
    expect(m.tone).toBe('blocked');
    expect(m.blockedReason).toBe('server_contract_pending');
    expect(m.retryable).toBe(false);
  });

  it('auth-required block IS retryable (sign in then retry)', () => {
    const m = toToolCardModel('publish_version', { status: 'error', error: 'sign in', blockedReason: 'authentication_required' }, 'My Song');
    expect(m.tone).toBe('blocked');
    expect(m.retryable).toBe(true);
  });

  it('no active project → honest label, never a fabricated name', () => {
    expect(toToolCardModel('inspect_project', { status: 'done', message: 'ok' }, null).projectLabel).toBe('No project selected');
    expect(toToolCardModel('inspect_project', { status: 'done', message: 'ok' }, '  ').projectLabel).toBe('No project selected');
  });
});

describe('stale-result discard guard', () => {
  it('discards a result whose projectId no longer matches the active project', () => {
    expect(isStaleForProject({ status: 'done', projectId: 'p_old' }, 'p_new')).toBe(true);
    expect(isStaleForProject({ status: 'done', projectId: 'p1' }, 'p1')).toBe(false);
  });
  it('project-agnostic results (no projectId) are kept', () => {
    expect(isStaleForProject({ status: 'done' }, 'p1')).toBe(false);
  });
  it('with no active project, any project-scoped result is stale', () => {
    expect(isStaleForProject({ status: 'done', projectId: 'p1' }, null)).toBe(true);
  });
});
