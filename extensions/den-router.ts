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

export interface DenRouterModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
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
    return [{
      id,
      name: id,
      // Codex models are reasoning-capable (gpt-5.5, gpt-5.x-codex).
      // Non-codex models default to false; users can override per-model
      // via a follow-up registerProvider call.
      reasoning: api === "openai-responses",
      input: ["text"] as ("text" | "image")[],
      contextWindow: 128000,
      maxTokens: 32768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      api,
    } satisfies ProviderModelConfig];
  });
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
      supportsReasoningEffort: false,
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
