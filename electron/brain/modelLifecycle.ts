/**
 * Local-model lifecycle.
 *
 * The states exist so the UI can be honest about what is actually happening,
 * and so nothing anywhere blocks on a model. Project Brain answers in every
 * one of these states — the lifecycle only decides whether an answer gets
 * rephrased, never whether it exists.
 *
 * Startup never waits for a model: a probe is a short network call to
 * loopback, and until it resolves the state is simply 'checking'.
 *
 * Pure: no I/O, no clock. The caller performs the probe.
 */

export type ModelState =
  /** No local model configured. The default, and a normal end state. */
  | 'disabled'
  /** Configured; we have not yet confirmed the runtime answers. */
  | 'checking'
  /** Runtime reachable and a model is loaded. */
  | 'ready'
  /** Configured but the runtime is not reachable (not installed/not running). */
  | 'unavailable'
  /** Configured, runtime reachable, but the named model is not present. */
  | 'model-missing'
  /** Something failed in a way worth showing. */
  | 'error';

export interface ModelStatus {
  state: ModelState;
  /** Short, human phrasing for the UI. Never a stack trace. */
  label: string;
  /** True only when a model can actually be used right now. */
  usable: boolean;
  /** What Wavi will do — stated plainly, because it is always true. */
  fallback: string;
  detail?: string;
}

const FALLBACK = 'Answers come from your local index either way.';

export function describeModelState(state: ModelState, detail?: string): ModelStatus {
  switch (state) {
    case 'disabled':
      return { state, label: 'Deterministic mode', usable: false, fallback: FALLBACK,
               detail: detail ?? 'No local model configured.' };
    case 'checking':
      return { state, label: 'Checking for local AI…', usable: false, fallback: FALLBACK, detail };
    case 'ready':
      return { state, label: 'Local AI ready', usable: true, fallback: FALLBACK, detail };
    case 'unavailable':
      return { state, label: 'Local AI unavailable', usable: false, fallback: FALLBACK,
               detail: detail ?? 'The local model runtime is not running.' };
    case 'model-missing':
      return { state, label: 'Local AI unavailable', usable: false, fallback: FALLBACK,
               detail: detail ?? 'The configured model is not installed in the runtime.' };
    case 'error':
      return { state, label: 'Local AI unavailable', usable: false, fallback: FALLBACK,
               // Deliberately not the raw error: a stack trace in the UI is
               // noise to a musician and may carry paths.
               detail: detail ?? 'The local model could not be reached.' };
  }
}

export interface ProbeInput {
  configured: boolean;
  /** Did the runtime respond at all? */
  reachable: boolean;
  /** Models the runtime reports, when it responded. */
  installedModels?: string[];
  /** The model the user asked for. */
  wantedModel?: string | null;
  error?: string;
}

/**
 * Turn a probe result into a state.
 *
 * Distinguishes "runtime not running" from "runtime running but that model
 * isn't pulled" because the fixes are completely different, and telling a user
 * the wrong one wastes their time.
 */
export function resolveModelState(probe: ProbeInput): ModelStatus {
  if (!probe.configured) return describeModelState('disabled');
  if (probe.error) return describeModelState('error', probe.error);
  if (!probe.reachable) return describeModelState('unavailable');

  if (probe.wantedModel && Array.isArray(probe.installedModels)) {
    const want = probe.wantedModel.toLowerCase();
    // Runtimes report tagged names ("llama3.2:3b"); match on the base name so
    // a tag difference is not reported as a missing model.
    const have = probe.installedModels.some((m) => {
      const n = m.toLowerCase();
      return n === want || n.split(':')[0] === want.split(':')[0];
    });
    if (!have) {
      return describeModelState('model-missing', `"${probe.wantedModel}" is not installed in the runtime.`);
    }
  }
  return describeModelState('ready');
}
