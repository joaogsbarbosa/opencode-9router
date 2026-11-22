// ── Reasoning Controls from models.dev Catalog ───────────────

import type { ModelsDevEntry, ReasoningOption } from "./types.js";

/**
 * 9Router provider ID prefixes → models.dev provider identities.
 * Identity translation only; not capability presets.
 * Subset of 9Router's PROVIDER_ALIASES at pinned commit 89ffac5a2c8108449c432afd1ad6531578fa81cd.
 * Unlisted provider IDs are matched unchanged.
 */
export const CATALOG_PROVIDERS: Record<string, string> = {
  glm: "zai",
  "glm-cn": "zhipuai",
  zhipu: "zhipuai",
  gemini: "google",
  kimi: "moonshotai",
  "kimi-cn": "moonshotai-cn",
  qwen: "alibaba",
  "qwen-cn": "alibaba-cn",
  github: "github-copilot",
  gh: "github-copilot",
  claude: "anthropic",
  doubao: "volcengine",
  "cloudflare-ai": "cloudflare-workers-ai",
};

/**
 * Find reasoning options for a model ID from the models.dev catalog.
 * Requires EXACT provider + full model ID match (after prefix translation).
 * Returns undefined for ambiguous, unmatched, or non-reasoning entries.
 * All values are passed through as-is; no vocabulary filtering is applied.
 */
export function findReasoningOptions(
  modelId: string,
  catalog: ModelsDevEntry[],
): ReasoningOption[] | undefined {
  const slash = modelId.indexOf("/");
  if (slash < 1) return undefined;

  const route = modelId.slice(0, slash);
  const provider = CATALOG_PROVIDERS[route] ?? route;
  const id = modelId.slice(slash + 1);

  // Exact match: single entry with matching catalogProvider and id, reasoning=true
  const matches = catalog.filter(
    (entry) =>
      entry.catalogProvider === provider && entry.id === id && entry.reasoning === true,
  );

  if (matches.length !== 1) return undefined;

  const raw = matches[0].reasoning_options;
  if (!Array.isArray(raw)) return undefined;

  const options: ReasoningOption[] = [];

  for (const option of raw) {
    if (!option || typeof option !== "object") continue;

    if (option.type === "effort" && Array.isArray(option.values)) {
      // Deduplicate values; all strings pass through
      const values = [...new Set<string>(option.values.filter((v): v is string => typeof v === "string"))];
      if (values.length) options.push({ type: "effort", values });
    } else if (option.type === "toggle") {
      options.push({ type: "toggle" });
    }
  }

  return options.length ? options : undefined;
}