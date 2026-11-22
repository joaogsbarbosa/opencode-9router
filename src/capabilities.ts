import type { ModelConfig, ModelsDevEntry, RouterModelInfo, ReasoningOption } from "./types.js";
import {
  COMBO_CONTEXT_WINDOW,
  COMBO_MAX_OUTPUT,
  COMBO_OWNER,
  COMBO_REASONING_EFFORTS,
  KNOWN_PROVIDER_PREFIXES,
  MAX_CONCURRENT_INFO,
  MODEL_INFO_TIMEOUT,
} from "./constants.js";
import { fetchModelsDevCatalog } from "./cache.js";
import { findReasoningOptions } from "./reasoning.js";
import { toPositiveInt } from "./utils.js";

// ── Capability Resolution ──────────────────────────────────

/**
 * Detect whether a model is a 9Router virtual combo. The authoritative signal
 * is `owned_by === "combo"`; when `owned_by` is absent (legacy responses) fall
 * back to the prefix heuristic where combo IDs carry no provider prefix.
 */
export function isComboModel(modelId: string, ownedBy?: string): boolean {
  if (ownedBy !== undefined) {
    return ownedBy === COMBO_OWNER;
  }
  return !modelId.includes("/");
}

/**
 * Capability fragment forced onto combo models that resolved no information
 * from the models.dev catalog or the per-model API. Assumes multimodal input
 * (text/image/audio), tool calling, and reasoning, and exposes thinking-level
 * variants explicitly so they survive OpenCode's id-based exclusions.
 */
export function forceComboConfig(): Partial<ModelConfig> {
  return {
    attachment: true,
    tool_call: true,
    reasoning: true,
    modalities: { input: ["text", "image", "audio"], output: ["text"] },
    limit: { context: COMBO_CONTEXT_WINDOW, output: COMBO_MAX_OUTPUT },
    variants: Object.fromEntries(
      COMBO_REASONING_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]),
    ),
    search: false,
    context_length: COMBO_CONTEXT_WINDOW,
    max_completion_tokens: COMBO_MAX_OUTPUT,
  };
}

/**
 * Query the per-model `/models/info` endpoint of a 9Router-compatible API.
 * Retries once with exponential backoff on transient failures.
 */
async function fetchModelInfo(
  apiURL: string,
  modelId: string,
  apiKey?: string,
  retries = 1,
): Promise<RouterModelInfo | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      const response = await fetch(
        `${apiURL}/models/info?id=${encodeURIComponent(modelId)}`,
        {
          signal: AbortSignal.timeout(MODEL_INFO_TIMEOUT),
          headers,
        },
      );
      if (!response.ok) return null;
      return (await response.json()) as RouterModelInfo;
    } catch {
      if (attempt === retries) return null;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
  return null;
}

/**
 * Map 9Router model info into an OpenCode model config fragment.
 * Only present capabilities are copied; limit fields are validated as
 * positive integers and emitted only as a complete context+output pair,
 * which OpenCode's config schema requires.
 */
export function mapRouterCapabilities(info: RouterModelInfo): Partial<ModelConfig> {
  const config: Partial<ModelConfig> = {};
  const inputModalities: Set<"text" | "audio" | "image" | "video" | "pdf"> = new Set(["text"]);

  if (info.capabilities) {
    if (info.capabilities.vision) {
      config.attachment = true;
      inputModalities.add("image");
    }
    if (info.capabilities.tools) {
      config.tool_call = true;
    }
    if (info.capabilities.reasoning) {
      config.reasoning = true;
    }
    if (info.capabilities.audioInput) {
      inputModalities.add("audio");
    }
  }

  if (inputModalities.size > 1) {
    config.modalities = { input: Array.from(inputModalities), output: ["text"] };
  }

  // 9Router /v1/models exposes per-model thinking levels, e.g.
  // ["none","low","medium","high"]. Mirror them onto the config and emit a
  // variant per level so OpenCode surfaces the reasoning-effort selector.
  const thinkingLevels =
    Array.isArray(info.thinking_levels) && info.thinking_levels.length > 0
      ? info.thinking_levels
      : Array.isArray(info.capabilities?.thinking_levels) &&
          info.capabilities.thinking_levels.length > 0
        ? info.capabilities.thinking_levels
        : undefined;
  if (thinkingLevels) {
    config.thinking_levels = thinkingLevels;
    config.variants = Object.fromEntries(
      thinkingLevels.map((level) => [level, { reasoningEffort: level }]),
    );
  }

  // reasoning_options from 9Router per-model endpoint (if provided)
  // These are raw/validated controls that supplement or override bulk thinking_levels.
  // May live nested under capabilities or at the top level depending on backend shape.
  const rawReasoningOptions =
    Array.isArray(info.capabilities?.reasoning_options) && info.capabilities.reasoning_options.length > 0
      ? info.capabilities.reasoning_options
      : Array.isArray(info.reasoning_options) && info.reasoning_options.length > 0
        ? info.reasoning_options
        : undefined;
  if (rawReasoningOptions) {
    config.reasoning_options = rawReasoningOptions as ReasoningOption[];
    console.log("[capabilities] reasoning_options set for", info.id, "->", JSON.stringify(rawReasoningOptions));
  } else {
    console.log("[capabilities] no reasoning_options for", info.id, "keys:", Object.keys(info));
  }

  // Context window / max output limits. OpenCode's context-usage percentage
  // is computed from `limit.context`; without it, the UI always shows 0%
  // used. 9Router exposes these both nested under `capabilities` and as
  // top-level `context_length` / `max_completion_tokens` fields.
  //
  // OpenCode's config schema requires BOTH `limit.context` and `limit.output`
  // whenever `limit` is present, so a context-only limit is rejected at config
  // load. Image models (e.g. flux-kontext-max) report `output: 0`, which
  // toPositiveInt rejects; emit a limit only when both bounds are valid.
  const contextWindow = info.capabilities?.contextWindow ?? info.context_length;
  const context = toPositiveInt(contextWindow);
  const maxOutput = info.capabilities?.maxOutput ?? info.max_completion_tokens;
  const output = toPositiveInt(maxOutput);
  if (context !== undefined && output !== undefined) {
    config.limit = { context, output };
  }

  return config;
}

/** Normalize a model ID for catalog comparison: strip a known provider
 * prefix, lowercase, and canonicalize dots to dashes. */
function normalizeModelId(modelId: string): string {
  const stripPrefixes = [
    ...Object.keys(KNOWN_PROVIDER_PREFIXES),
    "nvidia/",
    "cmc/",
    "azure/",
    "aws/",
    "gcp/",
  ];

  let stripped = modelId;
  for (const prefix of stripPrefixes) {
    if (modelId.startsWith(prefix)) {
      stripped = modelId.slice(prefix.length);
      break;
    }
  }

  return stripped.toLowerCase().replace(/\./g, "-");
}

/** Last path segment of a catalog ID, normalized for comparison. */
function catalogLastSegment(catalogId: string): string {
  const parts = catalogId.toLowerCase().replace(/\./g, "-").split("/");
  return parts[parts.length - 1] ?? "";
}

/** Project a models.dev entry onto the RouterModelInfo shape. */
function toRouterModelInfo(entry: ModelsDevEntry): RouterModelInfo {
  const inputModalities = entry.modalities?.input ?? [];
  return {
    id: entry.id,
    capabilities: {
      vision: entry.attachment ?? inputModalities.includes("image"),
      tools: entry.tool_call ?? false,
      reasoning: entry.reasoning ?? false,
      audioInput: inputModalities.includes("audio"),
      // models.dev exposes token limits at the entry's top level as
      // limit.context / limit.output. Mirror them onto the capabilities
      // fields mapRouterCapabilities reads so they reach config.limit
      // through the single validated path (toPositiveInt).
      contextWindow: entry.limit?.context,
      maxOutput: entry.limit?.output,
    },
  };
}

/**
 * Find the best models.dev catalog entry for a model ID, matching by suffix
 * (preferred) or substring after stripping known provider prefixes.
 * Returns null when nothing matches.
 */
export function findModelsDevMatch(
  modelId: string,
  catalog: ModelsDevEntry[],
): RouterModelInfo | null {
  const normalized = normalizeModelId(modelId);

  let bestMatch: ModelsDevEntry | null = null;

  for (const entry of catalog) {
    const catalogId = typeof entry.id === "string"
      ? entry.id.toLowerCase().replace(/\./g, "-")
      : "";
    if (catalogId.endsWith(normalized)) {
      bestMatch = entry;
      break;
    }
    if (catalogId.includes(normalized) && !bestMatch) {
      bestMatch = entry;
    }
  }

  return bestMatch ? toRouterModelInfo(bestMatch) : null;
}

/**
 * Find a models.dev catalog entry whose final path segment exactly equals the
 * normalized model ID. Stricter than {@link findModelsDevMatch}: a loose
 * substring hit (e.g. `vision` → `gpt-4-turbo-vision`) is rejected, so combo
 * models are only treated as enriched when the catalog truly knows them.
 */
export function findModelsDevMatchExact(
  modelId: string,
  catalog: ModelsDevEntry[],
): RouterModelInfo | null {
  const normalized = normalizeModelId(modelId);
  for (const entry of catalog) {
    if (typeof entry.id === "string" && catalogLastSegment(entry.id) === normalized) {
      return toRouterModelInfo(entry);
    }
  }
  return null;
}

/**
 * Whether a `/models/info` response carries a meaningful capability signal.
 * A bare `tools: true` (the default stub returned by some 9Router backends) is
 * NOT a signal; vision, reasoning, audio input, or a positive token limit are.
 */
export function isRealRouterSignal(info: RouterModelInfo): boolean {
  const capabilities = info.capabilities;
  if (capabilities?.vision || capabilities?.reasoning || capabilities?.audioInput) {
    return true;
  }
  return toPositiveInt(capabilities?.contextWindow ?? info.context_length) !== undefined;
}

const CAPABILITY_BUDGET_MS = 10000;

/**
 * Resolve capabilities for a batch of model IDs using the models.dev catalog
 * first, then falling back to per-model API queries within a time budget.
 *
 * Combo IDs (see {@link isComboModel}) are held to a stricter bar: they only
 * count as resolved on an exact models.dev match or a meaningful API signal,
 * so backends that return a capability stub for combos do not suppress the
 * forced multimodal defaults.
 */
export async function resolveCapabilitiesBatch(
  modelIds: string[],
  apiURL: string,
  apiKey?: string,
  comboIds?: ReadonlySet<string>,
): Promise<Record<string, Partial<ModelConfig>>> {
  const capabilities: Record<string, Partial<ModelConfig>> = {};

  // 1. Fetch models.dev catalog first (cached 1h → near-instant most runs)
  const catalog = await fetchModelsDevCatalog();

  // 2. Resolve from catalog, queue remainder for API
  const pendingIds: string[] = [];
  for (const id of modelIds) {
    const isCombo = comboIds?.has(id) ?? false;
    let resolved = false;
    if (catalog) {
      const match = isCombo
        ? findModelsDevMatchExact(id, catalog)
        : findModelsDevMatch(id, catalog);
      if (match?.capabilities) {
        capabilities[id] = mapRouterCapabilities(match);
        resolved = true;
      }
      // Even if capabilities not fully resolved, extract reasoning_options from catalog
      // as fallback for models where 9Router bulk doesn't provide thinking_levels
      if (catalog && !resolved) {
        const reasoningOptions = findReasoningOptions(id, catalog);
        if (reasoningOptions) {
          capabilities[id] = {
            ...capabilities[id],
            reasoning: true,
            reasoning_options: reasoningOptions,
          };
          resolved = true;
        }
      }
    }
    if (!resolved) {
      pendingIds.push(id);
    }
  }

  // 3. Only hit per-model API for models not in catalog, with time budget
  if (pendingIds.length === 0) return capabilities;

  const startTime = Date.now();
  for (let i = 0; i < pendingIds.length; i += MAX_CONCURRENT_INFO) {
    if (Date.now() - startTime > CAPABILITY_BUDGET_MS) {
      // Budget exhausted — give up on remaining models, fallback will serve them
      break;
    }
    const batch = pendingIds.slice(i, i + MAX_CONCURRENT_INFO);
    const results = await Promise.allSettled(
      batch.map((id) => fetchModelInfo(apiURL, id, apiKey)),
    );
    for (let j = 0; j < batch.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled" && result.value) {
        const id = batch[j];
        if (comboIds?.has(id) && !isRealRouterSignal(result.value)) {
          continue;
        }
        capabilities[id] = mapRouterCapabilities(result.value);
      } else if (result.status === "rejected") {
        console.log(`[capabilities] per-model fetch rejected for ${batch[j]}: ${result.reason}`);
      }
    }
  }

  return capabilities;
}
