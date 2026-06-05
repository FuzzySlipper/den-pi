import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_URL = "http://192.168.1.23:13305";

interface LemonadeModel {
  id: string;
  max_context_window?: number;
  labels?: string[];
  downloaded?: boolean;
}

interface LemonadeModelsResponse {
  data: LemonadeModel[];
}

function serverUrl(): string {
  return (process.env.LEMONADE_URL ?? DEFAULT_URL).replace(/\/$/, "");
}

async function fetchLemonadeModels(baseUrl: string): Promise<LemonadeModel[]> {
  const res = await fetch(`${baseUrl}/v1/models`);
  if (!res.ok) throw new Error(`/v1/models returned HTTP ${res.status}`);
  const payload = (await res.json()) as LemonadeModelsResponse;
  return payload.data ?? [];
}

function toProviderModels(data: LemonadeModel[]) {
  return data
    .filter((m) => m.downloaded !== false)
    .map((m) => ({
      id: m.id,
      name: m.id,
      reasoning: m.labels?.includes("reasoning") ?? false,
      input: (m.labels?.includes("vision") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      contextWindow: m.max_context_window ?? 128000,
      maxTokens: Math.floor((m.max_context_window ?? 32768) / 4),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
}

function registerLemonade(pi: ExtensionAPI, baseUrl: string, models: LemonadeModel[]): void {
  pi.registerProvider("lemonade", {
    name: "Lemonade",
    baseUrl: `${baseUrl}/v1`,
    apiKey: "lemonade",
    api: "openai-completions",
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
    },
    models: toProviderModels(models),
  });
}

export default async function lemonade(pi: ExtensionAPI) {
  const baseUrl = serverUrl();
  let initialModels: LemonadeModel[] = [];

  try {
    initialModels = await fetchLemonadeModels(baseUrl);
    registerLemonade(pi, baseUrl, initialModels);
  } catch (err) {
    console.error(
      `[lemonade] Could not reach ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  pi.registerCommand("lemonade-refresh", {
    description: "Re-sync models from the Lemonade server without restarting pi.",
    handler: async (_args, ctx) => {
      const url = serverUrl();
      try {
        const fresh = await fetchLemonadeModels(url);
        pi.unregisterProvider("lemonade");
        registerLemonade(pi, url, fresh);
        const count = toProviderModels(fresh).length;
        ctx.ui.notify(`Lemonade: registered ${count} model(s) from ${url}`, "info");
      } catch (err) {
        ctx.ui.notify(
          `Lemonade: refresh failed — ${err instanceof Error ? err.message : String(err)}`,
          "error"
        );
      }
    },
  });
}
