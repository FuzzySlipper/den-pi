import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_URL = "http://127.0.0.1:18082";

// Backend type strings that den-router's /routes reports. The
// extension maps these to Pi provider api kinds so each model uses
// the wire format its backend actually accepts.
//
// "codex-oauth" → "openai-responses"
//   Codex only accepts the Responses API. Pi's openai-responses
//   provider sends Responses bodies (input, instructions, ...) to
//   baseURL/responses. With baseUrl=".../v1" that lands on den-router's
//   /v1/responses, which routes to chatgpt.com/backend-api/codex/responses
//   with the right originator/OpenAI-Beta/ChatGPT-Account-ID headers.
//
// "standard" (or empty/unknown) → "openai-completions"
//   Most hosted providers (DeepSeek, Xiaomi, GLM, ...) only accept
//   chat completions bodies. Pi's openai-completions provider sends
//   messages: [...] to baseURL/chat/completions, which den-router
//   forwards to the backend's /v1/chat/completions unchanged.
type DenRouterBackendType = "standard" | "codex-oauth" | string;

// Fallback context window (in tokens) used when den-router does not
// report a context_length for a model. Keeps behavior stable for models
// whose router config has no context_length set at any level.
export const DEFAULT_CONTEXT_WINDOW = 128000;

export interface DenRouterModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  // context_length is the effective context window den-router derives
  // from its config (model-level → backend-level → router default) and
  // exposes on each /v1/models entry. Omitted (or <= 0) when unknown;
  // in that case we fall back to DEFAULT_CONTEXT_WINDOW.
  context_length?: number;
  // Optional capability hints den-router may attach to a model entry.
  // `reasoning: true|false` is an explicit declaration that wins over
  // every other signal (codex backend, labels, id heuristic). `labels`
  // mirrors the lemonade extension convention (e.g. ["reasoning","vision"]).
  reasoning?: boolean;
  labels?: string[];
  // thinking_format is the wire convention den-router says this model's
  // backend expects for enabling thinking (e.g. "qwen", "deepseek",
  // "together", "openrouter"). Forwarded verbatim into Pi's
  // compat.thinkingFormat when set; absent means "let Pi default"
  // (openai-style reasoning_effort, which most OpenAI-compatible
  // backends accept).
  thinking_format?: string;
}

interface DenRouterModelsResponse {
  data?: DenRouterModel[];
}

interface DenRouterBackendRoutes {
  name: string;
  priority: number;
  healthy: boolean;
  drained: boolean;
  last_error: string;
  load_score?: number;
  model_loaded?: boolean;
  type?: DenRouterBackendType;
}

interface DenRouterModelRoutes {
  selected: string;
  backends: DenRouterBackendRoutes[];
}

interface DenRouterRoutesResponse {
  models: Record<string, DenRouterModelRoutes>;
}
export type { DenRouterRoutesResponse };

export function denRouterServerUrl(): string {
  return (process.env.DEN_ROUTER_URL ?? DEFAULT_URL)
    .replace(/\/$/, "")
    .replace(/\/v1$/i, "");
}

export async function fetchDenRouterModels(baseUrl: string): Promise<DenRouterModel[]> {
  const res = await fetch(`${baseUrl}/v1/models`);
  if (!res.ok) throw new Error(`/v1/models returned HTTP ${res.status}`);
  const payload = (await res.json()) as DenRouterModelsResponse;
  return Array.isArray(payload.data) ? payload.data : [];
}

// fetchDenRouterRoutes is best-effort: if /routes is unreachable or
// returns a non-routes-shaped payload (e.g. an older den-router
// without the type field) we return null so the caller falls back
// to registering every model as openai-completions — the pre-fix
// behavior, which still works for non-codex backends.
export async function fetchDenRouterRoutes(baseUrl: string): Promise<DenRouterRoutesResponse | null> {
  try {
    const res = await fetch(`${baseUrl}/routes`);
    if (!res.ok) return null;
    const payload = (await res.json()) as unknown;
    if (!isRoutesPayload(payload)) return null;
    return payload;
  } catch {
    return null;
  }
}

function isRoutesPayload(value: unknown): value is DenRouterRoutesResponse {
  if (!value || typeof value !== "object") return false;
  const models = (value as { models?: unknown }).models;
  if (!models || typeof models !== "object") return false;
  return true;
}

// isCodexBacked returns true when any of the backends serving the
// given model is a codex-oauth backend. If a model has multiple
// backends of mixed types, codex wins (we route through the
// Responses path that is the only one codex accepts).
//
// Defensive against malformed /routes payloads: if anything is
// missing or unexpected we return false so the caller falls back
// to openai-completions (the pre-fix default), not throw.
export function isCodexBacked(
  modelId: string,
  routes: DenRouterRoutesResponse | null,
): boolean {
  if (!routes || typeof routes !== "object") return false;
  if (!routes.models || typeof routes.models !== "object") return false;
  const entry = routes.models[modelId];
  if (!entry || !Array.isArray(entry.backends)) return false;
  return entry.backends.some((b) => b && b.type === "codex-oauth");
}

// Map den-router's /v1/models payload into Pi provider model configs.
//
// context_length flows from the model entry into Pi's contextWindow:
//   - When den-router reports a positive context_length (derived from
//     model-level, backend-level, or router-default config), we use it.
//   - When the field is absent or non-positive (model with no
//     context_length configured anywhere), we fall back to
//     DEFAULT_CONTEXT_WINDOW so previously-working models keep the
//     same effective window.
export function toProviderModels(
  data: DenRouterModel[],
  routes: DenRouterRoutesResponse | null = null,
) {
  const seen = new Set<string>();
  return data.flatMap((model) => {
    const id = model.id?.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const api = isCodexBacked(id, routes) ? "openai-responses" : "openai-completions";
    const thinkingFormat = resolveThinkingFormat(model);
    return [{
      id,
      name: id,
      // Surface Pi's thinking-level control for reasoning-capable models.
      // See resolveReasoning for the precedence: explicit server flag →
      // codex backend → labels → conservative id heuristic. Without this,
      // non-codex models load with reasoning:false and the thinking-level
      // control never appears.
      reasoning: resolveReasoning(model, api === "openai-responses"),
      input: ["text"] as ("text" | "image")[],
      contextWindow: resolveContextWindow(model),
      maxTokens: 32768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      api,
      // Per-model thinking wire format from den-router (e.g. "qwen",
      // "deepseek"). Omitted when den-router doesn't declare one, so Pi
      // falls back to its per-api default (openai-style reasoning_effort
      // for openai-completions).
      ...(thinkingFormat ? { compat: { thinkingFormat } } : {}),
    } satisfies ProviderModelConfig];
  });
}

// resolveContextWindow returns the effective context window for a model.
// It prefers den-router's reported context_length when present and
// positive, otherwise falls back to DEFAULT_CONTEXT_WINDOW.
export function resolveContextWindow(model: DenRouterModel): number {
  const reported = model.context_length;
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
    return reported;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// REASONING_ID_PATTERN flags well-known reasoning model families by id
// (DeepSeek-R1/Reasoner, Qwen QwQ/Thinking, Kimi Thinking, OpenAI o1/o3/o4,
// ...). It is intentionally conservative: a false positive would surface a
// thinking-level control that does nothing (or push a reasoning_effort a
// backend rejects), so only unambiguous indicators match. Bare vendor ids
// ("deepseek", "kimi", ...) are deliberately NOT matched.
const REASONING_ID_PATTERN =
  /reasoner|reasoning|thinking|(?:^|[-_/.])qwq|(?:^|[-_/.])r1\d?(?:[-_/.]|$)|(?:^|[-_/.])o[134](?:[-_/.]|$)/i;

// resolveReasoning decides whether a den-router model should expose Pi's
// thinking-level control. Precedence (first wins):
//   1. An explicit `reasoning` boolean on the model entry — the server's
//      own declaration always wins, in either direction.
//   2. Codex-backed models (gpt-5.x family) are reasoning-capable.
//   3. A `labels` array containing "reasoning" (lemonade convention).
//   4. Conservative id heuristic (REASONING_ID_PATTERN).
//   5. Otherwise false.
export function resolveReasoning(
  model: DenRouterModel,
  codexBacked: boolean,
): boolean {
  if (typeof model.reasoning === "boolean") return model.reasoning;
  if (codexBacked) return true;
  if (Array.isArray(model.labels) && model.labels.includes("reasoning")) return true;
  return REASONING_ID_PATTERN.test(model.id ?? "");
}

// Pi accepts these literal values for compat.thinkingFormat. We restrict
// the string we forward from den-router to this set so an unknown value
// can't produce an invalid provider model. Values map 1:1 to den-router's
// accepted thinking_format values (see den-router config validation).
const PI_THINKING_FORMATS = new Set([
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "zai",
  "qwen",
  "qwen-chat-template",
]);

// resolveThinkingFormat returns the den-router-reported thinking wire
// format for a model, narrowed to the set Pi accepts, or undefined to let
// Pi default to openai-style reasoning_effort.
export function resolveThinkingFormat(model: DenRouterModel): string | undefined {
  const f = typeof model.thinking_format === "string" ? model.thinking_format.trim() : "";
  if (!f) return undefined;
  return PI_THINKING_FORMATS.has(f) ? f : undefined;
}

// Minimal structural type for the model shape we emit. We avoid
// importing the pi-coding-agent types here to keep the extension
// portable; registerProvider accepts a structurally compatible
// object.
interface ProviderModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  api: string;
  compat?: { thinkingFormat?: string };
}

function registerDenRouter(
  pi: ExtensionAPI,
  baseUrl: string,
  models: DenRouterModel[],
  routes: DenRouterRoutesResponse | null,
): void {
  pi.registerProvider("den-router", {
    name: "Den Router",
    baseUrl: `${baseUrl}/v1`,
    apiKey: "den-router",
    compat: {
      supportsDeveloperRole: false,
      // Forward reasoning_effort so the thinking-level control actually
      // reaches reasoning-capable backends. This only affects models
      // marked reasoning: true (others never enable thinking), so
      // non-reasoning models are unaffected.
      supportsReasoningEffort: true,
      supportsUsageInStreaming: false,
    },
    models: toProviderModels(models, routes),
  });
}

export default async function denRouter(pi: ExtensionAPI) {
  const baseUrl = denRouterServerUrl();

  try {
    // Fetch models and routes in parallel; routes is best-effort.
    const [initialModels, initialRoutes] = await Promise.all([
      fetchDenRouterModels(baseUrl),
      fetchDenRouterRoutes(baseUrl),
    ]);
    registerDenRouter(pi, baseUrl, initialModels, initialRoutes);
  } catch (err) {
    console.error(
      `[den-router] Could not reach ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  pi.registerCommand("den-router-refresh", {
    description: "Re-sync models from den-router without restarting pi.",
    handler: async (_args, ctx) => {
      const url = denRouterServerUrl();
      try {
        const [freshModels, freshRoutes] = await Promise.all([
          fetchDenRouterModels(url),
          fetchDenRouterRoutes(url),
        ]);
        pi.unregisterProvider("den-router");
        registerDenRouter(pi, url, freshModels, freshRoutes);
        const count = toProviderModels(freshModels, freshRoutes).length;
        const codexCount = toProviderModels(freshModels, freshRoutes)
          .filter((m) => m.api === "openai-responses").length;
        const summary = codexCount > 0
          ? `${count} model(s) (${codexCount} codex, ${count - codexCount} standard) from ${url}`
          : `${count} model(s) from ${url}`;
        ctx.ui.notify(`Den Router: registered ${summary}`, "info");
      } catch (err) {
        ctx.ui.notify(
          `Den Router: refresh failed — ${err instanceof Error ? err.message : String(err)}`,
          "error"
        );
      }
    },
  });
}
