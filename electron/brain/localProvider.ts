/**
 * An optional local open-model provider.
 *
 * Speaks the Ollama-style HTTP API (`/api/generate`), which llama.cpp's
 * server, LM Studio and Ollama itself all expose. That choice avoids adding a
 * native dependency or bundling weights: if the user has a runtime, Wavi can
 * use it; if not, nothing changes.
 *
 * **Local means local.** The endpoint is validated to be a loopback address
 * and rejected otherwise — not as a convention but as a check that runs before
 * every request. A "local provider" pointed at someone's server would quietly
 * ship the user's workspace off the machine, which is the one thing this whole
 * design exists to prevent.
 *
 * The provider is never required: NullProvider remains the default, and every
 * answer has a deterministic form that does not involve a model at all.
 */
import type { LlmProvider, LlmRequest, LlmResponse } from './llmProvider';

/** Hostnames that are genuinely this machine. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export type ValidationResult = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Accept only a loopback HTTP endpoint.
 *
 * Checked on every call rather than once at construction: a provider whose
 * endpoint is reconfigured at runtime must not be able to escape the rule.
 */
export function validateLocalEndpoint(raw: string): ValidationResult {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: 'not a valid URL' }; }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol "${url.protocol}"` };
  }
  const host = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    // The entire point: a model endpoint that is not on this machine would
    // send the user's workspace somewhere else.
    return { ok: false, reason: `"${host}" is not a loopback address — a local model must run on this machine` };
  }
  return { ok: true, url };
}

export interface LocalProviderOptions {
  /** e.g. http://127.0.0.1:11434 */
  endpoint: string;
  /** Model name as the runtime knows it, e.g. 'llama3.2'. */
  model: string;
  /** Hard ceiling on a single generation. */
  timeoutMs?: number;
  /** Injected so tests do not touch the network. */
  fetchImpl?: typeof fetch;
}

export class LocalHttpProvider implements LlmProvider {
  readonly id = 'local-http';
  readonly displayName: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(opts: LocalProviderOptions) {
    this.endpoint = opts.endpoint;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.displayName = `Local model (${opts.model})`;
  }

  /**
   * True only when the endpoint is loopback AND the runtime answers.
   *
   * Returns false rather than throwing: "no model installed" is the normal
   * case, not an error, and the caller already has a deterministic answer.
   */
  async isAvailable(): Promise<boolean> {
    const v = validateLocalEndpoint(this.endpoint);
    if (!v.ok) return false;
    try {
      const res = await this.doFetch(`${v.url.origin}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(2_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const v = validateLocalEndpoint(this.endpoint);
    if (!v.ok) {
      // Fail closed and say why. Never fall back to some other endpoint.
      return { text: '', provider: this.id, unavailable: true };
    }

    // The caller passes an already-built, already-grounded prompt. The
    // provider does not assemble context itself — it has no access to the
    // database or the filesystem, and must not acquire any.
    const prompt = typeof req.context === 'string' ? req.context : String(req.context ?? '');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.doFetch(`${v.url.origin}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: { num_predict: req.maxOutputTokens ?? 400 },
        }),
        signal: req.signal ?? controller.signal,
      });
      if (!res.ok) return { text: '', provider: this.id, unavailable: true };
      const data = await res.json() as { response?: unknown };
      const text = typeof data?.response === 'string' ? data.response.trim() : '';
      return text
        ? { text, provider: this.id }
        : { text: '', provider: this.id, unavailable: true };
    } catch {
      // Timeout, refused connection, malformed JSON — all the same to the
      // caller, which falls back to the deterministic answer.
      return { text: '', provider: this.id, unavailable: true };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build a provider from settings, or null when none is configured.
 *
 * Returning null (rather than a half-configured provider) keeps "no local
 * model" the explicit, default state.
 */
export function createLocalProvider(settings: {
  enabled?: boolean;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
} | null | undefined, fetchImpl?: typeof fetch): LocalHttpProvider | null {
  if (!settings?.enabled) return null;
  if (!settings.endpoint || !settings.model) return null;
  if (!validateLocalEndpoint(settings.endpoint).ok) return null;
  return new LocalHttpProvider({
    endpoint: settings.endpoint,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    fetchImpl,
  });
}
