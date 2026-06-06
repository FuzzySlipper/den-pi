import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_URL = "http://127.0.0.1:18082";

export interface DenRouterModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

interface DenRouterModelsResponse {
  data?: DenRouterModel[];
}

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

export function toProviderModels(data: DenRouterModel[]) {
  const seen = new Set<string>();
  return data.flatMap((model) => {
    const id = model.id?.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      name: id,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 128000,
      maxTokens: 32768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }];
  });
}

function registerDenRouter(pi: ExtensionAPI, baseUrl: string, models: DenRouterModel[]): void {
  pi.registerProvider("den-router", {
    name: "Den Router",
    baseUrl: `${baseUrl}/v1`,
    apiKey: "den-router",
    api: "openai-completions",
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
    },
    models: toProviderModels(models),
  });
}

export default async function denRouter(pi: ExtensionAPI) {
  const baseUrl = denRouterServerUrl();

  try {
    const initialModels = await fetchDenRouterModels(baseUrl);
    registerDenRouter(pi, baseUrl, initialModels);
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
        const fresh = await fetchDenRouterModels(url);
        pi.unregisterProvider("den-router");
        registerDenRouter(pi, url, fresh);
        const count = toProviderModels(fresh).length;
        ctx.ui.notify(`Den Router: registered ${count} model(s) from ${url}`, "info");
      } catch (err) {
        ctx.ui.notify(
          `Den Router: refresh failed — ${err instanceof Error ? err.message : String(err)}`,
          "error"
        );
      }
    },
  });
}
