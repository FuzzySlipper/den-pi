import test from "node:test";
import assert from "node:assert/strict";
import denRouter, {
  denRouterServerUrl,
  fetchDenRouterModels,
  fetchDenRouterRoutes,
  isCodexBacked,
  toProviderModels,
} from "../extensions/den-router.ts";
import type {
  DenRouterRoutesResponse,
} from "../extensions/den-router.ts";

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

test("denRouterServerUrl defaults to local den-router and trims trailing slash", () => {
  withEnv("DEN_ROUTER_URL", undefined, () => {
    assert.equal(denRouterServerUrl(), "http://127.0.0.1:18082");
  });

  withEnv("DEN_ROUTER_URL", "http://router.example:8080/", () => {
    assert.equal(denRouterServerUrl(), "http://router.example:8080");
  });

  withEnv("DEN_ROUTER_URL", "http://router.example:8080/v1/", () => {
    assert.equal(denRouterServerUrl(), "http://router.example:8080");
  });
});

test("fetchDenRouterModels reads OpenAI-compatible /v1/models responses", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({
        object: "list",
        data: [
          { id: "codex-pi", object: "model", owned_by: "den-router" },
          { id: "fast-local", object: "model", owned_by: "Local route" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const models = await fetchDenRouterModels("http://router.local");
    assert.deepEqual(calls, ["http://router.local/v1/models"]);
    assert.deepEqual(models.map((m) => m.id), ["codex-pi", "fast-local"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchDenRouterRoutes returns null on HTTP error or malformed payload", async () => {
  const originalFetch = globalThis.fetch;

  // Non-OK status
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  assert.equal(await fetchDenRouterRoutes("http://router.local"), null);

  // Malformed JSON: a routes-shaped object is expected
  globalThis.fetch = async () => new Response(
    JSON.stringify({ data: [{ id: "x" }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  const malformed = await fetchDenRouterRoutes("http://router.local");
  assert.equal(malformed, null, "malformed /routes response should return null");

  // Network error
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await fetchDenRouterRoutes("http://router.local"), null);

  globalThis.fetch = originalFetch;
});

test("isCodexBacked flags codex-oauth backends and is defensive", () => {
  const routes: DenRouterRoutesResponse = {
    models: {
      "codex-cli": { selected: "b", backends: [{ name: "b", priority: 1, healthy: true, drained: false, last_error: "", type: "codex-oauth" }] },
      "deepseek":  { selected: "b", backends: [{ name: "b", priority: 1, healthy: true, drained: false, last_error: "" }] },
      "mixed":     { selected: "b", backends: [
        { name: "std", priority: 1, healthy: true, drained: false, last_error: "" },
        { name: "cx",  priority: 2, healthy: true, drained: false, last_error: "", type: "codex-oauth" },
      ] },
      "empty":     { selected: "", backends: [] },
    },
  };

  assert.equal(isCodexBacked("codex-cli", routes), true);
  assert.equal(isCodexBacked("deepseek", routes), false);
  assert.equal(isCodexBacked("mixed", routes), true, "mixed-type backends: codex wins");
  assert.equal(isCodexBacked("empty", routes), false);
  assert.equal(isCodexBacked("unknown-model", routes), false);

  // Defensive defaults
  assert.equal(isCodexBacked("codex-cli", null), false);
  assert.equal(isCodexBacked("codex-cli", {} as any), false);
  assert.equal(isCodexBacked("codex-cli", { models: null } as any), false);
  assert.equal(isCodexBacked("codex-cli", { models: { x: { backends: "not-an-array" } } } as any), false);
});

test("toProviderModels assigns openai-responses api to codex models, openai-completions to the rest", () => {
  const routes: DenRouterRoutesResponse = {
    models: {
      "codex-cli": { selected: "b", backends: [{ name: "b", priority: 1, healthy: true, drained: false, last_error: "", type: "codex-oauth" }] },
      "codex-pi":  { selected: "b", backends: [{ name: "b", priority: 1, healthy: true, drained: false, last_error: "", type: "codex-oauth" }] },
      "deepseek":  { selected: "b", backends: [{ name: "b", priority: 1, healthy: true, drained: false, last_error: "" }] },
      "kimi":      { selected: "b", backends: [{ name: "b", priority: 1, healthy: true, drained: false, last_error: "" }] },
    },
  };

  const models = toProviderModels(
    [
      { id: "codex-cli", object: "model" },
      { id: "codex-pi",  object: "model" },
      { id: "deepseek",  object: "model" },
      { id: "kimi",      object: "model" },
      { id: "codex-cli", object: "model" }, // duplicate
    ],
    routes,
  );

  assert.deepEqual(models.map((m) => m.id), ["codex-cli", "codex-pi", "deepseek", "kimi"]);
  assert.equal(models[0].api, "openai-responses");
  assert.equal(models[1].api, "openai-responses");
  assert.equal(models[2].api, "openai-completions");
  assert.equal(models[3].api, "openai-completions");
  // codex models are flagged reasoning-capable (gpt-5.x family)
  assert.equal(models[0].reasoning, true);
  assert.equal(models[2].reasoning, false);
});

test("toProviderModels falls back to openai-completions when routes is null", () => {
  const models = toProviderModels(
    [{ id: "codex-cli" }, { id: "deepseek" }],
    null,
  );
  assert.equal(models[0].api, "openai-completions");
  assert.equal(models[1].api, "openai-completions");
});

test("toProviderModels maps den-router model IDs into Pi provider models (legacy call shape)", () => {
  // The original single-argument signature still works for callers
  // that don't have routes available.
  const models = toProviderModels([
    { id: "codex-pi", object: "model", owned_by: "den-router" },
    { id: "", object: "model" },
    { id: "local-coder", object: "model" },
    { id: "codex-pi", object: "model" },
  ]);

  assert.deepEqual(models.map((m) => m.id), ["codex-pi", "local-coder"]);
  assert.equal(models[0].name, "codex-pi");
  assert.deepEqual(models[0].input, ["text"]);
  assert.equal(models[0].reasoning, false, "without routes, reasoning defaults to false");
  assert.equal(models[0].contextWindow, 128000);
  assert.equal(models[0].maxTokens, 32768);
  assert.deepEqual(models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("den-router extension registers provider on startup and on refresh", async () => {
  const originalFetch = globalThis.fetch;
  const registered: Array<{ id: string; provider: any }> = [];
  const unregistered: string[] = [];
  const commands = new Map<string, any>();
  const notifications: Array<{ message: string; level: string }> = [];

  // The mock returns the same /v1/models-shaped response for every
  // fetch call. The extension's fetchDenRouterRoutes will gracefully
  // return null for the unparseable routes payload, so all models
  // fall back to the legacy openai-completions api.
  globalThis.fetch = async () => new Response(
    JSON.stringify({ data: [{ id: "codex-pi", object: "model" }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

  const pi = {
    registerProvider(id: string, provider: any) {
      registered.push({ id, provider });
    },
    unregisterProvider(id: string) {
      unregistered.push(id);
    },
    registerCommand(id: string, command: any) {
      commands.set(id, command);
    },
  } as any;

  try {
    await denRouter(pi);
    assert.equal(registered[0].id, "den-router");
    assert.equal(registered[0].provider.name, "Den Router");
    assert.equal(registered[0].provider.baseUrl, "http://127.0.0.1:18082/v1");
    assert.deepEqual(registered[0].provider.models.map((m: any) => m.id), ["codex-pi"]);
    // Without routes info the legacy api is preserved.
    assert.equal(registered[0].provider.models[0].api, "openai-completions");
    assert.ok(commands.has("den-router-refresh"));

    await commands.get("den-router-refresh").handler([], {
      ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
    });

    assert.deepEqual(unregistered, ["den-router"]);
    assert.equal(registered.length, 2);
    assert.deepEqual(notifications, [
      { message: "Den Router: registered 1 model(s) from http://127.0.0.1:18082", level: "info" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("den-router extension picks openai-responses for codex models when /routes reports backend type", async () => {
  const originalFetch = globalThis.fetch;
  const registered: Array<{ id: string; provider: any }> = [];
  const commands = new Map<string, any>();

  // Mock fetch to return different responses per URL.
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({
          data: [
            { id: "codex-cli", object: "model" },
            { id: "deepseek",  object: "model" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/routes")) {
      return new Response(
        JSON.stringify({
          models: {
            "codex-cli": { selected: "b", backends: [{ name: "b", priority: 1, healthy: true, drained: false, last_error: "", type: "codex-oauth" }] },
            "deepseek":  { selected: "b", backends: [{ name: "b", priority: 1, healthy: true, drained: false, last_error: "" }] },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  };

  const pi = {
    registerProvider(id: string, provider: any) { registered.push({ id, provider }); },
    unregisterProvider(_id: string) {},
    registerCommand(id: string, command: any) { commands.set(id, command); },
  } as any;

  try {
    await denRouter(pi);
    const models = registered[0].provider.models;
    assert.equal(models[0].id, "codex-cli");
    assert.equal(models[0].api, "openai-responses");
    assert.equal(models[1].id, "deepseek");
    assert.equal(models[1].api, "openai-completions");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
