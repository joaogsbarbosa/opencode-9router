// ── Shared Types ───────────────────────────────────────────

/**
 * Optional token limit values carried by 9Router responses and the models.dev
 * catalog. Number and string forms are both possible (values arrive via JSON).
 */
export type TokenLimitValue = number | string;

/**
 * Validated reasoning controls from models.dev catalog.
 * - effort: discrete reasoningEffort values (subset of OpenCode vocabulary)
 * - toggle: boolean enable_thinking switch (9Router-specific body field)
 */
export type ReasoningOption =
  | { type: "effort"; values: string[] }
  | { type: "toggle" };

/**
 * Token limits OpenCode receives per model. OpenCode computes the context-usage
 * percentage shown in the UI from `context`; without it, usage always shows 0%.
 * Both fields are optional because a provider may only report one of them.
 */
export type ModelLimits = {
  context?: number;
  output?: number;
};

/** OpenCode model config fragment generated per discovered model. */
export type ModelConfig = {
  name: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  modalities?: {
    input: Array<"text" | "audio" | "image" | "video" | "pdf">;
    output: Array<"text" | "audio" | "image" | "video" | "pdf">;
  };
  interleaved?: true | { field: "reasoning" | "reasoning_content" | "reasoning_details" };
  limit?: ModelLimits;
  variants?: Record<string, Record<string, unknown>>;
  /** Thinking levels advertised by 9Router, e.g. ["none","low","medium","high"]. */
  thinking_levels?: string[];
  /** Validated catalog controls; lowered to V2 overlays, never provider settings. */
  reasoning_options?: ReasoningOption[];
  search?: boolean;
  context_length?: number;
  max_completion_tokens?: number;
};

/**
 * Model metadata returned by the 9Router `/models/info` endpoint. Capability
 * flags live under `capabilities`; token limits appear both nested there and
 * as top-level `context_length` / `max_completion_tokens` on bulk responses.
 */
export interface RouterModelInfo {
  id: string;
  capabilities?: {
    vision?: boolean;
    audioInput?: boolean;
    tools?: boolean;
    reasoning?: boolean;
    search?: boolean;
    contextWindow?: TokenLimitValue;
    maxOutput?: TokenLimitValue;
    thinking_levels?: string[];
    /** Raw reasoning options from 9Router per-model endpoint (if provided). */
    reasoning_options?: unknown;
  };
  context_length?: TokenLimitValue;
  max_completion_tokens?: TokenLimitValue;
  /** Thinking levels advertised by 9Router for reasoning-capable models. */
  thinking_levels?: string[];
  /** Provider identity from models.dev catalog for exact matching. */
  catalogProvider?: string;
  /** Raw reasoning options from 9Router per-model endpoint (top-level fallback). */
  reasoning_options?: unknown;
}

/**
 * Single entry of the models.dev capability catalog. Shape mirrors a subset
 * of RouterModelInfo plus catalog-specific fields (`attachment`, modalities).
 */
export interface ModelsDevEntry {
  id: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  capabilities?: RouterModelInfo["capabilities"];
  modalities?: { input?: string[]; output?: string[] };
  limit?: ModelLimits;
  /** Validated reasoning controls from catalog (effort values and/or toggle). */
  reasoning_options?: ReasoningOption[];
  /** Provider identity as stored in models.dev (e.g., "openrouter", "zai", "google"). */
  catalogProvider?: string;
  [key: string]: unknown;
}
