import test from "node:test";
import assert from "node:assert/strict";
import denRouter, {
  denRouterServerUrl,
  fetchDenRouterModels,
  toProviderModels,
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

test("toProviderModels maps den-router model IDs into Pi provider models", () => {
  const models = toProviderModels([
    { id: "codex-pi", object: "model", owned_by: "den-router" },
    { id: "", object: "model" },
    { id: "local-coder", object: "model" },
    { id: "codex-pi", object: "model" },
  ]);

  assert.deepEqual(models.map((m) => m.id), ["codex-pi", "local-coder"]);
  assert.equal(models[0].name, "codex-pi");
  assert.deepEqual(models[0].input, ["text"]);
  assert.equal(models[0].reasoning, false);
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
