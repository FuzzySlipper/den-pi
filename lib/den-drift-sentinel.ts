/**
 * Cheap drift sentinel prompt and packet helpers.
 *
 * The sentinel is an optional model-assisted guard between deterministic drift
 * checks and full review. It is intentionally not a correctness reviewer; it
 * only assesses scope, intent, tamper, and packet-consistency risk from bounded
 * inputs prepared by the orchestrator.
 *
 * @module den-drift-sentinel
 */

export type DriftSentinelRisk = "low" | "medium" | "high";

export interface DriftSentinelTaskInput {
  id?: number;
  title?: string;
  status?: string;
  description?: string;
  intent?: string;
}

export interface DriftSentinelPromptInput {
  task: DriftSentinelTaskInput;
  coder_context_packet?: string;
  implementation_packet?: string;
  deterministic_drift?: string;
  diffstat?: string;
  changed_files?: string[];
  suspicious_hunks?: string[];
  max_section_chars?: number;
}

export interface DriftSentinelParsedResult {
  risk?: DriftSentinelRisk;
  conductor_attention_needed?: boolean;
  recommendation?: string;
  reasons?: unknown[];
  raw_json?: unknown;
}

export interface DriftSentinelPacketMeta {
  type: "drift_check_packet";
  prepared_by: "drift_sentinel";
  workflow: "expanded_isolation_with_context";
  version: 1;
  task_id: number | null;
  risk: DriftSentinelRisk | "unknown";
  conductor_attention_needed: boolean | null;
  recommendation: string | null;
  source_deterministic_risk: DriftSentinelRisk | null;
  source_deterministic_message_id: number | null;
  branch: string | null;
  base_ref: string | null;
  head_commit: string | null;
}

const DEFAULT_MAX_SECTION_CHARS = 6_000;
const MAX_REASON_COUNT = 20;

/** Build the bounded prompt for the cheap drift-sentinel role. */
export function buildDriftSentinelPrompt(input: DriftSentinelPromptInput): string {
  const maxChars = normalizeMaxChars(input.max_section_chars);
  const changedFiles = (input.changed_files ?? []).map((file) => `- ${file}`).join("\n") || "(none provided)";
  const hunks = (input.suspicious_hunks ?? []).map((hunk, index) => [
    `### Suspicious hunk ${index + 1}`,
    fenced(bounded(hunk, Math.min(maxChars, 3_000)), "diff"),
  ].join("\n")).join("\n\n") || "(none provided)";

  return [
    "# Drift Sentinel Prompt",
    "",
    "You are a cheap drift-sentinel sub-agent. You are **not** a correctness reviewer.",
    "",
    "## Mission",
    "Assess only whether this implementation appears to drift from the task intent or context packet, or shows tamper/scope-risk signals that need orchestrator attention before full review.",
    "Do not decide whether the code is correct. Do not inspect broad code context. Do not request or run tools. Use only the bounded inputs below.",
    "",
    "## Look Only For",
    "- Task-intent drift or feature creep.",
    "- Scope creep relative to the coder_context_packet and expected files.",
    "- Suspicious/tamper-prone changes, especially tests, scoring harnesses, CI, dependency/project files, generated files, schemas/migrations, secrets, or AGENTS.md.",
    "- Missing, contradictory, or incomplete coder_context_packet / implementation_packet claims.",
    "- Deterministic drift results that appear ignored or contradicted by the implementation packet.",
    "",
    "## Do Not Do",
    "- Do not perform a correctness review or approve the implementation.",
    "- Do not analyze full diffs beyond the selected suspicious hunks provided here.",
    "- Do not propose code fixes unless needed to explain a drift/tamper risk.",
    "- Do not auto-block merge; only state whether orchestrator attention is needed.",
    "",
    "## Required Output",
    "Return JSON only, with this exact shape:",
    fenced(JSON.stringify({
      risk: "low|medium|high",
      conductor_attention_needed: true,
      recommendation: "proceed_to_review|flag_conductor|rerun_or_rework_before_review",
      reasons: [{
        category: "scope|intent|tamper|packet|tests|dependency|other",
        severity: "info|warning|blocking",
        summary: "one concise sentence",
        evidence: ["bounded input reference"],
      }],
      notes: "optional concise note",
    }, null, 2), "json"),
    "",
    "Use `low` only when the bounded inputs show no meaningful drift/tamper concern. Use `medium` when orchestrator/reviewer should look closely. Use `high` when orchestrator attention is needed before full review.",
    "",
    "## Task",
    formatTask(input.task),
    "",
    "## Latest coder_context_packet",
    boundedOrMissing(input.coder_context_packet, maxChars),
    "",
    "## Latest implementation_packet",
    boundedOrMissing(input.implementation_packet, maxChars),
    "",
    "## Deterministic drift results / latest drift_check_packet",
    boundedOrMissing(input.deterministic_drift, maxChars),
    "",
    "## Git diffstat",
    boundedOrMissing(input.diffstat, Math.min(maxChars, 2_000)),
    "",
    "## Changed files",
    bounded(changedFiles, Math.min(maxChars, 3_000)),
    "",
    "## Selected suspicious hunks (optional, bounded)",
    hunks,
  ].join("\n");
}

/** Parse the sentinel's JSON-only output, tolerating fenced JSON. */
export function parseDriftSentinelOutput(output: string): DriftSentinelParsedResult {
  const jsonText = extractJsonText(output);
  if (!jsonText) return {};
  try {
    const parsed = JSON.parse(jsonText);
    const risk = normalizeRisk(parsed?.risk);
    return {
      risk,
      conductor_attention_needed: typeof parsed?.conductor_attention_needed === "boolean" ? parsed.conductor_attention_needed : undefined,
      recommendation: typeof parsed?.recommendation === "string" ? parsed.recommendation : undefined,
      reasons: Array.isArray(parsed?.reasons) ? parsed.reasons.slice(0, MAX_REASON_COUNT) : undefined,
      raw_json: parsed,
    };
  } catch {
    return {};
  }
}

/** Format the sentinel result as a drift_check_packet task-thread message. */
export function formatDriftSentinelPacketMessage(input: {
  task_id?: number;
  branch?: string;
  base_ref?: string;
  head_commit?: string;
  deterministic_risk?: DriftSentinelRisk;
  deterministic_message_id?: number;
  sentinel_output: string;
  parsed?: DriftSentinelParsedResult;
}): string {
  const parsed = input.parsed ?? parseDriftSentinelOutput(input.sentinel_output);
  const risk = parsed.risk ?? "unknown";
  const attention = parsed.conductor_attention_needed;
  const lines = [
    "# Drift Check Packet — Drift Sentinel",
    "",
    `**Risk:** ${risk}`,
    `**Orchestrator attention needed:** ${typeof attention === "boolean" ? (attention ? "yes" : "no") : "unknown"}`,
    `**Recommendation:** ${parsed.recommendation ?? "unknown"}`,
    "",
    "## Source Context",
    "",
    input.task_id !== undefined ? `- Task: \`#${input.task_id}\`` : "- Task: (unknown)",
    `- Branch: ${input.branch ? `\`${input.branch}\`` : "(unknown)"}`,
    `- Head commit: ${input.head_commit ? `\`${input.head_commit}\`` : "(unknown)"}`,
    `- Base ref: ${input.base_ref ? `\`${input.base_ref}\`` : "(unknown)"}`,
    `- Source deterministic risk: ${input.deterministic_risk ?? "(not available)"}`,
    input.deterministic_message_id ? `- Source deterministic drift_check_packet: #${input.deterministic_message_id}` : "- Source deterministic drift_check_packet: (none; prompt used freshly collected deterministic analysis if available)",
    "",
    "## Sentinel Output",
    "",
    fenced(input.sentinel_output.trim() || "(empty output)", "json"),
    "",
    "## Scope Note",
    "",
    "This packet is a cheap drift/tamper/scope sentinel only. It is not a correctness review and does not approve the implementation.",
  ];
  return lines.join("\n");
}

/** Build stable metadata for posting the sentinel result as a drift_check_packet. */
export function buildDriftSentinelPacketMeta(input: {
  task_id?: number;
  branch?: string;
  base_ref?: string;
  head_commit?: string;
  deterministic_risk?: DriftSentinelRisk;
  deterministic_message_id?: number;
  parsed?: DriftSentinelParsedResult;
}): DriftSentinelPacketMeta {
  return {
    type: "drift_check_packet",
    prepared_by: "drift_sentinel",
    workflow: "expanded_isolation_with_context",
    version: 1,
    task_id: input.task_id ?? null,
    risk: input.parsed?.risk ?? "unknown",
    conductor_attention_needed: typeof input.parsed?.conductor_attention_needed === "boolean" ? input.parsed.conductor_attention_needed : null,
    recommendation: input.parsed?.recommendation ?? null,
    source_deterministic_risk: input.deterministic_risk ?? null,
    source_deterministic_message_id: input.deterministic_message_id ?? null,
    branch: input.branch ?? null,
    base_ref: input.base_ref ?? null,
    head_commit: input.head_commit ?? null,
  };
}

function formatTask(task: DriftSentinelTaskInput): string {
  const lines = [
    task.id !== undefined ? `- Task: \`#${task.id}\`` : "- Task: (unknown)",
  ];
  if (task.title) lines.push(`- Title: ${task.title}`);
  if (task.status) lines.push(`- Status: ${task.status}`);
  if (task.intent) lines.push(`- Intent: ${task.intent}`);
  if (task.description) lines.push("", bounded(task.description, 2_000));
  return lines.join("\n");
}

function boundedOrMissing(value: string | undefined, maxChars: number): string {
  return value && value.trim() ? bounded(value, maxChars) : "(missing)";
}

function bounded(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 80))}\n... (truncated; bounded drift sentinel input)`;
}

function fenced(value: string, language: string): string {
  return `\`\`\`${language}\n${value.replace(/```/g, "`\u200b``")}\n\`\`\``;
}

function normalizeMaxChars(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(20_000, Math.floor(value))
    : DEFAULT_MAX_SECTION_CHARS;
}

function normalizeRisk(value: unknown): DriftSentinelRisk | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function extractJsonText(output: string): string | undefined {
  const fencedMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1] : output;
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) return trimmed;
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  return objectMatch?.[0];
}
