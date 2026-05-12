export type JsonObject = Record<string, unknown>;

export const SUBAGENT_RUN_SCHEMA = "den_subagent_run";
export const SUBAGENT_RUN_SCHEMA_VERSION = 1;
export const SUBAGENT_LIFECYCLE_SCHEMA = "den_subagent_lifecycle";
export const SUBAGENT_LIFECYCLE_SCHEMA_VERSION = 1;
export const DEFAULT_REASONING_PREVIEW_CHARS = 240;
export const MIN_REASONING_PREVIEW_CHARS = 1;
export const MAX_REASONING_PREVIEW_CHARS = 2_000;

export type ReasoningCaptureOptions = {
  captureProviderSummaries?: boolean;
  captureRawLocalPreviews?: boolean;
  previewChars?: number;
};

export type ResolvedReasoningCaptureOptions = {
  captureProviderSummaries: boolean;
  captureRawLocalPreviews: boolean;
  previewChars: number;
  rawEnvOverride: boolean;
  rawEnvValue?: boolean;
};

export type SubagentArtifacts = {
  dir: string;
  stdout_jsonl_path: string;
  stderr_log_path: string;
  status_json_path: string;
  events_jsonl_path: string;
  session_dir?: string;
  session_file_path?: string;
  session_id?: string;
};

export type SubagentUsageSummary = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  total_cost?: number;
  currency?: string;
  source: string;
  message_count?: number;
  latest_usage_at?: string;
};

export type ContextMetrics = {
  session?: {
    message_counts_by_role: Record<string, number>;
    model_visible_chars: number;
    session_file_bytes?: number;
  };
  artifacts?: {
    stdout_jsonl_bytes?: number;
    events_jsonl_bytes?: number;
    status_json_bytes?: number;
    stderr_log_bytes?: number;
  };
  usage_summary_source?: string;
};

export type SubagentRunContext = {
  reviewRoundId?: number;
  workspaceId?: string;
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  baseCommit?: string;
  headCommit?: string;
  purpose?: string;
};

export type SubagentRunIdentity = {
  runId: string;
  role: string;
  taskId?: number;
  cwd?: string;
  backend: string;
  model?: string;
  tools?: string;
  sessionMode?: string;
  session?: string;
  rerunOfRunId?: string;
  artifacts?: SubagentArtifacts;
} & SubagentRunContext;

export type SubagentRunState =
  | "running"
  | "retrying"
  | "aborting"
  | "rerun_requested"
  | "rerun_accepted"
  | "complete"
  | "failed"
  | "timeout"
  | "aborted"
  | "unknown";

export type SubagentOpsEventType =
  | "subagent_started"
  | "subagent_process_started"
  | "subagent_heartbeat"
  | "subagent_assistant_output"
  | "subagent_prompt_echo_detected"
  | "subagent_fallback_started"
  | "subagent_abort_requested"
  | "subagent_rerun_requested"
  | "subagent_rerun_accepted"
  | "subagent_rerun_unavailable"
  | "subagent_completed"
  | "subagent_timeout"
  | "subagent_startup_timeout"
  | "subagent_terminal_drain_timeout"
  | "subagent_aborted"
  | "subagent_abort"
  | "subagent_failed"
  | "subagent_spawn_error"
  | "subagent_work_turn_start"
  | "subagent_work_turn_end"
  | "subagent_work_tool_start"
  | "subagent_work_tool_end"
  | "subagent_work_message_end";

export function buildSubagentRunMetadata(
  identity: SubagentRunIdentity,
  extra: JsonObject = {},
): JsonObject {
  return omitUndefined({
    schema: SUBAGENT_RUN_SCHEMA,
    schema_version: SUBAGENT_RUN_SCHEMA_VERSION,
    run_id: identity.runId,
    role: identity.role,
    task_id: identity.taskId ?? null,
    cwd: identity.cwd ?? null,
    backend: identity.backend,
    model: identity.model ?? null,
    tools: identity.tools ?? null,
    session_mode: identity.sessionMode ?? "fresh",
    session: identity.session ?? null,
    rerun_of_run_id: identity.rerunOfRunId ?? null,
    ...buildSubagentRunContextMetadata(identity),
    artifacts: identity.artifacts ?? null,
    ...extra,
  });
}

export function normalizeSubagentRunEvent(event: JsonObject): JsonObject {
  return omitUndefined({
    schema: SUBAGENT_RUN_SCHEMA,
    schema_version: SUBAGENT_RUN_SCHEMA_VERSION,
    ...event,
  });
}

export function buildSubagentLifecycleMetadata(eventName: string, extra: JsonObject = {}): JsonObject {
  return omitUndefined({
    schema: SUBAGENT_LIFECYCLE_SCHEMA,
    schema_version: SUBAGENT_LIFECYCLE_SCHEMA_VERSION,
    operator_event: eventName,
    event_visibility: "summary",
    ...extra,
  });
}

export function taskThreadPacketOperatorEvent(packetType: unknown): string | undefined {
  switch (packetType) {
    case "coder_context_packet":
      return "coder_context_prepared";
    case "implementation_packet":
      return "implementation_packet_posted";
    case "validation_packet":
      return "validation_completed";
    case "drift_check_packet":
      return "drift_check_completed";
    case "implementation_packet_missing":
      return "implementation_packet_missing_posted";
    default:
      return undefined;
  }
}

export function subagentOperatorEventForOpsEvent(eventType: string, role: unknown): string | undefined {
  const normalizedRole = typeof role === "string" ? role.trim().toLowerCase() : undefined;
  if (eventType === "subagent_started" && normalizedRole === "coder") return "coder_started";
  if (eventType === "subagent_started" && normalizedRole === "reviewer") return "reviewer_started";
  if (["subagent_completed", "subagent_failed", "subagent_timeout", "subagent_aborted"].includes(eventType)) {
    if (normalizedRole === "coder") return "coder_completed";
    if (normalizedRole === "reviewer") return "reviewer_completed";
  }
  return undefined;
}

export function subagentEventVisibility(eventType: string): "summary" | "debug" {
  return eventType.startsWith("subagent_work_") ? "debug" : "summary";
}

export function buildSubagentRunContextMetadata(context: SubagentRunContext = {}): JsonObject {
  return {
    review_round_id: optionalPositiveInteger(context.reviewRoundId) ?? null,
    workspace_id: normalizeContextString(context.workspaceId) ?? null,
    worktree_path: normalizeContextString(context.worktreePath) ?? null,
    branch: normalizeContextString(context.branch) ?? null,
    base_branch: normalizeContextString(context.baseBranch) ?? null,
    base_commit: normalizeContextString(context.baseCommit) ?? null,
    /** Starting/requested head commit — the HEAD before the sub-agent begins work. */
    head_commit: normalizeContextString(context.headCommit) ?? null,
    purpose: normalizeSubagentRunPurpose(context.purpose) ?? null,
  };
}

export function normalizeSubagentRunPurpose(value: unknown): string | undefined {
  const normalized = normalizeContextString(value);
  if (!normalized) return undefined;
  const purpose = normalized
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_.:]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return purpose ? purpose.slice(0, 80) : undefined;
}

export function subagentOpsEventTypeForEvent(eventType: string): SubagentOpsEventType | undefined {
  switch (eventType) {
    case "subagent.process_started":
      return "subagent_process_started";
    case "subagent.heartbeat":
      return "subagent_heartbeat";
    case "subagent.assistant_output":
      return "subagent_assistant_output";
    case "subagent.prompt_echo_detected":
      return "subagent_prompt_echo_detected";
    case "subagent.startup_timeout":
      return "subagent_startup_timeout";
    case "subagent.terminal_drain_timeout":
      return "subagent_terminal_drain_timeout";
    case "subagent.abort":
      return "subagent_abort";
    case "subagent.spawn_error":
      return "subagent_spawn_error";
    case "subagent.work_turn_start":
      return "subagent_work_turn_start";
    case "subagent.work_turn_end":
      return "subagent_work_turn_end";
    case "subagent.work_tool_start":
      return "subagent_work_tool_start";
    case "subagent.work_tool_end":
      return "subagent_work_tool_end";
    case "subagent.work_message_end":
      return "subagent_work_message_end";
    default:
      return undefined;
  }
}

export function subagentRunStateFromOpsEventType(eventType: string): SubagentRunState {
  switch (eventType) {
    case "subagent_started":
    case "subagent_process_started":
    case "subagent_heartbeat":
    case "subagent_assistant_output":
    case "subagent_prompt_echo_detected":
    case "subagent_work_turn_start":
    case "subagent_work_turn_end":
    case "subagent_work_tool_start":
    case "subagent_work_tool_end":
    case "subagent_work_message_end":
      return "running";
    case "subagent_fallback_started":
      return "retrying";
    case "subagent_abort_requested":
      return "aborting";
    case "subagent_rerun_requested":
      return "rerun_requested";
    case "subagent_rerun_accepted":
      return "rerun_accepted";
    case "subagent_rerun_unavailable":
      return "failed";
    case "subagent_completed":
      return "complete";
    case "subagent_timeout":
    case "subagent_startup_timeout":
    case "subagent_terminal_drain_timeout":
      return "timeout";
    case "subagent_aborted":
    case "subagent_abort":
      return "aborted";
    case "subagent_failed":
    case "subagent_spawn_error":
      return "failed";
    default:
      return "unknown";
  }
}

export type PiStdoutParseResult =
  | { kind: "json"; line: string; event: any }
  | { kind: "raw_stdout"; line: string };

export type PiWorkEventContext = {
  runId?: string;
  taskId?: number;
  subagentRole?: string;
  backend?: string;
  requestedModel?: string;
  reasoningCapture?: ReasoningCaptureOptions;
};

export type SubagentOutputSnapshot = {
  finalOutput: string;
  model?: string;
  messageCount: number;
  assistantMessageCount: number;
  promptEchoDetected: boolean;
  childErrorMessage?: string;
};

export type SubagentOutputObserver = {
  appendEvent(event: JsonObject): Promise<void> | void;
};

export type SubagentOutputExtractor = {
  updateFromEvent(event: any): string | undefined;
  recordChildError(message: string): void;
  snapshot(): SubagentOutputSnapshot;
};

export type InfrastructureFailureLike = {
  aborted?: boolean;
  timeout_kind?: string;
  forced_kill?: boolean;
  signal?: string;
  child_error_message?: string;
  stderr?: string;
  stderr_tail?: string;
};

export type InfrastructureFailureReason =
  | "aborted"
  | "timeout"
  | "forced_kill"
  | "signal"
  | "child_error"
  | "quota"
  | "extension_load"
  | "extension_runtime";

export function parsePiStdoutLine(line: string): PiStdoutParseResult | undefined {
  if (!line.trim()) return undefined;
  try {
    return { kind: "json", line: line.trim(), event: JSON.parse(line) };
  } catch {
    return { kind: "raw_stdout", line };
  }
}

export function resolveReasoningCaptureOptions(options: ReasoningCaptureOptions = {}): ResolvedReasoningCaptureOptions {
  const rawEnvValue = rawReasoningCaptureEnvValue();
  const captureRawLocalPreviews = rawEnvValue ?? options.captureRawLocalPreviews === true;
  return {
    captureProviderSummaries: options.captureProviderSummaries !== false,
    captureRawLocalPreviews,
    previewChars: normalizeReasoningPreviewChars(options.previewChars),
    rawEnvOverride: rawEnvValue !== undefined,
    rawEnvValue,
  };
}

export function buildReasoningCaptureMetadata(options: ReasoningCaptureOptions = {}): JsonObject {
  const resolved = resolveReasoningCaptureOptions(options);
  return omitUndefined({
    capture_provider_summaries: resolved.captureProviderSummaries,
    capture_raw_local_previews: resolved.captureRawLocalPreviews,
    preview_chars: resolved.previewChars,
    raw_env_override: resolved.rawEnvOverride,
    raw_env_value: resolved.rawEnvValue,
  });
}

export function normalizePiWorkEvent(event: any, now = Date.now(), context: PiWorkEventContext = {}): JsonObject | undefined {
  if (!event || typeof event.type !== "string") return undefined;

  switch (event.type) {
    case "session":
      return omitUndefined({
        type: "subagent.work_session",
        ts: eventTimestamp(event, now),
        source_type: event.type,
        ...workContextMetadata(context),
        session_id: normalizeString(event.id),
        cwd: normalizeString(event.cwd),
        version: optionalNumber(event.version),
      });
    case "agent_start":
      return omitUndefined({
        type: "subagent.work_agent_start",
        ts: eventTimestamp(event, now),
        source_type: event.type,
        ...workContextMetadata(context),
      });
    case "turn_start":
      return omitUndefined({
        type: "subagent.work_turn_start",
        ts: eventTimestamp(event, now),
        source_type: event.type,
        ...workContextMetadata(context),
      });
    case "turn_end":
      return omitUndefined({
        type: "subagent.work_turn_end",
        ts: eventTimestamp(event, now),
        source_type: event.type,
        ...workContextMetadata(context),
        ...summarizeAssistantMessage(event.message),
      });
    case "message_start":
      return normalizePiMessageWorkEvent(event, "start", now, context);
    case "message_update":
      return normalizePiMessageWorkEvent(event, "update", now, context);
    case "message_end":
      return normalizePiMessageWorkEvent(event, "end", now, context);
    case "tool_execution_start":
      return normalizePiToolWorkEvent(event, "start", now, context);
    case "tool_execution_update":
      return normalizePiToolWorkEvent(event, "update", now, context);
    case "tool_execution_end":
      return normalizePiToolWorkEvent(event, "end", now, context);
    default:
      return undefined;
  }
}

function normalizePiMessageWorkEvent(event: any, phase: "start" | "update" | "end", now: number, context: PiWorkEventContext): JsonObject | undefined {
  const message = event.message;
  const role = normalizeString(message?.role);
  if (role !== "assistant") return undefined;

  const messageSummary = summarizeAssistantMessage(message);
  const updateKind = normalizeString(event.assistantMessageEvent?.type);
  const reasoningSummary = summarizeReasoningActivity(event, message, context.reasoningCapture);
  const hasAssistantNarrative = Boolean(messageSummary.text_preview || messageSummary.tool_calls);
  if (reasoningSummary && (isReasoningUpdateKind(updateKind) || !hasAssistantNarrative)) {
    return omitUndefined({
      type: `subagent.work_reasoning_${phase}`,
      ts: eventTimestamp(event, now),
      source_type: event.type,
      ...workContextMetadata(context),
      role,
      provider: normalizeString(message?.provider),
      model: normalizeString(message?.model),
      update_kind: updateKind,
      ...reasoningSummary,
    });
  }
  if (phase === "update" && !hasAssistantNarrative) return undefined;

  return omitUndefined({
    type: `subagent.work_message_${phase}`,
    ts: eventTimestamp(event, now),
    source_type: event.type,
    ...workContextMetadata(context),
    role,
    provider: normalizeString(message?.provider),
    model: normalizeString(message?.model),
    update_kind: updateKind,
    ...messageSummary,
    reasoning_chars: reasoningSummary?.reasoning_chars,
    reasoning_redacted: reasoningSummary?.reasoning_redacted,
  });
}

function normalizePiToolWorkEvent(event: any, phase: "start" | "update" | "end", now: number, context: PiWorkEventContext): JsonObject | undefined {
  const toolName = normalizeString(event.toolName ?? event.tool_name);
  if (!toolName) return undefined;
  const result = event.result ?? event.partialResult ?? event.partial_result;
  if (phase === "update" && !hasMeaningfulToolResult(result)) return undefined;
  const resultPreview = boundedPreview(result, 500);
  const isError = typeof event.isError === "boolean" ? event.isError : typeof event.is_error === "boolean" ? event.is_error : undefined;

  return omitUndefined({
    type: `subagent.work_tool_${phase}`,
    ts: eventTimestamp(event, now),
    source_type: event.type,
    ...workContextMetadata(context),
    tool_call_id: normalizeString(event.toolCallId ?? event.tool_call_id),
    tool_name: toolName,
    args_preview: boundedPreview(event.args, 500),
    result_preview: resultPreview,
    is_error: isError,
  });
}

export function createSubagentOutputExtractor(
  prompt: string,
  observer?: SubagentOutputObserver,
): SubagentOutputExtractor {
  let finalOutput = "";
  let model: string | undefined;
  let childErrorMessage: string | undefined;
  let messageCount = 0;
  let assistantMessageCount = 0;
  let promptEchoDetected = false;

  return {
    updateFromEvent(event: any): string | undefined {
      const message = event.message;
      if (!message) return undefined;
      if (event.type !== "message_end" && event.type !== "tool_result_end") return undefined;
      messageCount++;
      const text = extractText(message);
      if (message.errorMessage && typeof message.errorMessage === "string") childErrorMessage = message.errorMessage;
      if (message.role !== "assistant") return undefined;

      assistantMessageCount++;
      if (message.model && typeof message.model === "string") model = message.model;
      if (!text) return undefined;
      const terminalAssistantMessage = event.type === "message_end" && isTerminalAssistantMessage(message);
      if (!terminalAssistantMessage) return undefined;

      if (isPromptEcho(text, prompt)) {
        promptEchoDetected = true;
        void observer?.appendEvent({
          type: "subagent.prompt_echo_detected",
          ts: Date.now(),
          chars: text.length,
          terminal: true,
        });
        return undefined;
      }

      finalOutput = text;
      void observer?.appendEvent({
        type: "subagent.assistant_output",
        ts: Date.now(),
        chars: text.length,
        terminal: true,
      });
      return text;
    },
    recordChildError(message: string) {
      childErrorMessage = message;
    },
    snapshot() {
      return {
        finalOutput,
        model,
        messageCount,
        assistantMessageCount,
        promptEchoDetected,
        childErrorMessage,
      };
    },
  };
}

export function isSubagentInfrastructureFailure(result: InfrastructureFailureLike): boolean {
  return Boolean(classifySubagentInfrastructureFailure(result));
}

export function classifySubagentInfrastructureFailure(
  result: InfrastructureFailureLike,
): InfrastructureFailureReason | undefined {
  if (result.aborted) return "aborted";
  if (result.timeout_kind) return "timeout";
  if (result.forced_kill) return "forced_kill";
  if (result.signal) return "signal";
  if (result.child_error_message && isQuotaFailureMessage(result.child_error_message)) return "quota";
  if (result.child_error_message) return "child_error";

  const stderr = `${result.stderr_tail ?? ""}\n${result.stderr ?? ""}`;
  const quotaReason = classifySubagentStderrQuota(stderr);
  if (quotaReason) return quotaReason;
  return classifySubagentStderrIssue(stderr);
}

export function classifySubagentStderrIssue(stderr: string): InfrastructureFailureReason | undefined {
  if (isExtensionLoadFailure(stderr)) return "extension_load";
  if (isExtensionRuntimeFailure(stderr)) return "extension_runtime";
  return undefined;
}

/// Quota failure patterns for 429/rate-limit/quota-exceeded provider errors.
const QUOTA_PATTERNS = [
  /429/i,
  /rate\s*limit/i,
  /too many requests/i,
  /quota/i,
  /insufficient.*tokens/i,
  /usage.*limit/i,
  /capacity.*limit/i,
  /throttled/i,
  /resource.*exhausted/i,
  /model.*unavailable/i,
  /exceeded.*model/i,
  /provider.*overloaded/i,
];

function isQuotaFailureMessage(message: string): boolean {
  return QUOTA_PATTERNS.some((pattern) => pattern.test(message));
}

function classifySubagentStderrQuota(stderr: string): InfrastructureFailureReason | undefined {
  return isQuotaFailureMessage(stderr) ? "quota" : undefined;
}

function isExtensionLoadFailure(stderr: string): boolean {
  return /Failed to load extension/i.test(stderr)
    || /Extension does not export a valid factory function/i.test(stderr);
}

function isExtensionRuntimeFailure(stderr: string): boolean {
  return /Extension error \([^)]+\):/i.test(stderr)
    || /This extension ctx is stale after session replacement or reload/i.test(stderr);
}

export function isTerminalAssistantMessage(message: any): boolean {
  if (!message || message.role !== "assistant") return false;
  if (!extractText(message)) return false;
  const stopReason = String(message.stopReason ?? message.stop_reason ?? "");
  if (stopReason && stopReason !== "stop" && stopReason !== "end_turn") return false;
  if (!Array.isArray(message.content)) return true;
  return !message.content.some((part: any) => part?.type === "toolCall" || part?.type === "tool_call");
}

export function extractText(message: any): string | undefined {
  if (!Array.isArray(message.content)) return undefined;
  for (let i = message.content.length - 1; i >= 0; i--) {
    const part = message.content[i];
    if (part?.type === "text" && typeof part.text === "string") return part.text;
  }
  return undefined;
}

function summarizeAssistantMessage(message: any): JsonObject {
  if (!message || message.role !== "assistant") return {};
  const text = extractText(message);
  const toolCalls = extractToolCallSummaries(message);
  return omitUndefined({
    text_preview: boundedPreview(text, 240),
    text_chars: typeof text === "string" ? text.length : undefined,
    content_types: extractContentTypes(message),
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    stop_reason: normalizeString(message.stopReason ?? message.stop_reason),
  });
}

function summarizeReasoningActivity(event: any, message: any, options?: ReasoningCaptureOptions): JsonObject | undefined {
  const capture = resolveReasoningCaptureOptions(options);
  const eventKind = normalizeString(event?.assistantMessageEvent?.type);
  const reasoningText = extractReasoningText(event, message);
  const providerVisibleSummaryText = extractProviderVisibleReasoningSummaryText(event, message);
  const emittedProviderSummaryText = capture.captureProviderSummaries ? providerVisibleSummaryText : undefined;
  const rawReasoningText = providerVisibleSummaryText && reasoningText === providerVisibleSummaryText
    ? undefined
    : reasoningText;
  const contentTypes = extractContentTypes(message) ?? [];
  const looksLikeReasoning = Boolean(reasoningText || providerVisibleSummaryText)
    || isReasoningUpdateKind(eventKind)
    || contentTypes.some((type) => /thinking|reasoning/i.test(type));
  if (!looksLikeReasoning) return undefined;

  const chars = typeof rawReasoningText === "string"
    ? rawReasoningText.length
    : typeof providerVisibleSummaryText === "string"
      ? providerVisibleSummaryText.length
      : optionalNumber(event?.assistantMessageEvent?.chars ?? event?.assistantMessageEvent?.length);
  const sourceRedacted = hasRedactedReasoning(message);
  const exposeRaw = capture.captureRawLocalPreviews && !sourceRedacted && Boolean(rawReasoningText);
  return omitUndefined({
    reasoning_kind: eventKind ?? "thinking",
    reasoning_chars: chars,
    reasoning_redacted: !exposeRaw,
    text_preview: exposeRaw ? boundedPreview(rawReasoningText, capture.previewChars) : undefined,
    reasoning_summary_preview: boundedPreview(emittedProviderSummaryText, capture.previewChars),
    reasoning_summary_chars: typeof emittedProviderSummaryText === "string" ? emittedProviderSummaryText.length : undefined,
    reasoning_summary_source: emittedProviderSummaryText ? "provider_visible" : undefined,
    content_types: contentTypes.length > 0 ? contentTypes : undefined,
    stop_reason: normalizeString(message?.stopReason ?? message?.stop_reason),
  });
}

function isReasoningUpdateKind(value: string | undefined): boolean {
  return Boolean(value && /thinking|reasoning/i.test(value));
}

function extractReasoningText(event: any, message: any): string | undefined {
  const assistantEvent = event?.assistantMessageEvent;
  const eventCandidates = [
    assistantEvent?.delta,
    assistantEvent?.content,
    assistantEvent?.thinking,
    assistantEvent?.reasoning,
    assistantEvent?.text,
    assistantEvent?.partial?.thinking,
    assistantEvent?.partial?.reasoning,
  ];
  for (const candidate of eventCandidates) {
    const text = normalizeString(candidate);
    if (text) return text;
  }

  if (!Array.isArray(message?.content)) return undefined;
  const parts = message.content
    .filter((part: any) => part?.type === "thinking" || part?.type === "reasoning")
    .map((part: any) => typeof part.thinking === "string" ? part.thinking : typeof part.reasoning === "string" ? part.reasoning : "")
    .filter((text: string) => text.length > 0);
  return parts.length > 0 ? parts.join("") : undefined;
}

function extractProviderVisibleReasoningSummaryText(event: any, message: any): string | undefined {
  const assistantEvent = event?.assistantMessageEvent;
  const eventCandidates = [
    assistantEvent?.summary,
    assistantEvent?.summaryText,
    assistantEvent?.summary_text,
    assistantEvent?.reasoningSummary,
    assistantEvent?.reasoning_summary,
    assistantEvent?.reasoningSummaryText,
    assistantEvent?.reasoning_summary_text,
    assistantEvent?.thinkingSummary,
    assistantEvent?.thinking_summary,
  ];
  for (const candidate of eventCandidates) {
    const text = extractSummaryText(candidate);
    if (text) return text;
  }

  const summaryEventType = normalizeString(assistantEvent?.type);
  if (summaryEventType && /summary/i.test(summaryEventType)) {
    const text = extractSummaryText(assistantEvent?.delta)
      ?? extractSummaryText(assistantEvent?.content)
      ?? extractSummaryText(assistantEvent?.text)
      ?? extractSummaryText(assistantEvent?.part);
    if (text) return text;
  }

  const partialSummary = extractReasoningSummaryFromContent(assistantEvent?.partial?.content);
  if (partialSummary) return partialSummary;

  return extractReasoningSummaryFromContent(message?.content);
}

function extractReasoningSummaryFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    if (item.type !== "thinking" && item.type !== "reasoning") continue;

    const directSummary = extractSummaryText(item.summary)
      ?? extractSummaryText(item.summaryText)
      ?? extractSummaryText(item.summary_text)
      ?? extractSummaryText(item.reasoningSummary)
      ?? extractSummaryText(item.reasoning_summary)
      ?? extractSummaryText(item.thinkingSummary)
      ?? extractSummaryText(item.thinking_summary);
    if (directSummary) return directSummary;

    const signatureSummary = extractReasoningSummaryFromSignature(
      item.thinkingSignature ?? item.reasoningSignature ?? item.signature,
    );
    if (signatureSummary) return signatureSummary;
  }
  return undefined;
}

function extractReasoningSummaryFromSignature(value: unknown): string | undefined {
  const signature = normalizeString(value);
  if (!signature || !signature.startsWith("{")) return undefined;

  try {
    const parsed = JSON.parse(signature);
    return extractSummaryText(parsed?.summary)
      ?? extractSummaryText(parsed?.reasoning_summary)
      ?? extractSummaryText(parsed?.thinking_summary);
  } catch {
    return undefined;
  }
}

function extractSummaryText(value: unknown): string | undefined {
  const direct = normalizeString(value);
  if (direct) return direct;

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractSummaryText(entry))
      .filter((entry): entry is string => Boolean(entry));
    return normalizeString(parts.join("\n\n"));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return extractSummaryText(record.text)
      ?? extractSummaryText(record.summary)
      ?? extractSummaryText(record.content);
  }

  return undefined;
}

function hasRedactedReasoning(message: any): boolean {
  if (!Array.isArray(message?.content)) return false;
  return message.content.some((part: any) =>
    (part?.type === "thinking" || part?.type === "reasoning") && part?.redacted === true,
  );
}

function rawReasoningCaptureEnvValue(): boolean | undefined {
  const value = process.env.DEN_PI_SUBAGENT_RAW_REASONING;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function normalizeReasoningPreviewChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_REASONING_PREVIEW_CHARS;
  return Math.min(MAX_REASONING_PREVIEW_CHARS, Math.max(MIN_REASONING_PREVIEW_CHARS, Math.floor(value)));
}

function extractContentTypes(message: any): string[] | undefined {
  if (!Array.isArray(message?.content)) return undefined;
  const types = Array.from(new Set(message.content
    .map((part: any) => normalizeString(part?.type))
    .filter((type: string | undefined): type is string => Boolean(type))));
  return types.length > 0 ? types : undefined;
}

function extractToolCallSummaries(message: any): JsonObject[] {
  if (!Array.isArray(message?.content)) return [];
  return message.content
    .filter((part: any) => part?.type === "toolCall" || part?.type === "tool_call")
    .slice(0, 8)
    .map((part: any) => omitUndefined({
      id: normalizeString(part.id ?? part.toolCallId ?? part.tool_call_id),
      name: normalizeString(part.name ?? part.toolName ?? part.tool_name),
      args_preview: boundedPreview(part.arguments ?? part.args, 300),
    }));
}

function hasMeaningfulToolResult(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "object") return true;
  const content = (value as { content?: unknown }).content;
  if (Array.isArray(content)) return content.length > 0;
  return true;
}

export function summarizeSubagentUsageFromSessionJsonl(sessionJsonl: string | undefined): SubagentUsageSummary | undefined {
  if (!sessionJsonl) return undefined;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalCost = 0;
  let currency: string | undefined;
  let messageCount = 0;
  let latestUsageAt: string | undefined;

  for (const line of sessionJsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (message?.role !== "assistant" || !message.usage || typeof message.usage !== "object") continue;
    const usage = message.usage as Record<string, unknown>;
    const inputTokens = finiteNonNegativeInteger(usage.input);
    const outputTokens = finiteNonNegativeInteger(usage.output);
    const cacheReadTokens = finiteNonNegativeInteger(usage.cacheRead ?? usage.cache_read);
    const cacheWriteTokens = finiteNonNegativeInteger(usage.cacheWrite ?? usage.cache_write);
    const totalTokens = finiteNonNegativeInteger(usage.totalTokens ?? usage.total_tokens);
    if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined && cacheWriteTokens === undefined && totalTokens === undefined) continue;

    input += inputTokens ?? 0;
    output += outputTokens ?? 0;
    cacheRead += cacheReadTokens ?? 0;
    cacheWrite += cacheWriteTokens ?? 0;
    messageCount++;
    latestUsageAt = normalizeString(entry.timestamp) ?? latestUsageAt;

    const cost = usage.cost;
    if (cost && typeof cost === "object") {
      const costRecord = cost as Record<string, unknown>;
      totalCost += finiteNonNegativeNumber(costRecord.total) ?? 0;
      currency = normalizeString(costRecord.currency) ?? currency;
    }
  }

  if (messageCount === 0) return undefined;
  const computedTotal = input + output + cacheRead + cacheWrite;
  return omitUndefined({
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: computedTotal > 0 ? computedTotal : undefined,
    total_cost: totalCost > 0 ? totalCost : undefined,
    currency,
    source: "pi_session_assistant_usage",
    message_count: messageCount,
    latest_usage_at: latestUsageAt,
  }) as SubagentUsageSummary;
}

export function collectContextMetricsFromSessionJsonl(sessionJsonl: string | undefined): { session: { message_counts_by_role: Record<string, number>; model_visible_chars: number } } | undefined {
  if (!sessionJsonl) return undefined;
  const countsByRole: Record<string, number> = {};
  let modelVisibleChars = 0;
  for (const line of sessionJsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: any;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (entry?.type !== "message" || !entry?.message) continue;
    const msg = entry.message;
    const role = typeof msg.role === "string" ? msg.role : undefined;
    if (role) {
      countsByRole[role] = (countsByRole[role] ?? 0) + 1;
    }
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "text" && typeof part.text === "string") {
          modelVisibleChars += part.text.length;
        }
      }
    }
  }
  if (Object.keys(countsByRole).length === 0) return undefined;
  return {
    session: {
      message_counts_by_role: countsByRole,
      model_visible_chars: modelVisibleChars,
    },
  };
}

function workContextMetadata(context: PiWorkEventContext): JsonObject {
  return omitUndefined({
    run_id: normalizeString(context.runId),
    task_id: optionalPositiveInteger(context.taskId),
    subagent_role: normalizeString(context.subagentRole),
    backend: normalizeString(context.backend),
    requested_model: normalizeString(context.requestedModel),
  });
}

function eventTimestamp(event: any, fallback: number): number {
  const candidates = [
    event?.ts,
    event?.timestamp,
    event?.message?.timestamp,
    event?.assistantMessageEvent?.timestamp,
    event?.assistantMessageEvent?.partial?.timestamp,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNonNegativeNumber(value);
  return number === undefined ? undefined : Math.round(number);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeContextString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const oneLineValue = value.replace(/\s+/g, " ").trim();
  if (!oneLineValue) return undefined;
  return oneLineValue.length <= 500 ? oneLineValue : oneLineValue.slice(0, 500);
}

function boundedPreview(value: unknown, maxChars: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = typeof value === "string" ? value : safeJson(value);
  const oneLineValue = raw.replace(/\s+/g, " ").trim();
  if (!oneLineValue) return undefined;
  return oneLineValue.length <= maxChars ? oneLineValue : `${oneLineValue.slice(0, Math.max(0, maxChars - 1))}…`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isPromptEcho(text: string, prompt: string): boolean {
  const normalizedText = normalizeForEchoDetection(text);
  const normalizedPrompt = normalizeForEchoDetection(prompt);
  if (!normalizedText || !normalizedPrompt) return false;
  if (normalizedText === normalizedPrompt) return true;
  const prefix = normalizedPrompt.slice(0, Math.min(normalizedPrompt.length, 500));
  return prefix.length > 80 && normalizedText.includes(prefix);
}

function omitUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function normalizeForEchoDetection(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Context metrics collection and status artifact enrichment
// Moved from den-subagent.ts so tests can import them without typebox deps.
// ---------------------------------------------------------------------------

import { readFile, stat } from "node:fs/promises";
import { optionalNumber } from "./den-string-utils.ts";

export type ContextMetricsRecorder = {
  artifacts: { status_json_path: string };
  writeStatus(payload: JsonObject): Promise<void>;
};

/** Collect session and artifact context metrics for a completed sub-agent run. */
export async function collectContextMetricsForRun(
  result: { pi_session_file_path?: string; usage_summary?: { source?: string }; artifacts: SubagentArtifacts },
  artifacts: SubagentArtifacts,
): Promise<ContextMetrics | undefined> {
  // Session metrics from session JSONL
  let sessionMetrics: ContextMetrics["session"];
  if (result.pi_session_file_path) {
    try {
      const sessionContent = await readFile(result.pi_session_file_path, "utf8");
      const sessionFileStats = await stat(result.pi_session_file_path);
      const parsed = collectContextMetricsFromSessionJsonl(sessionContent);
      sessionMetrics = parsed
        ? { ...parsed.session, session_file_bytes: sessionFileStats.size }
        : undefined;
    } catch {
      // Session metrics are optional
    }
  }

  // Artifact sizes
  let artifactMetrics: ContextMetrics["artifacts"];
  try {
    const sizes = await Promise.all([
      statOrUndefined(artifacts.stdout_jsonl_path),
      statOrUndefined(artifacts.events_jsonl_path),
      statOrUndefined(artifacts.status_json_path),
      statOrUndefined(artifacts.stderr_log_path),
    ]);
    artifactMetrics = {
      stdout_jsonl_bytes: sizes[0]?.size,
      events_jsonl_bytes: sizes[1]?.size,
      status_json_bytes: sizes[2]?.size,
      stderr_log_bytes: sizes[3]?.size,
    };
  } catch {
    // Artifact metrics are optional
  }

  const usageSummarySource = result.usage_summary?.source;
  if (!sessionMetrics && !artifactMetrics && !usageSummarySource) return undefined;

  return omitContextUndefined({
    session: sessionMetrics,
    artifacts: artifactMetrics,
    usage_summary_source: usageSummarySource,
  }) as ContextMetrics;
}

async function statOrUndefined(filePath: string): Promise<{ size: number } | undefined> {
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
}

function omitContextUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}

/** Enrich a sub-agent status.json with final-head metadata and context_metrics. */
export async function enrichStatusJson(
  recorder: ContextMetricsRecorder,
  finalHeadMetadata: JsonObject,
  contextMetrics: ContextMetrics | undefined,
): Promise<void> {
  try {
    const currentText = await readFile(recorder.artifacts.status_json_path, "utf8");
    const current = JSON.parse(currentText);
    const enriched = {
      ...current,
      ...finalHeadMetadata,
      context_metrics: contextMetrics ?? null,
    };
    await recorder.writeStatus(enriched);
  } catch {
    // Status enrichment is best-effort; the runner's final status write remains the fallback.
  }
}
