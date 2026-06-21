import test from "node:test";
import assert from "node:assert/strict";
import denRouter, {
  DEFAULT_CONTEXT_WINDOW,
  denRouterServerUrl,
  fetchDenRouterModels,
  fetchDenRouterRoutes,
  isCodexBacked,
  resolveContextWindow,
  resolveReasoning,
  resolveThinkingFormat,
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

test("resolveContextWindow uses den-router context_length and falls back otherwise", () => {
  assert.equal(resolveContextWindow({ id: "a", context_length: 32768 }), 32768);
  assert.equal(resolveContextWindow({ id: "a", context_length: 1000000 }), 1000000);
  // Absent / unknown → fallback
  assert.equal(resolveContextWindow({ id: "a" }), DEFAULT_CONTEXT_WINDOW);
  // Non-positive values (den-router sends these as omitted, but be defensive)
  assert.equal(resolveContextWindow({ id: "a", context_length: 0 }), DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolveContextWindow({ id: "a", context_length: -1 }), DEFAULT_CONTEXT_WINDOW);
  // Malformed non-number should not throw; falls back.
  assert.equal(resolveContextWindow({ id: "a", context_length: "oops" as any }), DEFAULT_CONTEXT_WINDOW);
});

test("resolveReasoning respects explicit flag, labels, codex, and id heuristic", () => {
  // Explicit boolean wins in either direction.
  assert.equal(resolveReasoning({ id: "deepseek", reasoning: true }, false), true);
  assert.equal(
    resolveReasoning({ id: "deepseek-r1", reasoning: false }, false),
    false,
    "explicit false overrides the id heuristic",
  );

  // Codex-backed models are reasoning-capable.
  assert.equal(resolveReasoning({ id: "codex-cli" }, true), true);

  // labels[] containing "reasoning" (lemonade convention).
  assert.equal(resolveReasoning({ id: "weird-name", labels: ["reasoning"] }, false), true);
  assert.equal(resolveReasoning({ id: "weird-name", labels: ["vision"] }, false), false);

  // Id heuristic: well-known reasoning families.
  assert.equal(resolveReasoning({ id: "deepseek-r1" }, false), true);
  assert.equal(resolveReasoning({ id: "deepseek-reasoner" }, false), true);
  assert.equal(resolveReasoning({ id: "qwq-32b" }, false), true);
  assert.equal(resolveReasoning({ id: "qwen3-235b-thinking" }, false), true);
  assert.equal(resolveReasoning({ id: "kimi-k2-thinking" }, false), true);
  assert.equal(resolveReasoning({ id: "o3-mini" }, false), true);
  assert.equal(resolveReasoning({ id: "o1" }, false), true);

  // Conservative: bare / non-reasoning ids are not flagged.
  assert.equal(resolveReasoning({ id: "deepseek" }, false), false);
  assert.equal(resolveReasoning({ id: "kimi" }, false), false);
  assert.equal(resolveReasoning({ id: "local-coder" }, false), false);
  assert.equal(resolveReasoning({ id: "gpt-4o" }, false), false, "gpt-4o is not o1/o3/o4");
  assert.equal(resolveReasoning({ id: "unconfigured" }, false), false);
});

test("toProviderModels surfaces reasoning for capable standard models", () => {
  const models = toProviderModels([
    { id: "deepseek-r1" },
    { id: "qwq-32b" },
    { id: "kimi-k2-thinking" },
    { id: "deepseek-chat" },
    { id: "explicit-off", reasoning: false },
  ]);
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));
  assert.equal(byId["deepseek-r1"].reasoning, true, "flagged via id heuristic");
  assert.equal(byId["qwq-32b"].reasoning, true);
  assert.equal(byId["kimi-k2-thinking"].reasoning, true);
  assert.equal(byId["deepseek-chat"].reasoning, false, "plain chat model is not reasoning");
  assert.equal(byId["explicit-off"].reasoning, false, "explicit false respected");
});

test("resolveThinkingFormat narrows to pi-accepted values", () => {
  // Accepted values pass through.
  for (const f of ["openai", "openrouter", "deepseek", "together", "zai", "qwen", "qwen-chat-template"]) {
    assert.equal(resolveThinkingFormat({ id: "m", thinking_format: f }), f);
  }
  // Unknown values fall back to undefined so we never emit an invalid
  // provider model — Pi would then use its per-api default format.
  assert.equal(resolveThinkingFormat({ id: "m", thinking_format: "nonsense" }), undefined);
  // Absent / blank / non-string fall back to undefined.
  assert.equal(resolveThinkingFormat({ id: "m" }), undefined);
  assert.equal(resolveThinkingFormat({ id: "m", thinking_format: "   " }), undefined);
});

test("toProviderModels forwards den-router thinking_format as compat.thinkingFormat", () => {
  const models = toProviderModels([
    { id: "qwq-local", reasoning: true, thinking_format: "qwen" },
    { id: "ds-r1", reasoning: true, thinking_format: "deepseek" },
    { id: "plain", reasoning: false },
    { id: "bad-format", reasoning: true, thinking_format: "nope" },
  ]);
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));

  assert.deepEqual(byId["qwq-local"].compat, { thinkingFormat: "qwen" });
  assert.deepEqual(byId["ds-r1"].compat, { thinkingFormat: "deepseek" });
  assert.equal(byId["plain"].compat, undefined, "no thinking_format → no compat block");
  assert.equal(byId["bad-format"].compat, undefined, "unknown format is dropped, not forwarded");
});

test("toProviderModels applies den-router context_length to contextWindow", () => {
  const models = toProviderModels([
    { id: "big-local",   context_length: 200000 },
    { id: "fast-local",  context_length: 32768 },
    { id: "unconfigured" /* no context_length */ },
    { id: "zeroed",      context_length: 0 },
  ]);

  assert.deepEqual(models.map((m) => m.id), ["big-local", "fast-local", "unconfigured", "zeroed"]);
  assert.equal(models[0].contextWindow, 200000, "model-level context_length applied");
  assert.equal(models[1].contextWindow, 32768, "smaller context_length applied");
  assert.equal(models[2].contextWindow, DEFAULT_CONTEXT_WINDOW, "absent field falls back");
  assert.equal(models[3].contextWindow, DEFAULT_CONTEXT_WINDOW, "zero context_length falls back");
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

test("fetchDenRouterModels reads context_length from /v1/models entries", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      object: "list",
      data: [
        { id: "big-local", object: "model", context_length: 200000 },
        { id: "fast-local", object: "model", context_length: 32768 },
        { id: "unconfigured", object: "model" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  try {
    const models = await fetchDenRouterModels("http://router.local");
    const mapped = toProviderModels(models);
    assert.deepEqual(mapped.map((m) => m.id), ["big-local", "fast-local", "unconfigured"]);
    assert.equal(mapped[0].contextWindow, 200000);
    assert.equal(mapped[1].contextWindow, 32768);
    assert.equal(mapped[2].contextWindow, DEFAULT_CONTEXT_WINDOW);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
