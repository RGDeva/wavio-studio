# Local Agent runtime and model choice

Why Wavi talks to a local runtime over HTTP instead of embedding one, and what model to point
it at. Recorded because this decision shapes the installer, the licence surface and the
support burden far more than the code does.

---

## The constraint that decides it

Wavi is a **notarised macOS Electron app**. That rules out the options people usually reach
for first:

| Option | Why not, for v1 |
|---|---|
| **llama.cpp as a native addon** | A per-architecture native binary inside the bundle. It must be signed and notarised with the app, rebuilt for every Electron/Node ABI bump, and it drags the existing better-sqlite3 ABI problem into a second dependency — the one this codebase has already been bitten by repeatedly. |
| **MLX** | Genuinely the best Apple-Silicon runtime, and the right long-term answer. But it is a Python stack: shipping it means bundling a Python runtime or requiring the user to install one, and it excludes Intel Macs entirely. |
| **Bundling weights** | The smallest useful instruct model is ~2 GB quantised. That more than quadruples the installer, cannot go in git, and commits Wavi to redistributing someone else's weights under their licence. |

## What was chosen

**Talk to a local HTTP runtime the user already has, over loopback.**

The `/api/generate` + `/api/tags` shape is implemented by **Ollama, llama.cpp's own
`llama-server`, and LM Studio**. Supporting that shape means Wavi supports all three without
naming any of them as a dependency.

This buys:

- **No new native dependency**, no notarisation surface, no second ABI to track.
- **No weights in the repo** and none in the installer — package size is unchanged, which
  `verify:package` confirms.
- **No account, no API key, no network egress** — loopback is enforced before every request.
- **Nothing to uninstall**: a user who never sets this up has an app that behaves exactly as
  it does today.

The cost, stated plainly: **the user must install a runtime themselves**. That is acceptable
precisely because the feature is optional — Project Brain answers every question without it,
so the fallback is a complete product rather than a degraded one.

### Not a hard dependency on Ollama

Nothing imports an Ollama SDK or assumes Ollama specifically. The endpoint is user-configured
and the API shape is the de-facto local-inference convention. If the preferred runtime changes,
only `localProvider.ts` changes.

---

## Model guidance

Not pinned in code — the endpoint and model name are user settings, so the runtime decides
what is installed. For the short, structured, context-grounded task Wavi asks for:

| Model | Params | Quant | Disk | Licence note |
|---|---|---|---|---|
| **Llama 3.2 Instruct** | 3B | Q4_K_M | ~2.0 GB | Meta Llama 3.2 Community Licence — permissive for most uses, but **it is not OSI-open**; review before redistributing. |
| **Qwen 2.5 Instruct** | 3B | Q4_K_M | ~1.9 GB | Apache-2.0 — the cleanest licence of the three. |
| **Mistral 7B Instruct** | 7B | Q4_K_M | ~4.4 GB | Apache-2.0. Better reasoning, noticeably heavier. |

**Requirements the task actually imposes:** reliable short-context reasoning and the ability
to emit a small JSON object. It does *not* need long context — `CONTEXT_LIMITS` keeps prompts
under roughly 8 KB — and it does not need tool use, because Wavi takes no actions from model
output.

A 3B Q4 model is the sweet spot: ~2–3 GB resident, fast on Apple Silicon, and adequate for
rephrasing an answer that is already correct.

**Licence caution:** if Wavi ever ships weights, Qwen/Mistral (Apache-2.0) are materially
safer than Llama. Today Wavi ships none, so the user's own choice governs.

---

## Lifecycle

`modelLifecycle.ts` distinguishes `disabled` / `checking` / `ready` / `unavailable` /
`model-missing` / `error`. The `model-missing` state exists because "the runtime isn't
running" and "the runtime is running but that model isn't pulled" need completely different
fixes, and telling a user the wrong one wastes their time.

**Startup never waits for a model.** The probe is a 2-second loopback call made when the UI
asks for status, not during boot.

## Performance notes — and their limits

Not measured against a real model: **ENV-1 blocks Electron on this machine, and no runtime was
installed**, so any latency figure here would be invented. What *is* measured:

- **Prompt size is bounded** — a 25,000-file library produces a prompt under 8 KB, asserted
  in tests. That is the input half of inference cost, and it is the half Wavi controls.
- **No reload per message** — the provider holds no model state; the runtime keeps the model
  resident between requests, which is exactly why an external runtime is attractive.
- **No scanning during inference** — the context is assembled from SQLite rows already
  indexed; the filesystem is not touched.

Real cold/warm numbers need a machine where Electron runs and a runtime is installed.
