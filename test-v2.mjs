import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeProviderOptions as mergeOverlay } from "@opencode/ai";

const packageJson = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);

assert.equal(packageJson.exports["./server"].default, "./dist/index.js");
assert.ok(packageJson.files.includes("server.js"));

const localEntry = await import("./server.js");
assert.equal(localEntry.default.id, "9router");
assert.equal(typeof localEntry.default.setup, "function");
assert.equal(typeof localEntry.default.server, "function");
assert.equal(typeof localEntry.NineRouterPlugin, "function");

const packageEntry = await import("@vheins/opencode-9router/server");
assert.equal(packageEntry.default.id, "9router");
assert.equal(typeof packageEntry.default.setup, "function");
assert.equal(typeof packageEntry.default.server, "function");

assert.equal(require.resolve("@vheins/opencode-9router/server"), fileURLToPath(new URL("./dist/index.js", import.meta.url)));

console.log("V2 entrypoint and package export checks passed");

// ── Late config-provider lifecycle ──────────────────────────
// The external plugin runs before OpenCode's internal ConfigProviderPlugin.
// Prove that models captured before config providers are visible still land on
// those providers once a `provider.updated` replay happens.

process.env.XDG_CACHE_HOME = await mkdtemp(join(tmpdir(), "opencode-9router-v2-"));
const { nineRouterV2 } = await import("./dist/v2.js");

const providerRecords = new Map();
const providerTransforms = [];
const modelTransforms = [];
let candidates = new Map();

const providerEditor = {
  list: () => Array.from(providerRecords.values()),
  get: (id) => providerRecords.get(id),
  add: ({ info, models }) => {
    providerRecords.set(info.id, {
      provider: info,
      models: new Map(models.map((model) => [model.id, structuredClone(model)])),
    });
  },
  update: (id, update) => {
    const record = providerRecords.get(id);
    if (record) {
      update(record.provider);
    }
  },
  remove: (id) => {
    providerRecords.delete(id);
  },
  models: {
    set: (id, models) => {
      const record = providerRecords.get(id);
      if (record) {
        record.models = new Map(models.map((model) => [model.id, structuredClone(model)]));
      }
    },
    update: (id, modelID, update) => {
      const record = providerRecords.get(id);
      const model = record?.models.get(modelID);
      if (model) {
        update(model);
      }
    },
    remove: (id, modelID) => {
      providerRecords.get(id)?.models.delete(modelID);
    },
  },
};

const modelEditor = {
  list: (providerID) =>
    Array.from(candidates.values()).flatMap((record) =>
      providerID && record.provider.id !== providerID
        ? []
        : Array.from(record.models.values()),
    ),
  get: (providerID, modelID) => candidates.get(providerID)?.models.get(modelID),
  update: (providerID, modelID, update) => {
    const record = candidates.get(providerID);
    if (!record) {
      return;
    }
    let model = record.models.get(modelID);
    if (!model) {
      model = {
        id: modelID,
        providerID,
        name: modelID,
        enabled: false,
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 1, output: 1 },
        status: "active",
        variants: [],
      };
      record.models.set(modelID, model);
    }
    update(model);
  },
  remove: (providerID, modelID) => {
    candidates.get(providerID)?.models.delete(modelID);
  },
  default: {
    get: () => undefined,
    set: () => undefined,
  },
  provider: {
    list: () => Array.from(providerRecords.values()),
    get: (id) => providerRecords.get(id),
  },
};

const replayModelTransforms = () => {
  candidates = structuredClone(providerRecords);
  for (const transform of modelTransforms) transform(modelEditor);
  const configured = candidates.get("9router-inferhub")?.models.get("vendor/model-a");
  if (configured) {
    configured.settings = mergeOverlay(configured.settings, { custom: true });
    configured.body = mergeOverlay(configured.body, { custom_body: true });
    const configuredVariants = [
      { id: "high", settings: { reasoningEffort: "low" }, body: { custom_variant: true } },
      { id: "thinking", settings: { reasoningEffort: "high" } },
      { id: "custom", settings: { custom: true } },
    ];
    for (const variant of configuredVariants) {
      let existing = configured.variants.find((item) => item.id === variant.id);
      if (!existing) configured.variants.push(existing = { id: variant.id });
      for (const key of ["settings", "body"]) {
        if (variant[key] !== undefined) existing[key] = mergeOverlay(existing[key], variant[key]);
      }
    }
  }
};
const replayProviderTransforms = () => {
  for (const transform of providerTransforms) {
    transform(providerEditor);
  }
  replayModelTransforms();
};

const eventSubscribers = [];
let refreshEvent;
let effortValues = ["low", "high"];
let reloadAttempts = 0;
let reloadFailures = 0;
let refreshFailures = 0;
const originalError = console.error;
console.error = (...args) => {
  if (args.some((arg) => String(arg).includes("Refresh failed: synthetic reload failure"))) refreshFailures++;
  else originalError(...args);
};
const context = {
  options: { cache: false },
  provider: {
    list: async () => Array.from(providerRecords.values()),
    transform: async (callback) => {
      providerTransforms.push(callback);
      callback(providerEditor);
      return { dispose: () => undefined };
    },
    reload: async () => {
      reloadAttempts++;
      if (reloadFailures > 0) {
        reloadFailures--;
        throw new Error("synthetic reload failure");
      }
      replayProviderTransforms();
    },
  },
  model: {
    transform: async (callback) => {
      modelTransforms.push(callback);
      callback(modelEditor);
      return { dispose: () => undefined };
    },
    reload: async () => {
      replayModelTransforms();
    },
  },
  event: {
    subscribe: ({ signal } = {}) => ({
      async *[Symbol.asyncIterator]() {
        while (!signal?.aborted) {
          const event = await new Promise((resolve) => {
            refreshEvent = resolve;
            signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          });
          refreshEvent = undefined;
          if (!event) return;
          yield event;
        }
      },
    }),
  },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("/models/info")) {
    return new Response(JSON.stringify({ id: "model", capabilities: { tools: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("api.json") || url.includes("models.dev")) {
    return new Response(JSON.stringify({ test: { models: {} } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(
    JSON.stringify({
      data: [
        { id: "vendor/model-a", owned_by: "vendor" },
        { id: "vendor/model-b", owned_by: "vendor" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const cleanup = await nineRouterV2.setup(context);
  await delay(10);

  // Simulate ConfigProviderPlugin registering a configured provider late.
  providerRecords.set("9router-inferhub", {
    provider: {
      id: "9router-inferhub",
      name: "Inferhub",
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "https://router.test", apiKey: "test" },
    },
    models: new Map(),
  });

  const deadline = Date.now() + 2000;
  while (
    Date.now() < deadline &&
    (providerRecords.get("9router-inferhub")?.models.size ?? 0) < 2
  ) {
    await delay(20);
  }

  assert.equal(
    providerRecords.get("9router-inferhub")?.models.size,
    2,
    "late config provider should receive discovered models",
  );

  // Simulate a failed publication followed by automatic recovery.
  providerRecords.get("9router-inferhub").provider.name = "Inferhub Retry";
  reloadAttempts = 0;
  reloadFailures = 1;
  refreshEvent?.({ type: "provider.updated" });
  const retryDeadline = Date.now() + 5000;
  while (Date.now() < retryDeadline && reloadAttempts < 2) {
    await delay(20);
  }
  assert.equal(reloadAttempts, 2, "reload retried after synthetic failure");
  assert.equal(refreshFailures, 1, "refresh failure logged");

  await cleanup();
  console.log("V2 late config-provider lifecycle checks passed");
} finally {
  globalThis.fetch = originalFetch;
}
