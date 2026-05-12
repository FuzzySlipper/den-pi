/**
 * Implementation packet extraction, validation, and formatting.
 *
 * After a coder sub-agent run completes successfully, the final output is
 * parsed into a normalized `ImplementationPacket`.  The packet is posted to
 * the Den task thread so that later coders, reviewers, and the orchestrator can
 * consume structured implementation memory without re-parsing verbose
 * sub-agent result text.
 *
 * @module den-implementation-packet
 */

import { optionalNumber } from "./den-string-utils.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields that must be present for a packet to be considered "complete". */
export const REQUIRED_FIELDS = [
  "branch",
  "head_commit",
  "summary",
  "files_changed",
  "tests_run",
  "acceptance_checklist",
  "known_gaps",
  "risk_notes",
] as const;

export type RequiredField = (typeof REQUIRED_FIELDS)[number];

/**
 * A normalized implementation packet extracted from coder sub-agent output.
 *
 * Every field is optional because partial extraction is allowed — the
 * `completeness` property reports what is actually present.
 */
export interface ImplementationPacket {
  branch?: string;
  head_commit?: string;
  summary?: string;
  files_changed?: string[];
  tests_run?: string;
  acceptance_checklist?: string;
  known_gaps?: string;
  risk_notes?: string;
  artifact_links?: string[];
}

/** Metadata carried alongside the posted packet. */
export interface ImplementationPacketMeta {
  type: "implementation_packet";
  prepared_by: "coder_run";
  workflow: "expanded_isolation_with_context";
  version: 1;
  packet_completeness: "complete" | "partial";
  packet_missing_fields: RequiredField[];
  run_id: string;
  role: string;
  task_id: number | null;
  branch: string | null;
  /** The final observed HEAD commit (preferred). Falls back to requested head if final is unavailable. */
  head_commit: string | null;
  /** The starting/requested head commit from run context — distinct from final observed head. */
  requested_head_commit: string | null;
  purpose: string | null;
}

/** Metadata carried alongside a packet-missing notice. */
export interface PacketMissingNoticeMeta {
  type: "implementation_packet_missing";
  prepared_by: "coder_run";
  workflow: "expanded_isolation_with_context";
  version: 1;
  packet_completeness: "missing";
  packet_missing_fields: RequiredField[];
  run_id: string;
  role: string;
  task_id: number | null;
  branch: string | null;
  /** The final observed HEAD commit (preferred). Falls back to requested head if final is unavailable. */
  head_commit: string | null;
  /** The starting/requested head commit from run context. */
  requested_head_commit: string | null;
  purpose: string | null;
  incomplete_prompt_detected: true;
}

export type ImplementationPacketDuplicateCandidate = Pick<
  ImplementationPacketMeta,
  "run_id" | "task_id" | "branch" | "head_commit"
> & {
  final_branch?: string | null;
  final_head_commit?: string | null;
  requested_head_commit?: string | null;
};

/** Result of extracting and validating a packet. */
export interface ExtractionResult {
  packet: ImplementationPacket;
  missing_fields: RequiredField[];
  completeness: "complete" | "partial";
  /** True when the output appears to be an incomplete coder prompt without actual packet content. */
  incomplete_prompt_detected: boolean;
}

// ---------------------------------------------------------------------------
// Section heading patterns (forgiving markdown)
// ---------------------------------------------------------------------------

/**
 * Build a heading pattern that matches the start of a section.
 * Uses `[^\n]*` to consume only the rest of the heading line (not newlines).
 */
function headingPattern(base: string): RegExp {
  return new RegExp(`^#{1,6}\\s+${base}[^\\n]*`, "mi");
}

const SECTION_PATTERNS: Array<{
  field: RequiredField | "artifact_links";
  /** Heading patterns to match (case-insensitive). */
  headings: RegExp[];
  /** If true, collect lines as a list instead of a single block. */
  isList?: boolean;
}> = [
  {
    field: "branch",
    headings: [headingPattern("branch(?:\\s+and\\s+head\\s+commit)?")],
  },
  {
    field: "head_commit",
    headings: [headingPattern("head\\s+commit")],
  },
  {
    field: "summary",
    headings: [headingPattern("summary")],
  },
  {
    field: "files_changed",
    headings: [headingPattern("files\\s+changed")],
    isList: true,
  },
  {
    field: "tests_run",
    headings: [headingPattern("tests?\\s+run(?:\\s+with\\s+pass/fail/skip\\s+results?)?")],
  },
  {
    field: "acceptance_checklist",
    headings: [headingPattern("acceptance\\s+checklist")],
  },
  {
    field: "known_gaps",
    headings: [headingPattern("known\\s+gaps?(?:\\s*/\\s*open\\s+questions?)?")],
  },
  {
    field: "risk_notes",
    headings: [headingPattern("risk\\s+notes?(?:\\s+for\\s+reviewer)?")],
  },
  {
    field: "artifact_links",
    headings: [headingPattern("artifact\\s+links?")],
    isList: true,
  },
];

// ---------------------------------------------------------------------------
// Incomplete prompt detection
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate the coder output is an incomplete prompt/instruction
 * to post an implementation packet, rather than the actual packet content.
 *
 * This prevents posting misleading partial packets when the coder run ends with
 * text like "Now post the implementation packet to the Den task thread:" but
 * does not include the required packet fields.
 */
const INCOMPLETE_PROMPT_PATTERNS: RegExp[] = [
  /^\s*now\s+post\s+(?:the\s+)?implementation\s+packet\b/im,
  /^\s*post\s+(?:the\s+)?implementation\s+packet\b/im,
  /^\s*(?:let(?:'s|\s+me|\s+us)\s+)?(?:now\s+)?post\s+(?:the\s+)?(?:implementation\s+)?packet\b/im,
  /^\s*i(?:'ll|\s+will)\s+(?:now\s+)?post\s+(?:the\s+)?(?:implementation\s+)?packet\b/im,
  /^\s*(?:next|finally),?\s+(?:let(?:'s|\s+me)?\s+)?post\s+(?:the\s+)?(?:implementation\s+)?packet\b/im,
];

/**
 * Detect when a coder's final output appears to be an incomplete prompt
 * for posting an implementation packet rather than the actual packet content.
 *
 * ## Policy boundary (task #1097)
 *
 * Only prompt-like partial outputs are routed to `implementation_packet_missing`.
 * Non-prompt partial outputs (those with some structured section headings but
 * missing required fields) remain as partial `implementation_packet` messages
 * so that useful coder output (branch, summary, files changed) is preserved.
 *
 * Rationale:
 * - Non-prompt partials still contain useful diagnostic content.
 * - `packet_completeness: "partial"` + `packet_missing_fields` clearly
 *   communicate incompleteness to the orchestrator and reviewer.
 * - Routing ALL partials to `implementation_packet_missing` would discard
 *   useful structured coder output without a clear benefit.
 *
 * Returns true when the output starts with or primarily consists of an
 * instruction to post the packet, but lacks the structured section headings
 * that would indicate actual packet content.
 */
export function detectIncompleteCoderPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Check if the text matches known incomplete prompt patterns.
  // Note: patterns use multiline `m` flag so `^` matches any line start.
  // The heading-count guard below prevents false positives on real packets
  // that happen to contain the prompt phrase inside a section.
  const matchesPattern = INCOMPLETE_PROMPT_PATTERNS.some((p) => p.test(trimmed));
  if (!matchesPattern) return false;

  // Heading-count guard: if the text has at least 3 required section headings,
  // it's a real (possibly partial) packet — even if the prompt phrase appears
  // somewhere in the content. This prevents false positives on legitimate
  // coder output that mentions "post the implementation packet" in a section.
  //
  // Example: a Risk Notes section saying "Now post the implementation packet"
  // should NOT be flagged if the output also has Branch, Summary, and Files
  // Changed headings.
  const foundHeadings = REQUIRED_FIELDS.filter((field) => {
    const section = SECTION_PATTERNS.find((s) => s.field === field);
    if (!section) return false;
    return section.headings.some((h) => h.test(trimmed));
  });

  // If we found enough required headings, this is a real packet (complete or
  // partial) — route it as implementation_packet, not implementation_packet_missing.
  return foundHeadings.length < 3;
}

/**
 * Format a "packet missing" notice message for posting to the Den task thread
 * when the coder's final output does not contain a usable implementation packet.
 */
export function formatPacketMissingNoticeMessage(
  result: { run_id: string; role: string; task_id?: number; branch?: string; head_commit?: string; final_branch?: string; final_head_commit?: string; requested_head_commit?: string; purpose?: string; final_output?: string },
  extraction: ExtractionResult,
): string {
  const lines: string[] = [
    "# Implementation Packet Missing",
    "",
    "⚠️ **Coder sub-agent did not produce a complete implementation packet.**",
    "",
    "The coder run completed successfully but its final output does not contain the required implementation packet fields.",
    "",
  ];

  const branch = result.final_branch ?? result.branch ?? extraction.packet.branch;
  const headCommit = result.final_head_commit ?? result.head_commit ?? extraction.packet.head_commit;
  if (branch) {
    lines.push(`**Branch:** \`${branch}\``, "");
  }
  if (headCommit) {
    lines.push(`**Head commit:** \`${headCommit}\``, "");
  }

  lines.push(
    `**Missing fields:** ${extraction.missing_fields.join(", ")}`,
    "",
    "## Coder final output (truncated)",
    "",
    "```",
    (result.final_output ?? "").slice(0, 500),
    "```",
    "",
    "## Next steps",
    "",
    "The orchestrator should either:",
    "1. Manually post a complete implementation packet for this run, or",
    "2. Trigger a rerun or fix the coder output.",
  );

  return lines.join("\n");
}

/**
 * Build metadata for a packet-missing notice.
 */
export function buildPacketMissingNoticeMeta(
  result: { run_id: string; role: string; task_id?: number; branch?: string; head_commit?: string; final_branch?: string; final_head_commit?: string; requested_head_commit?: string; purpose?: string },
  extraction: ExtractionResult,
): PacketMissingNoticeMeta {
  return {
    type: "implementation_packet_missing",
    prepared_by: "coder_run",
    workflow: "expanded_isolation_with_context",
    version: 1,
    packet_completeness: "missing",
    packet_missing_fields: extraction.missing_fields,
    run_id: result.run_id,
    role: result.role,
    task_id: result.task_id ?? null,
    branch: extraction.packet.branch ?? result.final_branch ?? result.branch ?? null,
    head_commit: extraction.packet.head_commit ?? result.final_head_commit ?? result.head_commit ?? null,
    requested_head_commit: result.requested_head_commit ?? result.head_commit ?? null,
    purpose: result.purpose ?? null,
    incomplete_prompt_detected: true,
  };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract a normalized implementation packet from coder sub-agent final output.
 *
 * Uses forgiving markdown heading conventions — headings at levels 1–4 are
 * matched case-insensitively.  Returns an `ExtractionResult` even when the
 * output is malformed so the caller can decide whether to post a partial
 * packet with a drift signal.
 */
export function extractImplementationPacket(text: string): ExtractionResult {
  const packet: ImplementationPacket = {};

  for (const pattern of SECTION_PATTERNS) {
    const content = extractSection(text, pattern.headings);
    if (content === undefined) continue;

    if (pattern.isList) {
      const items = parseListItems(content);
      (packet as any)[pattern.field] = items.length > 0 ? items : content.trim();
    } else if (pattern.field === "branch") {
      // Store raw content; will be post-processed below.
      (packet as any)["_raw_branch"] = content;
    } else if (pattern.field === "head_commit") {
      (packet as any)[pattern.field] = parseCodeOrValue(content);
    } else {
      (packet as any)[pattern.field] = content.trim();
    }
  }

  // Post-process branch: may be a combined "Branch and Head Commit" section.
  const rawBranch = (packet as any)["_raw_branch"];
  if (rawBranch) {
    delete (packet as any)["_raw_branch"];
    if (rawBranch.includes('\n') || /commit:/i.test(rawBranch)) {
      // Combined section — extract both branch and head_commit.
      const branchMatch = rawBranch.match(/branch:\s*`?([^`\n]+)`?/i);
      if (branchMatch) packet.branch = branchMatch[1].trim();
      else packet.branch = parseCodeOrValue(rawBranch.split('\n')[0]);

      if (!packet.head_commit) {
        const commitMatch = rawBranch.match(/commit:\s*`?([0-9a-f]{7,40})`?/i)
          ?? rawBranch.match(/head\s+commit:\s*`?([0-9a-f]{7,40})`?/i)
          ?? rawBranch.match(/\b([0-9a-f]{7,40})\b/);
        if (commitMatch) packet.head_commit = commitMatch[1].trim();
      }
    } else {
      packet.branch = parseCodeOrValue(rawBranch);
    }
  }

  // Try to pull branch/commit from a combined "Branch and head commit" heading.
  if (packet.branch === undefined && packet.head_commit === undefined) {
    const combinedPattern = headingPattern("branch\\s+and\\s+head\\s+commit");
    const combined = extractSection(text, [combinedPattern]);
    if (combined) {
      const branchMatch = combined.match(/branch:\s*`?([^`\n]+)`?/i)
        ?? combined.match(/branch:\s*(\S+)/i)
        ?? combined.match(/`([^`]+)`\s*$/m);
      const commitMatch = combined.match(/commit:\s*`?([0-9a-f]{7,40})`?/i)
        ?? combined.match(/head\s+commit:\s*`?([0-9a-f]{7,40})`?/i)
        ?? combined.match(/\b([0-9a-f]{7,40})\b/);

      if (branchMatch) packet.branch = branchMatch[1].trim();
      if (commitMatch) packet.head_commit = commitMatch[1].trim();
    }
  }

  // Also try to extract branch/commit from inline patterns in the text.
  if (!packet.branch) {
    const m = text.match(/\bbranch:\s*`([^`]+)`/i) ?? text.match(/\bon\s+branch\s+`([^`]+)`/i);
    if (m) packet.branch = m[1].trim();
  }
  if (!packet.head_commit) {
    const m = text.match(/\bhead\s+commit:\s*`?([0-9a-f]{7,40})`?/i)
      ?? text.match(/\bcommit\s+`([0-9a-f]{7,40})`/i);
    if (m) packet.head_commit = m[1].trim();
  }

  // Last-resort heading-line extraction for compact packets such as
  // `## Branch: task/foo` where extractSection consumes the whole heading line.
  if (!packet.branch) {
    const branch = extractHeadingLineValue(text, "branch");
    if (branch && isSafeBranchValue(branch)) packet.branch = branch;
  }
  if (!packet.head_commit) {
    const commit = extractHeadingLineValue(text, "(?:head\\s+commit|commit)");
    if (commit && isSafeCommitValue(commit)) packet.head_commit = commit;
  }

  const result = validatePacket(packet);

  // Detect incomplete coder prompts that should not be posted as real packets.
  // When the output is just an instruction like "Now post the implementation
  // packet to the Den task thread:" without actual structured content, we
  // flag it so callers can post a packet_missing notice instead.
  result.incomplete_prompt_detected = detectIncompleteCoderPrompt(text);

  return result;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate an implementation packet, returning the missing required fields
 * and a completeness indicator.
 */
export function validatePacket(packet: ImplementationPacket): ExtractionResult {
  const missing_fields = REQUIRED_FIELDS.filter(
    (field) => {
      const value = (packet as any)[field];
      if (value === undefined || value === null) return true;
      if (typeof value === "string" && value.trim() === "") return true;
      if (Array.isArray(value) && value.length === 0) return true;
      return false;
    },
  );

  return {
    packet,
    missing_fields,
    completeness: missing_fields.length === 0 ? "complete" : "partial",
    incomplete_prompt_detected: false,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format an implementation packet as a markdown message body for posting to
 * the Den task thread.
 */
export function formatImplementationPacketMessage(
  result: { run_id: string; role: string; task_id?: number; branch?: string; head_commit?: string; purpose?: string; final_output?: string },
  extraction: ExtractionResult,
): string {
  const { packet, completeness, missing_fields } = extraction;
  const lines: string[] = [
    "# Implementation Packet",
    "",
    `**Completeness:** ${completeness}${missing_fields.length > 0 ? ` — missing: ${missing_fields.join(", ")}` : ""}`,
    "",
  ];

  if (packet.branch) {
    lines.push("## Branch", "", `\`${packet.branch}\``, "");
  }
  if (packet.head_commit) {
    lines.push("## Head Commit", "", `\`${packet.head_commit}\``, "");
  }
  if (packet.summary) {
    lines.push("## Summary", "", packet.summary, "");
  }
  if (packet.files_changed) {
    const items = Array.isArray(packet.files_changed) ? packet.files_changed : [packet.files_changed];
    lines.push("## Files Changed", "", ...items.map((f) => `- ${f}`), "");
  }
  if (packet.tests_run) {
    lines.push("## Tests Run", "", packet.tests_run, "");
  }
  if (packet.acceptance_checklist) {
    lines.push("## Acceptance Checklist", "", packet.acceptance_checklist, "");
  }
  if (packet.known_gaps) {
    lines.push("## Known Gaps", "", packet.known_gaps, "");
  }
  if (packet.risk_notes) {
    lines.push("## Risk Notes", "", packet.risk_notes, "");
  }
  if (packet.artifact_links && (Array.isArray(packet.artifact_links) ? packet.artifact_links.length > 0 : packet.artifact_links)) {
    const items = Array.isArray(packet.artifact_links) ? packet.artifact_links : [packet.artifact_links];
    lines.push("## Artifact Links", "", ...items.map((l) => `- ${l}`), "");
  }

  // If partial, append a clear warning for the orchestrator.
  if (completeness === "partial") {
    lines.push("---", "", `⚠️ **Implementation packet is incomplete.** Missing fields: ${missing_fields.join(", ")}.`, "");
  }

  return lines.join("\n");
}

/**
 * Build the stable metadata object for a posted implementation packet.
 */
export function buildImplementationPacketMeta(
  result: { run_id: string; role: string; task_id?: number; branch?: string; head_commit?: string; final_head_commit?: string; requested_head_commit?: string; purpose?: string },
  extraction: ExtractionResult,
): ImplementationPacketMeta {
  return {
    type: "implementation_packet",
    prepared_by: "coder_run",
    workflow: "expanded_isolation_with_context",
    version: 1,
    packet_completeness: extraction.completeness,
    packet_missing_fields: extraction.missing_fields,
    run_id: result.run_id,
    role: result.role,
    task_id: result.task_id ?? null,
    branch: extraction.packet.branch ?? result.branch ?? null,
    head_commit: extraction.packet.head_commit ?? result.final_head_commit ?? result.head_commit ?? null,
    requested_head_commit: result.requested_head_commit ?? result.head_commit ?? null,
    purpose: result.purpose ?? null,
  };
}

/**
 * Find an existing task-thread implementation packet that would duplicate the
 * auto-posted packet for a completed coder run. Prefer an exact run-id match;
 * otherwise match the same task/head/branch so manually posted coder packets
 * can remain the latest durable implementation packet.
 */
export function findDuplicateImplementationPacketMessage<T extends { metadata?: unknown; task_id?: number | null }>(
  messages: T[],
  candidate: ImplementationPacketDuplicateCandidate,
): T | undefined {
  const candidates = messages
    .filter((message) => {
      const meta = metadataObject(message.metadata);
      if (meta.type !== "implementation_packet") return false;
      const messageTaskId = optionalNumber((message as any).task_id) ?? optionalNumber(meta.task_id);
      if (candidate.task_id !== null && candidate.task_id !== undefined && messageTaskId !== candidate.task_id) return false;
      return true;
    })
    .sort((a, b) => (optionalNumber((b as any).id) ?? 0) - (optionalNumber((a as any).id) ?? 0));

  if (candidate.run_id) {
    const sameRun = candidates.find((message) => metadataObject(message.metadata).run_id === candidate.run_id);
    if (sameRun) return sameRun;
  }

  const candidateHead = candidate.final_head_commit ?? candidate.head_commit;
  const candidateBranch = candidate.final_branch ?? candidate.branch;
  if (!candidateHead) return undefined;
  return candidates.find((message) => {
    const meta = metadataObject(message.metadata);
    const messageHead = meta.final_head_commit ?? meta.head_commit;
    const messageBranch = meta.final_branch ?? meta.branch;
    if (messageHead !== candidateHead) return false;
    if (candidateBranch && messageBranch && messageBranch !== candidateBranch) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find a section by matching one of several heading regexps, then return the
 * content between that heading and the next heading (or end of text).
 */
function metadataObject(value: unknown): Record<string, any> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed as Record<string, any> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function extractSection(text: string, headingPatterns: RegExp[]): string | undefined {
  for (const pattern of headingPatterns) {
    const match = pattern.exec(text);
    if (!match) continue;

    // Advance past the matched heading and the rest of its line.
    let startIdx = match.index + match[0].length;
    const afterMatch = text.slice(startIdx);
    const lineEnd = afterMatch.indexOf('\n');
    if (lineEnd >= 0) {
      // Skip any trailing text on the heading line (e.g. "of what changed").
      startIdx += lineEnd + 1;
    } else {
      startIdx = text.length;
    }

    // Next heading: any line starting with 1-6 hash chars.
    const remaining = text.slice(startIdx);
    const nextHeading = remaining.match(/\n#{1,6}\s/m);
    const sectionContent = nextHeading
      ? remaining.slice(0, nextHeading.index)
      : remaining;
    const trimmed = sectionContent.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/**
 * Parse bullet-point list items from a block of text.
 * Returns the individual items (without leading `- ` or `* ` markers).
 */
function parseListItems(text: string): string[] {
  const lines = text.split("\n");
  const items: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      items.push(bulletMatch[1].trim());
    } else if (trimmed.length > 0) {
      // Non-bullet line — include as-is.
      items.push(trimmed);
    }
  }
  return items;
}

/**
 * Parse a value that may be wrapped in backticks or prefixed with a label.
 * Returns the clean value without backticks.
 */
function parseCodeOrValue(text: string): string {
  const trimmed = text.trim();
  // Try to match backtick-wrapped value.
  const codeMatch = trimmed.match(/`([^`]+)`/);
  if (codeMatch) return codeMatch[1].trim();
  // Try label: value pattern.
  const labelMatch = trimmed.match(/:\s*(.+)/);
  if (labelMatch) return labelMatch[1].trim().replace(/`/g, "");
  return trimmed;
}

function extractHeadingLineValue(text: string, labelPattern: string): string | undefined {
  const pattern = new RegExp(`^#{1,6}\\s+${labelPattern}\\s*:\\s*(?:\\\`([^\\\`\\n]+)\\\`|([^\\s\\n]+))\\s*$`, "im");
  const match = pattern.exec(text);
  return (match?.[1] ?? match?.[2])?.trim();
}

function isSafeBranchValue(value: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(value) && !/^(?:none|not|unknown|n\/a)$/i.test(value);
}

function isSafeCommitValue(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}
