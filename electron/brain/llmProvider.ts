/**
 * Project Brain — the local-model boundary.
 *
 * This milestone deliberately ships NO model. What it ships is the seam, so
 * the next one can plug in llama.cpp, MLX, an Ollama-style server or anything
 * else without touching retrieval, memory or the index.
 *
 * The contract is one-directional and narrow on purpose:
 *
 *   · a provider receives ALREADY-RETRIEVED context and a question
 *   · a provider returns prose
 *   · a provider never reads the filesystem, the database, or the network on
 *     the brain's behalf
 *
 * That is what keeps the model a renderer of facts rather than a source of
 * them. A provider that could fetch its own context would be able to answer
 * from something the index never saw, and the determinism guarantee would be
 * gone.
 *
 * `NullProvider` is the default and is not a stub for testing — it is the
 * shipping configuration. Every question Project Brain answers today is
 * answered without it.
 */

export interface LlmRequest {
  /** The user's question, verbatim. */
  question: string;
  /**
   * Context the BRAIN retrieved. A provider may only reason over this.
   * Typically a ContextPack, search hits, or derived memory — already bounded,
   * already attributed, already free of paths and credentials.
   */
  context: unknown;
  /** Hard ceiling the caller is willing to spend. */
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  /** Which provider produced this, for display and for audit. */
  provider: string;
  /** True when no model ran — the caller should fall back to deterministic output. */
  unavailable?: boolean;
}

export interface LlmProvider {
  readonly id: string;
  readonly displayName: string;
  /** False until a runtime is actually installed and reachable. */
  isAvailable(): Promise<boolean>;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * The shipping default: no model.
 *
 * It answers every request by saying so, rather than by inventing text, so a
 * caller that forgets to check `isAvailable()` degrades into an honest
 * "no model configured" instead of a fabricated answer.
 */
export class NullProvider implements LlmProvider {
  readonly id = 'none';
  readonly displayName = 'No local model';
  async isAvailable(): Promise<boolean> { return false; }
  async complete(): Promise<LlmResponse> {
    return {
      provider: this.id,
      unavailable: true,
      text: 'No local model is configured. Wavi answered from its own index instead.',
    };
  }
}

let active: LlmProvider = new NullProvider();

export function getLlmProvider(): LlmProvider { return active; }

/**
 * Install a provider. Separate from construction so a future runtime can be
 * swapped at runtime (installed, upgraded, removed) without a restart.
 */
export function setLlmProvider(provider: LlmProvider): void { active = provider; }

/** Restore the shipping default. */
export function resetLlmProvider(): void { active = new NullProvider(); }

/**
 * Ask the active provider to phrase an answer, falling back to deterministic
 * text when no model is available.
 *
 * `deterministicAnswer` is required rather than optional: a caller must always
 * have a real answer in hand before a model is consulted. That ordering is the
 * guarantee — the model improves the wording, it never supplies the substance.
 */
export async function phraseAnswer(
  req: LlmRequest,
  deterministicAnswer: string,
): Promise<LlmResponse> {
  const provider = getLlmProvider();
  try {
    if (!(await provider.isAvailable())) {
      return { text: deterministicAnswer, provider: provider.id, unavailable: true };
    }
    const res = await provider.complete(req);
    if (!res?.text?.trim()) return { text: deterministicAnswer, provider: provider.id, unavailable: true };
    return res;
  } catch {
    // A failing model must never take the answer down with it.
    return { text: deterministicAnswer, provider: provider.id, unavailable: true };
  }
}
