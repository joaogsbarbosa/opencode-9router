import assert from "node:assert/strict";
import { flattenModelsDevCatalog } from "./dist/cache.js";
import { findReasoningOptions } from "./dist/reasoning.js";
import { toModelInfo } from "./dist/v2-map.js";
import { DISCOVERY_CACHE_VERSION } from "./dist/constants.js";

// ── Reasoning Options (models.dev catalog) ───────────────────

/** Build a models.dev entry with reasoning: true and optional reasoning_options. */
const entry = (id, reasoning_options) => ({ id, reasoning: true, reasoning_options });
/** Build an effort option. */
const effort = (...values) => [{ type: "effort", values }];

const raw = {
  collision: { models: { wrong: entry("z-ai/glm-5.3-flash", effort("medium")) } },
  openrouter: { models: {
    glm: entry("z-ai/glm-5.3-flash", effort("low", "high", "max")),
    gpt: entry("openai/gpt-5.6-sol", effort("none", "low", "medium", "high", "xhigh", "max")),
    gemini: entry("google/gemini-3.8-flash", effort("low", "medium", "high")),
    claude: entry("anthropic/claude-opus-5.5", effort("low", "medium", "high", "xhigh", "max")),
    toggle: entry("z-ai/glm-4.6v", [{ type: "toggle" }]),
    free: { id: "openrouter/free", reasoning: true },
  } },
  zai: { models: { glm: entry("glm-5.3-flash", effort("low", "high")) } },
  google: { models: { gemini: entry("gemini-3.8-flash", effort("low", "medium", "high")) } },
  another: { models: { model: entry("vendor/model", effort("none", "high")) } },
  volcengine: { models: { model: entry("doubao-model", effort("low", "high")) } },
  "cloudflare-workers-ai": { models: { model: entry("@cf/zai-org/glm-5.3", effort("low", "high", "max")) } },
};
const catalog = flattenModelsDevCatalog(raw);
assert.equal(raw.openrouter.models.glm.catalogProvider, undefined, "flattening must not mutate cached input");
const modes = (id) => findReasoningOptions(id, catalog);

// Exact provider/full-ID matching + aliases
assert.deepEqual(modes("openrouter/z-ai/glm-5.3-flash"), effort("low", "high", "max"));
assert.deepEqual(modes("glm/glm-5.3-flash"), effort("low", "high"));
assert.deepEqual(modes("google/gemini-3.8-flash"), effort("low", "medium", "high"));
assert.deepEqual(modes("another/vendor/model"), effort("none", "high"));
assert.deepEqual(modes("doubao/doubao-model"), effort("low", "high"));
assert.deepEqual(modes("cloudflare-ai/@cf/zai-org/glm-5.3"), effort("low", "high", "max"));

// Ambiguous or unknown matches stay undefined (no invented controls)
for (const id of [
  "unknown/z-ai/glm-5.3-flash",
  "openrouter/glm-5.3-flash",
  "openrouter/z-ai/glm-5.3-flash:free",
  "openrouter/z-ai-5-3-flash",
  "executor",
  "openrouter/openrouter/free",
]) {
  assert.equal(modes(id), undefined, `no invented controls for ${id}`);
}

// Ambiguous exact matches (duplicate catalogProvider+id) stay unknown
assert.equal(
  findReasoningOptions("openrouter/z-ai/glm-5.3-flash", [
    ...catalog,
    catalog.find((e) => e.catalogProvider === "openrouter"),
  ]),
  undefined,
  "ambiguous exact matches stay unknown",
);

// Invalid / malformed reasoning_options are rejected
for (const invalid of [null, {}, [{ type: "effort", values: "high" }], [{ type: "budget_tokens", min: 1024 }]]) {
  assert.equal(findReasoningOptions("test/model", [{ catalogProvider: "test", ...entry("model", invalid) }]), undefined);
}

// Deduplication of effort values (all strings pass through; non-strings dropped)
assert.deepEqual(
  findReasoningOptions("test/model", [{
    catalogProvider: "test",
    ...entry("model", [null, {
      type: "effort",
      values: ["high", "high", "default", "ultra", 1, "__proto__"],
    }]),
  }]),
  effort("high", "default", "ultra", "__proto__"),
);

// reasoning: false disables controls even when reasoning_options present
assert.equal(
  findReasoningOptions("test/model", [{
    catalogProvider: "test",
    ...entry("model", effort("high")),
    reasoning: false,
  }]),
  undefined,
);

// ── Variant lowering (effort + toggle) ───────────────────────

const info = (options, extra = {}) => toModelInfo("9router", "test/model", { name: "Test", reasoning_options: options, ...extra });

// Effort variants
assert.deepEqual(
  info(effort("low", "high", "max")).variants,
  ["low", "high", "max"].map((id) => ({ id, settings: { reasoningEffort: id } })),
);

// Toggle variants
assert.deepEqual(
  info([{ type: "toggle" }]).variants,
  [
    { id: "none", settings: { reasoningEffort: null }, body: { enable_thinking: false } },
    { id: "thinking", settings: { reasoningEffort: null }, body: { enable_thinking: true } },
  ],
);

// Explicit variants win over catalog controls (empty object)
assert.deepEqual(info(effort("high"), { variants: {} }).variants, []);

// Explicit custom variant wins
assert.deepEqual(
  info(effort("high"), { variants: { custom: { reasoningEffort: "low" } } }).variants,
  [{ id: "custom", settings: { reasoningEffort: "low" } }],
);

// No default effort injected when no variants configured
assert.equal(info(effort("high")).settings?.reasoningEffort, undefined, "no default effort injected");

// Effort advertised wins a toggle ID collision (either catalog order)
for (const options of [
  [...effort("none", "high"), { type: "toggle" }],
  [{ type: "toggle" }, ...effort("none", "high")],
]) {
  assert.deepEqual(info(options).variants.find((v) => v.id === "none"), {
    id: "none", settings: { reasoningEffort: "none" },
  }, "advertised effort wins a toggle ID collision in either catalog order");
}

// ── Cache version gate ───────────────────────────────────────

assert.equal(DISCOVERY_CACHE_VERSION, 5, "cache version bumped for reasoning_options shape");

console.log("Reasoning controls tests passed");
