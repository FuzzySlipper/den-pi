/**
 * Coder context packet preparation, formatting, and metadata.
 *
 * A coder context packet is a curated, bounded summary that an orchestrator
 * prepares before delegating work to a coder sub-agent.  It replaces
 * stuffing the orchestrator's live context with raw task history by producing
 * a stable, link-rich markdown document posted to the Den task thread.
 *
 * The packet is consumed by coders via `summarizeTaskContext` /
 * `appendLatestStructuredPackets` in `den-prompt-templates.ts`.
 *
 * @module den-coder-context-packet
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structured input for building a coder context packet. */
export interface CoderContextPacketInput {
  /** Den task ID this packet is for. */
  task_id: number;
  /** Parent task ID, if any. */
  parent_task_id?: number;
  /** Task title. */
  task_title?: string;
  /** Task description (used as-is or truncated). */
  task_description?: string;
  /** Task status. */
  task_status?: string;
  /** Task tags. */
  task_tags?: string[];

  /** Branch the coder should work on. */
  branch?: string;
  /** Worktree path for isolated checkout. */
  worktree_path?: string;
  /** Base commit the branch was created from. */
  base_commit?: string;
  /** Effective coder model resolved from Den config. */
  effective_coder_model?: string;
  /** Effective config source path (e.g. inherited .pi/den-config.json). */
  config_source?: string;

  /** User intent / freeform description of what the orchestrator wants. */
  user_intent?: string;

  /** Acceptance criteria from the task. */
  acceptance_criteria?: string;

  /** Dependency summaries — array of `{ task_id, title, status, summary }`. */
  dependency_summaries?: DependencySummary[];

  /** Relevant Den doc references — array of `{ ref, description? }`. */
  relevant_docs?: DocRef[];

  /** Recent structured packet summaries — array of `{ type, message_id, summary }`. */
  recent_packets?: PacketSummary[];

  /** Known constraints or scope boundaries. */
  constraints?: string;

  /** Suggested file pointers for the coder. */
  file_pointers?: FilePointer[];

  /** Validation commands the coder should run. */
  validation_commands?: string[];

  /** Extra orchestrator notes. */
  extra_notes?: string;

  /**
   * Override the "Packet conventions" section body.
   * Defaults to a policy-compliant description of metadata packet types
   * the coder should produce and read.
   */
  packet_conventions?: string;

  /**
   * Override the "Expected output" section body.
   * Defaults to a policy-compliant description of what the coder's
   * final report / implementation_packet should contain.
   */
  expected_output?: string;
}

export interface DependencySummary {
  task_id: number;
  title?: string;
  status?: string;
  summary?: string;
}

export interface DocRef {
  ref: string;
  description?: string;
}

export interface PacketSummary {
  type: string;
  message_id?: number;
  summary: string;
}

export interface FilePointer {
  path: string;
  description?: string;
}

/** Metadata for a posted coder context packet. */
export interface CoderContextPacketMeta {
  type: "coder_context_packet";
  prepared_by: "orchestrator";
  workflow: "expanded_isolation_with_context";
  version: 1;
  parent_task_id: number | null;
  branch: string | null;
  worktree_path: string | null;
  base_commit: string | null;
  effective_coder_model: string | null;
  config_source: string | null;
}

import { access, constants } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum length for any single free-text field before truncation. */
const MAX_FIELD_CHARS = 8000;

/** Maximum number of dependency summaries to include inline. */
const MAX_DEPENDENCIES = 10;

/** Maximum number of recent packet summaries to include. */
const MAX_RECENT_PACKETS = 5;

/** Maximum number of file pointers to include. */
const MAX_FILE_POINTERS = 15;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a coder context packet as a markdown message body.
 *
 * The output is designed to be read by a coder sub-agent and to link to
 * source records in Den rather than dumping raw histories.
 */
export function formatCoderContextPacket(input: CoderContextPacketInput): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Coder Context Packet — task ${input.task_id}`, "");

  // Task identity
  lines.push("## Task", "");
  lines.push(`- Task: \`#${input.task_id}${input.task_title ? ` ${input.task_title}` : ""}\``);
  if (input.parent_task_id) lines.push(`- Parent: \`#${input.parent_task_id}\``);
  if (input.task_status) lines.push(`- Status: \`${input.task_status}\``);
  if (input.task_tags && input.task_tags.length > 0) lines.push(`- Tags: ${input.task_tags.map(t => `\`${t}\``).join(", ")}`);
  if (input.branch) lines.push(`- Branch: \`${input.branch}\``);
  if (input.worktree_path) lines.push(`- Worktree: \`${input.worktree_path}\``);
  if (input.base_commit) lines.push(`- Base commit: \`${input.base_commit}\``);
  if (input.effective_coder_model || input.config_source) {
    lines.push("- Effective coder model/config:" +
      (input.effective_coder_model ? ` resolves to \`${input.effective_coder_model}\`` : "") +
      (input.config_source ? ` from \`${input.config_source}\`` : "") + ".");
  }
  lines.push("");

  // Task description
  if (input.task_description) {
    lines.push("## Task description", "");
    lines.push(boundedText(input.task_description), "");
  }

  // User intent
  if (input.user_intent) {
    lines.push("## User intent", "");
    lines.push(boundedText(input.user_intent), "");
  }

  // Acceptance criteria
  if (input.acceptance_criteria) {
    lines.push("## Acceptance criteria", "");
    lines.push(boundedText(input.acceptance_criteria), "");
  }

  // Dependency summaries
  if (input.dependency_summaries && input.dependency_summaries.length > 0) {
    lines.push("## Dependency summaries", "");
    const deps = input.dependency_summaries.slice(0, MAX_DEPENDENCIES);
    for (const dep of deps) {
      const status = dep.status ? ` [${dep.status}]` : "";
      const title = dep.title ? ` ${dep.title}` : "";
      const summary = dep.summary ? `: ${oneLine(dep.summary)}` : "";
      lines.push(`- \`#${dep.task_id}\`${title}${status}${summary}`);
    }
    if (input.dependency_summaries.length > MAX_DEPENDENCIES) {
      lines.push(`- ... and ${input.dependency_summaries.length - MAX_DEPENDENCIES} more (see task dependencies in Den)`);
    }
    lines.push("");
  }

  // Relevant docs
  if (input.relevant_docs && input.relevant_docs.length > 0) {
    lines.push("## Relevant docs", "");
    for (const doc of input.relevant_docs) {
      const desc = doc.description ? ` — ${oneLine(doc.description)}` : "";
      lines.push(`- \`${doc.ref}\`${desc}`);
    }
    lines.push("");
  }

  // Recent packets
  if (input.recent_packets && input.recent_packets.length > 0) {
    lines.push("## Recent implementation packets", "");
    const packets = input.recent_packets.slice(0, MAX_RECENT_PACKETS);
    for (const pkt of packets) {
      const id = pkt.message_id ? `#${pkt.message_id}` : "(unknown)";
      lines.push(`- ${pkt.type} ${id}: ${oneLine(pkt.summary)}`);
    }
    if (input.recent_packets.length > MAX_RECENT_PACKETS) {
      lines.push(`- ... and ${input.recent_packets.length - MAX_RECENT_PACKETS} more (see task thread in Den)`);
    }
    lines.push("");
  }

  // Constraints / scope boundaries
  if (input.constraints) {
    lines.push("## Constraints / scope boundaries", "");
    lines.push(boundedText(input.constraints), "");
  }

  // File pointers
  if (input.file_pointers && input.file_pointers.length > 0) {
    lines.push("## Suggested file pointers", "");
    const pointers = input.file_pointers.slice(0, MAX_FILE_POINTERS);
    for (const fp of pointers) {
      const desc = fp.description ? ` — ${oneLine(fp.description)}` : "";
      lines.push(`- \`${fp.path}\`${desc}`);
    }
    if (input.file_pointers.length > MAX_FILE_POINTERS) {
      lines.push(`- ... and ${input.file_pointers.length - MAX_FILE_POINTERS} more`);
    }
    lines.push("");
  }

  // Validation commands
  if (input.validation_commands && input.validation_commands.length > 0) {
    lines.push("## Validation commands", "");
    for (const cmd of input.validation_commands) {
      lines.push(`- \`${cmd}\``);
    }
    lines.push("");
  }

  // Extra notes
  if (input.extra_notes) {
    lines.push("## Extra orchestrator notes", "");
    lines.push(boundedText(input.extra_notes), "");
  }

  // Packet conventions
  lines.push("## Packet conventions", "");
  lines.push(boundedText(
    input.packet_conventions ?? defaultPacketConventions(),
  ), "");

  // Expected output
  lines.push("## Expected output", "");
  lines.push(boundedText(
    input.expected_output ?? defaultExpectedOutput(),
  ), "");

  return lines.join("\n");
}

/**
 * Build the stable metadata object for a posted coder context packet.
 */
export function buildCoderContextPacketMeta(input: CoderContextPacketInput): CoderContextPacketMeta {
  return {
    type: "coder_context_packet",
    prepared_by: "orchestrator",
    workflow: "expanded_isolation_with_context",
    version: 1,
    parent_task_id: input.parent_task_id ?? null,
    branch: input.branch ?? null,
    worktree_path: input.worktree_path ?? null,
    base_commit: input.base_commit ?? null,
    effective_coder_model: input.effective_coder_model ?? null,
    config_source: input.config_source ?? null,
  };
}

// ---------------------------------------------------------------------------
// Helpers for building packets from Den task data
// ---------------------------------------------------------------------------

/**
 * Extract dependency summaries from a Den task detail response.
 *
 * Summarizes rather than dumping — returns at most `max` entries.
 */
export function summarizeDependencies(
  detail: { dependencies?: any[] },
  max: number = MAX_DEPENDENCIES,
): DependencySummary[] {
  const deps = Array.isArray(detail.dependencies) ? detail.dependencies : [];
  return deps.slice(0, max).map((dep: any) => ({
    task_id: dep.task_id ?? dep.id ?? dep.taskId ?? 0,
    title: trimString(dep.title),
    status: trimString(dep.status),
    summary: trimString(dep.summary),
  }));
}

/**
 * Extract recent structured packet summaries from Den task messages.
 *
 * Filters to known structured packet types and summarizes each in one line.
 */
export function summarizeRecentPackets(
  messages: any[],
  max: number = MAX_RECENT_PACKETS,
): PacketSummary[] {
  if (!Array.isArray(messages)) return [];
  const structuredTypes = new Set([
    "coder_context_packet",
    "implementation_packet",
    "validation_packet",
    "drift_check_packet",
    "review_request",
    "review_feedback",
  ]);

  const packets: PacketSummary[] = [];
  for (const msg of messages) {
    if (packets.length >= max) break;
    const meta = typeof msg?.metadata === "string" ? tryParseJson(msg.metadata) : msg?.metadata;
    const type = meta?.type;
    if (!type || !structuredTypes.has(type)) continue;
    packets.push({
      type,
      message_id: typeof msg.id === "number" ? msg.id : undefined,
      summary: oneLine(msg.content ?? ""),
    });
  }
  return packets;
}

/**
 * Resolve the effective coder model and config source from the Den extension
 * config for a given worktree/cwd.
 *
 * Config source reporting is accurate about which project config file is
 * actually used: local takes priority over inherited; if no project config
 * exists the source is undefined (model comes from global config or defaults).
 */
export async function resolveEffectiveCoderConfig(
  cwd: string,
  configModule: {
    loadMergedDenExtensionConfig: (cwd: string) => Promise<any>;
    denConfigPaths: (cwd: string) => Promise<string[]>;
  },
  fileReadableFn?: (filePath: string) => Promise<boolean>,
): Promise<{ effective_coder_model?: string; config_source?: string }> {
  const checkReadable = fileReadableFn ?? defaultFileReadable;
  try {
    const config = await configModule.loadMergedDenExtensionConfig(cwd);
    const paths = await configModule.denConfigPaths(cwd);
    const model = config?.subagents?.coder?.model ?? config?.fallback_model;

    // Check which candidate project config paths actually exist.
    const localPath = paths[0];
    const inheritedPath = paths.length > 1 ? paths[1] : undefined;

    const localExists = localPath ? await checkReadable(localPath) : false;
    const inheritedExists = inheritedPath ? await checkReadable(inheritedPath) : false;

    // Report source accurately: local wins over inherited; if neither project
    // config exists, the model comes from global config or defaults only.
    let sourcePath: string | undefined;
    if (localExists) {
      sourcePath = localPath;
    } else if (inheritedExists) {
      sourcePath = `inherited:${inheritedPath}`;
    }

    return {
      effective_coder_model: model || undefined,
      config_source: sourcePath,
    };
  } catch {
    return {};
  }
}

/**
 * Default file-readability check using `fs.access`.
 * Overridable in tests via the `fileReadableFn` parameter.
 */
async function defaultFileReadable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Default section bodies
// ---------------------------------------------------------------------------

/**
 * Default "Packet conventions" body — describes which metadata packet types
 * the coder should produce and read.
 */
export function defaultPacketConventions(): string {
  return [
    "Use the following Den message metadata types when reporting back:",
    "",
    "- `coder_context_packet` — read this at the start (the current packet).",
    "- `implementation_packet` — post when done with `{ type: 'implementation_packet', prepared_by: 'coder_run', version: 1, branch, head_commit, ... }`.",
    "- `validation_packet` — post after running validation commands with pass/fail results.",
    "- `drift_check_packet` — read if present; may flag issues requiring a fix before review.",
    "- Review packets (`review_request`, `review_feedback`, `review_findings_packet`) — read and address findings as directed.",
  ].join("\n");
}

/**
 * Default "Expected output" body — describes what the coder's final report /
 * implementation_packet should contain.
 */
export function defaultExpectedOutput(): string {
  return [
    "Your `implementation_packet` and final report must include:",
    "",
    "- **Branch and head commit** — the branch you worked on and the final SHA.",
    "- **Summary of what changed** — concise description of changes made.",
    "- **Files changed** — list of files modified, added, or deleted.",
    "- **Tests run** — commands executed with pass/fail/skip counts; explain any skips.",
    "- **Acceptance checklist** — evidence for each criterion from the packet.",
    "- **Known gaps / open questions** — anything you could not complete or verify.",
    "- **Risk notes** — anything the reviewer should watch closely.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function boundedText(text: string): string {
  if (text.length <= MAX_FIELD_CHARS) return text;
  return `${text.slice(0, MAX_FIELD_CHARS)}\n... (truncated at ${MAX_FIELD_CHARS} chars)`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 200);
}

function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function tryParseJson(value: string): any | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
