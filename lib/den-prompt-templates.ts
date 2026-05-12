import { normalizeString, oneLine } from "./den-string-utils.ts";

export const CODER_PROMPT_SLUG = "pi-coder-subagent-prompt";
export const REVIEWER_PROMPT_SLUG = "pi-reviewer-subagent-prompt";

const STRUCTURED_PACKET_TYPES = [
  "coder_context_packet",
  "implementation_packet",
  "validation_packet",
  "drift_check_packet",
  "review_request",
  "review_feedback",
] as const;

export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => values[key] ?? "");
}

export function summarizeTaskContext(detail: any): string {
  const parts: string[] = [];
  const task = detail?.task ?? detail;
  if (task?.status) parts.push(`Status: ${task.status}`);
  if (task?.assigned_to) parts.push(`Assigned to: ${task.assigned_to}`);
  if (task?.tags?.length) parts.push(`Tags: ${task.tags.join(", ")}`);

  const dependencies = Array.isArray(detail?.dependencies) ? detail.dependencies : [];
  if (dependencies.length > 0) {
    parts.push(`Dependencies: ${dependencies.map((dep: any) => `#${dep.task_id ?? dep.id ?? dep.taskId} ${dep.title}`).join("; ")}`);
  }

  const subtasks = Array.isArray(detail?.subtasks) ? detail.subtasks : [];
  if (subtasks.length > 0) {
    parts.push(`Subtasks: ${subtasks.map((subtask: any) => `#${subtask.id} [${subtask.status}] ${subtask.title}`).join("; ")}`);
  }

  const messages = taskMessages(detail);
  appendLatestStructuredPackets(parts, messages);

  if (messages.length > 0) {
    parts.push("Recent messages:");
    for (const message of messages.slice(0, 8)) {
      const packetType = metadataType(message?.metadata);
      const packetSuffix = packetType ? ` [${packetType}]` : "";
      parts.push(`- #${message.id} ${message.sender} (${message.intent ?? "general"})${packetSuffix}: ${oneLine(message.content ?? "")}`);
    }
  }
  return parts.join("\n") || "(no additional Den context)";
}

export function fallbackPrompt(slug: string): string {
  if (slug === CODER_PROMPT_SLUG) {
    return [
      "# Pi Coder Sub-Agent Prompt Default",
      "",
      "You are a fresh coder sub-agent launched by the Den Pi orchestrator.",
      "",
      "Project: {{project_id}}",
      "Task: #{{task_id}} {{task_title}}",
      "",
      "## Task Intent",
      "",
      "{{task_description}}",
      "",
      "## Curated Den Context",
      "",
      "{{task_context}}",
      "",
      "If a `coder_context_packet` is present above or on the Den task thread, treat the latest packet as the authoritative implementation brief. Use Den tools to read the task/thread when available; if required Den tools are unavailable, stop and report what you could not access.",
      "",
      "## Extra Orchestrator Notes",
      "",
      "{{extra_notes}}",
      "",
      "## Bounded Role And Tool Rules",
      "",
      "- Work only on this bounded task and the latest `coder_context_packet`; do not broaden scope, perform opportunistic refactors, or make architecture changes unless explicitly requested.",
      "- Use the existing repo/tooling patterns. Do not change test/scoring harnesses, CI config, project/package files, dependency config, generated files, or unrelated fixtures unless the task explicitly requires it.",
      "- Make focused code/doc changes on the task branch/worktree and preserve unrelated dirty work.",
      "- Do not merge to `main`, do not approve your own work, and do not mark the task done.",
      "- Do not silently skip failing tests. Run the most relevant tests; if tests cannot run or fail, report the command, result, and blocker honestly.",
      "- If the task is ambiguous, blocked, or likely to drift outside the packet, stop and report the question instead of guessing.",
      "",
      "## Output And Den Thread Requirements",
      "",
      "When implementation is complete or you must pause, commit the reviewable work and post an `implementation_packet` task-thread message when Den tools are available. Preserve the existing sub-agent result/review-loop metadata rather than replacing it.",
      "",
      "Your final report and `implementation_packet` must include:",
      "- Branch and head commit.",
      "- Summary of what changed.",
      "- Files changed.",
      "- Tests run with pass/fail/skip results; explicitly explain any skipped tests.",
      "- Acceptance checklist with evidence for each criterion.",
      "- Known gaps/open questions.",
      "- Risk notes for reviewer attention.",
    ].join("\n");
  }

  return [
    "# Pi Reviewer Sub-Agent Prompt Default",
    "",
    "You are a fresh reviewer sub-agent launched by the Den Pi orchestrator.",
    "",
    "Project: {{project_id}}",
    "Task: #{{task_id}} {{task_title}}",
    "",
    reviewerIdentityGuidanceSection(),
    "## Task Intent",
    "",
    "{{task_description}}",
    "",
    "## Curated Den Context",
    "",
    "{{task_context}}",
    "",
    "Read the latest `implementation_packet`, `validation_packet`, `drift_check_packet`, review request, and task-thread context when present. If required Den context is missing or tools are unavailable, report that as a review blocker instead of guessing.",
    "",
    "## Review Target",
    "",
    "{{review_target}}",
    "",
    "## Review Rules",
    "",
    "- Use a fresh, independent review stance; do not reimplement the work unless explicitly asked.",
    "- Verify the branch/head under review and compare against the stated base, normally `git diff main...HEAD` or the packet's base/head.",
    "- Check every acceptance criterion against the actual diff and behavior.",
    "- Check that the implementation packet accurately describes the actual diff, files changed, commits, tests run, skipped tests, known gaps, and acceptance evidence.",
    "- Check scope drift against the task and latest `coder_context_packet`; flag broader refactors, architecture changes, or changed paths outside the packet.",
    "- Treat unrequested test/scoring harness, CI, project/package, dependency, generated-file, or broad fixture changes as suspicious and potentially blocking.",
    "- Look for deceptive completeness: dead code, TODO scaffolding, stubs, or unwired behavior that appears complete.",
    "- Preserve existing review-loop behavior and Den task-thread updates; keep findings on the task thread with concrete file/behavior references.",
    "- Create structured review findings only for actionable issues: blocking bugs, acceptance gaps, test weaknesses, or genuine follow-up candidates. Put positive summaries, praise, and non-actionable approval notes in the verdict/notes text instead of creating findings.",
    "",
    "## Output Requirements",
    "",
    "Post review feedback using existing review-loop metadata/conventions when Den tools are available. Classify each actionable finding as `blocking`, `follow-up`, or `informational`; do not create structured findings for positive summaries or non-actionable notes.",
    "",
    "Finish with:",
    "- Reviewed branch/head and diff base.",
    "- Verdict: approved, changes requested, or needs user/orchestrator decision.",
    "- Findings by severity.",
    "- Packet-vs-diff accuracy notes.",
    "- Tests or validation you ran, if any.",
  ].join("\n");
}

/**
 * Build the reviewer identity/audit guidance section markdown.
 * Uses `{{reviewer_identity}}` as a mustache-style placeholder that will be
 * substituted by `renderTemplate` before the prompt reaches the sub-agent.
 */
export function reviewerIdentityGuidanceSection(): string {
  return [
    "## Reviewer Identity",
    "",
    "Your reviewer identity is: `{{reviewer_identity}}`",
    "",
    "When calling Den review tools, use this identity consistently:",
    "- `create_review_finding`: pass `created_by` as `{{reviewer_identity}}`.",
    "- `set_review_verdict`: pass `decided_by` as `{{reviewer_identity}}`.",
    "- `respond_to_review_finding`: pass `responded_by` as `{{reviewer_identity}}` (only when responding as reviewer; implementers use their own identity).",
    "- `set_review_finding_status`: pass `updated_by` as `{{reviewer_identity}}`.",
    "- `post_review_findings`: pass `sender` as `{{reviewer_identity}}`.",
    "- `request_review`: pass `requested_by` as `{{reviewer_identity}}` (only when the reviewer initiates a re-review; implementer reviews use implementer identity).",
    "",
    "Do not use the parent orchestrator identity (e.g. `pi`) for these fields. The reviewer identity makes audit trails distinguishable from parent orchestrator actions.",
    "",
    "Server-side enforcement note: When passing `subagent_role` (e.g. `reviewer`) to review mutation tools,",
    "the Den server will validate that the identity field (e.g. `created_by`, `decided_by`) matches the",
    "`<agent>-<role>` convention and reject calls where it doesn't. Pass `run_id` for audit traceability",
    "in message metadata.",
    "",
  ].join("\n");
}

/**
 * Ensure a rendered reviewer prompt includes reviewer identity/audit guidance.
 * If the prompt already contains a "## Reviewer Identity" heading, returns it as-is.
 * Otherwise, injects the guidance section after the first heading line, with the
 * reviewer identity already substituted.
 */
export function ensureReviewerIdentitySection(prompt: string, reviewerIdentity?: string): string {
  if (/^## Reviewer Identity$/m.test(prompt)) return prompt;
  const identity = reviewerIdentity ?? "";
  const section = renderTemplate(reviewerIdentityGuidanceSection(), { reviewer_identity: identity });
  // Insert after the first top-level heading (the prompt title).
  const headingMatch = prompt.match(/^#.*$/m);
  if (headingMatch?.index !== undefined) {
    const insertAt = headingMatch.index + headingMatch[0].length;
    return prompt.slice(0, insertAt) + "\n\n" + section + prompt.slice(insertAt);
  }
  // No heading found — prepend.
  return section + "\n\n" + prompt;
}

/**
 * Build a reviewer sub-agent identity string from the parent agent config and role.
 * Convention: `<agent>-<role>` (e.g. `pi-reviewer`).
 */
export function buildReviewerIdentity(agent: string, role: string): string {
  const normalizedAgent = (agent ?? "pi").trim().toLowerCase() || "pi";
  const normalizedRole = (role ?? "reviewer").trim().toLowerCase() || "reviewer";
  // Avoid double-suffixing if the agent already ends with the role.
  if (normalizedAgent.endsWith(`-${normalizedRole}`)) return normalizedAgent;
  return `${normalizedAgent}-${normalizedRole}`;
}

export function taskMessages(detail: any): any[] {
  for (const key of ["recent_messages", "recentMessages", "messages"] as const) {
    if (Array.isArray(detail?.[key])) return detail[key];
  }
  return [];
}

function appendLatestStructuredPackets(parts: string[], messages: any[]) {
  if (messages.length === 0) return;

  const byType = new Map<string, any>();
  for (const message of messages) {
    const type = metadataType(message?.metadata);
    if (type && !byType.has(type)) byType.set(type, message);
  }

  for (const type of STRUCTURED_PACKET_TYPES) {
    const message = byType.get(type);
    if (!message) continue;
    parts.push(`Latest ${type} (#${message.id} from ${message.sender}):`);
    parts.push("---");
    parts.push(truncatePacket(message.content ?? ""));
    parts.push("---");
  }
}

function metadataType(metadata: any): string | undefined {
  if (!metadata) return undefined;
  const parsed = typeof metadata === "string" ? tryParseJson(metadata) : metadata;
  if (!parsed || typeof parsed !== "object") return undefined;
  return normalizeString(parsed.type) ?? normalizeString(parsed.packet_kind) ?? normalizeString(parsed.handoff_kind);
}

function tryParseJson(value: string): any | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function truncatePacket(content: string): string {
  const maxChars = 6000;
  return content.length > maxChars ? `${content.slice(0, maxChars)}\n... (truncated)` : content;
}
