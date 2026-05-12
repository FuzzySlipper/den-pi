import { normalizeString } from "./den-string-utils.ts";

type JsonObject = Record<string, unknown>;

export const DEN_CONTEXT_STATUS_SCHEMA = "den_context_status";
export const DEN_CONTEXT_STATUS_SCHEMA_VERSION = 1;

const DEFAULT_WATCH_PERCENT = 65;
const DEFAULT_COMPACT_AFTER_TASK_PERCENT = 80;
const WATCH_AUTO_THRESHOLD_RATIO = 0.75;
const COMPACT_AUTO_THRESHOLD_RATIO = 0.9;

export type ContextRecommendation = "ok" | "watch" | "compact_after_current_task";
export type ContextConfidence = "medium" | "low" | "unknown";
export type ContextEstimateSource = "pi_context_usage_estimate" | "provider_reported_last_assistant_usage" | "unavailable";

export type DenContextStatusInput = {
  generatedAt?: string;
  cwd?: string | null;
  sessionId?: string | null;
  sessionFile?: string | null;
  model?: {
    provider?: string | null;
    id?: string | null;
    contextWindow?: number | null;
    maxTokens?: number | null;
  } | null;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
  sessionEntries?: unknown[];
  compaction?: {
    enabled?: boolean | null;
    reserveTokens?: number | null;
    keepRecentTokens?: number | null;
  } | null;
};

export type DenContextStatus = {
  schema: typeof DEN_CONTEXT_STATUS_SCHEMA;
  schema_version: typeof DEN_CONTEXT_STATUS_SCHEMA_VERSION;
  generated_at: string;
  model: {
    provider: string | null;
    id: string | null;
    display: string | null;
    context_window: number | null;
    max_output_tokens: number | null;
  };
  context: {
    used_tokens_estimate: number | null;
    used_percent_estimate: number | null;
    remaining_tokens_estimate: number | null;
    context_window: number | null;
    source: ContextEstimateSource;
    confidence: ContextConfidence;
    accuracy: "estimate" | "unknown";
    last_usage_timestamp: string | null;
    notes: string[];
  };
  compaction: {
    enabled: boolean | null;
    reserve_tokens: number | null;
    keep_recent_tokens: number | null;
    auto_compact_threshold_tokens: number | null;
    auto_compact_threshold_percent: number | null;
    watch_threshold_percent: number | null;
    compact_after_task_threshold_percent: number | null;
  };
  recommendation: {
    status: ContextRecommendation;
    reason: string;
    action: string;
  };
  session: {
    cwd: string | null;
    session_id: string | null;
    session_file: string | null;
    branch_entry_count: number | null;
  };
};

type UsageSnapshot = {
  tokens: number;
  timestamp: string | null;
};

export function captureDenContextStatus(ctx: any): DenContextStatus {
  return buildDenContextStatus({
    cwd: normalizeString(ctx?.cwd) ?? null,
    sessionId: safeStringCall(ctx?.sessionManager, "getSessionId"),
    sessionFile: safeStringCall(ctx?.sessionManager, "getSessionFile"),
    model: ctx?.model ? {
      provider: normalizeString(ctx.model.provider) ?? null,
      id: normalizeString(ctx.model.id) ?? null,
      contextWindow: finitePositiveNumber(ctx.model.contextWindow),
      maxTokens: finitePositiveNumber(ctx.model.maxTokens),
    } : null,
    contextUsage: safeContextUsage(ctx),
    sessionEntries: safeArrayCall(ctx?.sessionManager, "getBranch"),
    compaction: safeCompactionSettings(ctx),
  });
}

export function buildDenContextStatus(input: DenContextStatusInput): DenContextStatus {
  const modelContextWindow = finitePositiveNumber(input.model?.contextWindow) ?? null;
  const usageContextWindow = finitePositiveNumber(input.contextUsage?.contextWindow) ?? null;
  const contextWindow = usageContextWindow ?? modelContextWindow;
  const modelProvider = normalizeString(input.model?.provider) ?? null;
  const modelId = normalizeString(input.model?.id) ?? null;
  const modelDisplay = modelProvider && modelId ? `${modelProvider}/${modelId}` : modelId ?? modelProvider;
  const notes: string[] = [];

  let usedTokens: number | null = null;
  let usedPercent: number | null = null;
  let source: ContextEstimateSource = "unavailable";
  let confidence: ContextConfidence = "unknown";
  let lastUsageTimestamp: string | null = null;

  if (input.contextUsage) {
    source = "pi_context_usage_estimate";
    if (typeof input.contextUsage.tokens === "number" && Number.isFinite(input.contextUsage.tokens)) {
      usedTokens = Math.max(0, Math.round(input.contextUsage.tokens));
    }
    if (typeof input.contextUsage.percent === "number" && Number.isFinite(input.contextUsage.percent)) {
      usedPercent = roundPercent(input.contextUsage.percent);
    } else if (usedTokens !== null && contextWindow) {
      usedPercent = roundPercent((usedTokens / contextWindow) * 100);
    }

    if (usedTokens === null || usedPercent === null) {
      confidence = "unknown";
      notes.push("Pi reported that current context usage is unknown, commonly immediately after compaction before the next model response refreshes usage.");
    } else {
      confidence = "medium";
      notes.push("Uses Pi ctx.getContextUsage(), which estimates current session context from provider usage and trailing message size; it is not exact tokenizer accounting.");
    }
  }

  if (usedTokens === null && !input.contextUsage) {
    const lastUsage = lastAssistantUsageFromEntries(input.sessionEntries ?? []);
    if (lastUsage) {
      usedTokens = lastUsage.tokens;
      usedPercent = contextWindow ? roundPercent((usedTokens / contextWindow) * 100) : null;
      source = "provider_reported_last_assistant_usage";
      confidence = "low";
      lastUsageTimestamp = lastUsage.timestamp;
      notes.push("Falls back to the last successful assistant message's provider-reported usage from the current session branch.");
      notes.push("The fallback can be stale and does not include user/tool/custom messages added after that assistant response.");
    }
  }

  if (source === "unavailable") {
    notes.push("No Pi context usage estimate or provider-reported assistant usage was available in this session context.");
  }

  if (!contextWindow) {
    notes.push("The active model does not expose a configured context window, so remaining tokens and percent cannot be computed reliably.");
  }

  const compaction = normalizeCompaction(input.compaction, contextWindow);
  const remainingTokens = usedTokens !== null && contextWindow !== null
    ? Math.max(0, Math.round(contextWindow - usedTokens))
    : null;
  const recommendation = recommendContextAction({
    usedPercent,
    confidence,
    compaction,
  });

  return {
    schema: DEN_CONTEXT_STATUS_SCHEMA,
    schema_version: DEN_CONTEXT_STATUS_SCHEMA_VERSION,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    model: {
      provider: modelProvider,
      id: modelId,
      display: modelDisplay,
      context_window: contextWindow,
      max_output_tokens: finitePositiveNumber(input.model?.maxTokens) ?? null,
    },
    context: {
      used_tokens_estimate: usedTokens,
      used_percent_estimate: usedPercent,
      remaining_tokens_estimate: remainingTokens,
      context_window: contextWindow,
      source,
      confidence,
      accuracy: usedTokens === null || usedPercent === null ? "unknown" : "estimate",
      last_usage_timestamp: lastUsageTimestamp,
      notes,
    },
    compaction,
    recommendation,
    session: {
      cwd: normalizeString(input.cwd) ?? null,
      session_id: normalizeString(input.sessionId) ?? null,
      session_file: normalizeString(input.sessionFile) ?? null,
      branch_entry_count: Array.isArray(input.sessionEntries) ? input.sessionEntries.length : null,
    },
  };
}

export function buildDenContextStatusToolResult(status: DenContextStatus) {
  return {
    content: [{ type: "text", text: formatDenContextStatusLines(status).join("\n") }],
    details: status,
    isError: false,
  };
}

export function summarizeDenContextStatusForMetadata(status: DenContextStatus): JsonObject {
  return omitUndefined({
    schema: status.schema,
    schema_version: status.schema_version,
    generated_at: status.generated_at,
    recommendation: status.recommendation.status,
    source: status.context.source,
    confidence: status.context.confidence,
    used_tokens_estimate: status.context.used_tokens_estimate,
    used_percent_estimate: status.context.used_percent_estimate,
    remaining_tokens_estimate: status.context.remaining_tokens_estimate,
    context_window: status.context.context_window,
    model: status.model.display,
    compaction_enabled: status.compaction.enabled,
    auto_compact_threshold_percent: status.compaction.auto_compact_threshold_percent,
  });
}

export function formatDenContextStatusLines(status: DenContextStatus): string[] {
  const lines = [
    `Context recommendation: ${status.recommendation.status}`,
    `Reason: ${status.recommendation.reason}`,
    `Action: ${status.recommendation.action}`,
    `Model: ${status.model.display ?? "unknown"}`,
    `Context window: ${formatTokenValue(status.context.context_window)}`,
    `Used estimate: ${formatTokenValue(status.context.used_tokens_estimate)} (${formatPercentValue(status.context.used_percent_estimate)})`,
    `Remaining estimate: ${formatTokenValue(status.context.remaining_tokens_estimate)}`,
    `Source: ${status.context.source}`,
    `Confidence: ${status.context.confidence}; accuracy: ${status.context.accuracy}`,
    `Compaction: ${formatCompaction(status)}`,
  ];

  if (status.context.notes.length > 0) {
    lines.push("Notes:");
    for (const note of status.context.notes) lines.push(`- ${note}`);
  }

  return lines;
}

function recommendContextAction(options: {
  usedPercent: number | null;
  confidence: ContextConfidence;
  compaction: DenContextStatus["compaction"];
}): DenContextStatus["recommendation"] {
  if (options.usedPercent === null) {
    return {
      status: "watch",
      reason: "Context usage is unknown, so do not assume there is ample room for a large task.",
      action: "Continue small in-flight work if necessary, but check again after the next model response or compact at a natural boundary before starting a large task.",
    };
  }

  const compactThreshold = options.compaction.compact_after_task_threshold_percent ?? DEFAULT_COMPACT_AFTER_TASK_PERCENT;
  const watchThreshold = options.compaction.watch_threshold_percent ?? DEFAULT_WATCH_PERCENT;

  if (options.usedPercent >= compactThreshold) {
    const thresholdReason = options.compaction.auto_compact_threshold_percent !== null
      ? `near Pi auto-compaction threshold (${formatPercentValue(options.compaction.auto_compact_threshold_percent)})`
      : `at or above ${formatPercentValue(compactThreshold)}`;
    return {
      status: "compact_after_current_task",
      reason: `Estimated context use is ${formatPercentValue(options.usedPercent)}, ${thresholdReason}.`,
      action: "Finish the current handoff/review/merge step, record durable Den state, then call den_compact_context with durable_context_posted=true before starting another substantial task.",
    };
  }

  if (options.usedPercent >= watchThreshold) {
    return {
      status: "watch",
      reason: `Estimated context use is ${formatPercentValue(options.usedPercent)}, above the watch threshold (${formatPercentValue(watchThreshold)}).`,
      action: "Prefer calling den_compact_context between tasks or before launching into a long implementation/review loop; avoid mid-handoff compaction unless necessary.",
    };
  }

  const caveat = options.confidence === "low" ? " The estimate is low-confidence, so recheck after the next response if the session feels long." : "";
  return {
    status: "ok",
    reason: `Estimated context use is ${formatPercentValue(options.usedPercent)}, below the watch threshold (${formatPercentValue(watchThreshold)}).`,
    action: `Continue normally.${caveat}`,
  };
}

function normalizeCompaction(input: DenContextStatusInput["compaction"], contextWindow: number | null): DenContextStatus["compaction"] {
  const enabled = typeof input?.enabled === "boolean" ? input.enabled : null;
  const reserveTokens = finiteNonNegativeNumber(input?.reserveTokens) ?? null;
  const keepRecentTokens = finiteNonNegativeNumber(input?.keepRecentTokens) ?? null;
  const autoCompactThresholdTokens = contextWindow !== null && reserveTokens !== null && enabled !== false
    ? Math.max(0, contextWindow - reserveTokens)
    : null;
  const autoCompactThresholdPercent = autoCompactThresholdTokens !== null && contextWindow && contextWindow > 0
    ? roundPercent((autoCompactThresholdTokens / contextWindow) * 100)
    : null;
  const watchThresholdPercent = autoCompactThresholdPercent !== null
    ? roundPercent(Math.min(DEFAULT_WATCH_PERCENT, autoCompactThresholdPercent * WATCH_AUTO_THRESHOLD_RATIO))
    : DEFAULT_WATCH_PERCENT;
  const compactAfterTaskThresholdPercent = autoCompactThresholdPercent !== null
    ? roundPercent(Math.min(DEFAULT_COMPACT_AFTER_TASK_PERCENT, autoCompactThresholdPercent * COMPACT_AUTO_THRESHOLD_RATIO))
    : DEFAULT_COMPACT_AFTER_TASK_PERCENT;

  return {
    enabled,
    reserve_tokens: reserveTokens,
    keep_recent_tokens: keepRecentTokens,
    auto_compact_threshold_tokens: autoCompactThresholdTokens,
    auto_compact_threshold_percent: autoCompactThresholdPercent,
    watch_threshold_percent: watchThresholdPercent,
    compact_after_task_threshold_percent: compactAfterTaskThresholdPercent,
  };
}

function safeContextUsage(ctx: any): DenContextStatusInput["contextUsage"] | null {
  try {
    const value = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    if (!isRecord(value)) return null;
    const contextWindow = finitePositiveNumber(value.contextWindow);
    if (contextWindow === undefined) return null;
    return {
      tokens: typeof value.tokens === "number" && Number.isFinite(value.tokens) ? value.tokens : null,
      contextWindow,
      percent: typeof value.percent === "number" && Number.isFinite(value.percent) ? value.percent : null,
    };
  } catch {
    return null;
  }
}

function safeCompactionSettings(ctx: any): DenContextStatusInput["compaction"] | null {
  try {
    const value = ctx?.settingsManager?.getCompactionSettings?.();
    if (!isRecord(value)) return null;
    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : null,
      reserveTokens: finiteNonNegativeNumber(value.reserveTokens) ?? null,
      keepRecentTokens: finiteNonNegativeNumber(value.keepRecentTokens) ?? null,
    };
  } catch {
    return null;
  }
}

function lastAssistantUsageFromEntries(entries: unknown[]): UsageSnapshot | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
    const usage = isRecord(message.usage) ? message.usage : undefined;
    if (!usage) continue;
    const tokens = usageTokens(usage);
    if (tokens === null) continue;
    return {
      tokens,
      timestamp: normalizeString(message.timestamp) ?? normalizeString(entry.timestamp) ?? null,
    };
  }
  return undefined;
}

function usageTokens(usage: Record<string, unknown>): number | null {
  const totalTokens = finitePositiveNumber(usage.totalTokens);
  if (totalTokens !== undefined) return Math.round(totalTokens);
  const parts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].map(finiteNonNegativeNumber);
  if (parts.some((value) => value === undefined)) return null;
  return Math.round((parts as number[]).reduce((sum, value) => sum + value, 0));
}

function safeStringCall(target: any, method: string): string | null {
  try {
    return normalizeString(target?.[method]?.()) ?? null;
  } catch {
    return null;
  }
}

function safeArrayCall(target: any, method: string): unknown[] {
  try {
    const value = target?.[method]?.();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finitePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatTokenValue(value: number | null): string {
  if (value === null) return "unknown";
  if (value < 1000) return `${value}`;
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatPercentValue(value: number | null): string {
  return value === null ? "unknown" : `${value.toFixed(1)}%`;
}

function formatCompaction(status: DenContextStatus): string {
  const parts = [];
  parts.push(status.compaction.enabled === null ? "unknown" : status.compaction.enabled ? "enabled" : "disabled");
  if (status.compaction.reserve_tokens !== null) parts.push(`reserve ${formatTokenValue(status.compaction.reserve_tokens)}`);
  if (status.compaction.auto_compact_threshold_percent !== null) {
    parts.push(`auto threshold ${formatPercentValue(status.compaction.auto_compact_threshold_percent)} (${formatTokenValue(status.compaction.auto_compact_threshold_tokens)})`);
  }
  return parts.join(", ");
}

function omitUndefined(value: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}
