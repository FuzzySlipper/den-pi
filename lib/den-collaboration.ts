import type { DenConfig } from "./den-subagent-runner.ts";

// ---------------------------------------------------------------------------
// Collaboration API helper module for Pi extension tools/commands
// ---------------------------------------------------------------------------

export type CollabAnnotationType = "note" | "skip" | "done" | "flag";
export type CollabSessionStatus = "active" | "resolved" | "archived";
export type CollabSegmentType = "heading" | "paragraph" | "code_block" | "list" | "block_quote";

export interface CollabSourceContext {
  taskId?: number;
  threadId?: number;
  piSessionId?: string;
  piSessionFile?: string;
  piRunId?: string;
  model?: string;
  [key: string]: unknown;
}

export interface TurnInput {
  raw_markdown: string;
  role?: string;
  source_kind?: string;
  source_ref?: string;
  source_label?: string;
  source_uri?: string;
  source_context?: CollabSourceContext;
}

export interface SessionInput {
  project_id: string;
  task_id?: number;
  message_id?: number;
  agent_stream_entry_id?: number;
  pi_run_id?: string;
  pi_session_id?: string;
  desktop_operator_session_id?: string;
  title?: string;
  created_by?: string;
  initial_turn: TurnInput;
}

export interface AnnotationInput {
  segment_id: number;
  annotation_type: CollabAnnotationType;
  body?: string;
  created_by?: string;
}

export interface DraftInput {
  turn_id?: number;
  content: string;
  created_by?: string;
}

export interface StatusUpdateInput {
  expected_status: CollabSessionStatus;
  status: CollabSessionStatus;
}

// ---------------------------------------------------------------------------
// Response compilation (local mirror of CollaborationResponseCompiler)
// ---------------------------------------------------------------------------

/**
 * Compile segments and annotations into a structured response text.
 * Mirrors the server-side CollaborationResponseCompiler.Compile() output format
 * so Pi extensions can produce a response draft without a server round-trip.
 *
 * @param segments - Array of segment objects from a session turn.
 * @param annotations - Array of annotation objects from the session.
 * @returns Compiled response text.
 */
export function compileResponse(
  segments: Array<{
    id: number;
    sequence_number: number;
    segment_hash: string;
    segment_type: CollabSegmentType;
    segmentType?: CollabSegmentType;
    raw_markdown: string;
    text?: string;
    heading_level?: number;
    code_language?: string;
  }>,
  annotations: Array<{
    id: number;
    segment_id: number;
    session_id?: number;
    turn_id?: number;
    segment_hash: string;
    annotation_type: CollabAnnotationType;
    annotationType?: CollabAnnotationType;
    body?: string;
    created_by?: string;
    updated_by?: string;
  }>,
): string {
  // Normalize snake_case / camelCase fields
  const normalizedSegments = segments.map(normalizeSegment);
  const normalizedAnnotations = annotations.map(normalizeAnnotation);

  // Build annotation lookup by segment_id
  const annotationsBySegment = new Map<number, typeof normalizedAnnotations>();
  for (const ann of normalizedAnnotations) {
    const bySegment = annotationsBySegment.get(ann.segment_id) ?? [];
    bySegment.push(ann);
    annotationsBySegment.set(ann.segment_id, bySegment);
  }

  const lines: string[] = [];
  let anyAnnotated = false;
  const annotatedSegmentIds = new Set<number>();

  for (const segment of normalizedSegments) {
    const segAnnotations = annotationsBySegment.get(segment.id);
    if (!segAnnotations || segAnnotations.length === 0) continue;

    anyAnnotated = true;
    annotatedSegmentIds.add(segment.id);

    const snippet = buildSnippet(segment);
    const reference = buildSegmentReference(segment);

    lines.push(`> ${reference} ${snippet}`);
    for (const ann of segAnnotations) {
      lines.push(formatAnnotationLine(ann));
    }
    lines.push("");
  }

  const unannotatedCount = normalizedSegments.filter((s) => !annotatedSegmentIds.has(s.id)).length;

  if (!anyAnnotated) {
    lines.push("[no annotations — acknowledged in full, proceed]");
  } else if (unannotatedCount > 0) {
    lines.push("---");
    lines.push(
      `[${unannotatedCount} section(s) not annotated — treat as acknowledged, proceed with flagged items]`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeSegment(s: any) {
  return {
    id: s.id,
    sequence_number: s.sequence_number ?? s.sequenceNumber ?? 0,
    segment_hash: s.segment_hash ?? s.segmentHash ?? "",
    segment_type: s.segment_type ?? s.segmentType ?? "paragraph",
    raw_markdown: s.raw_markdown ?? s.rawMarkdown ?? "",
    text: s.text,
    heading_level: s.heading_level ?? s.headingLevel,
    code_language: s.code_language ?? s.codeLanguage,
  };
}

function normalizeAnnotation(a: any) {
  return {
    id: a.id,
    segment_id: a.segment_id ?? a.segmentId ?? 0,
    segment_hash: a.segment_hash ?? a.segmentHash ?? "",
    annotation_type: a.annotation_type ?? a.annotationType ?? "note",
    body: a.body,
    created_by: a.created_by ?? a.createdBy,
    updated_by: a.updated_by ?? a.updatedBy,
  };
}

function buildSnippet(segment: ReturnType<typeof normalizeSegment>): string {
  if (segment.segment_type === "code_block") {
    const text = segment.text ?? segment.raw_markdown;
    const firstLine = text.split("\n")[0];
    const truncated = firstLine.length > 50 ? firstLine.slice(0, 50) + "..." : firstLine;
    return `[code block: ${truncated}]`;
  }
  const rawText = segment.text ?? segment.raw_markdown;
  const snippet = rawText.length > 80 ? rawText.slice(0, 80) + "..." : rawText;
  return snippet;
}

function buildSegmentReference(segment: ReturnType<typeof normalizeSegment>): string {
  const hash = segment.segment_hash;
  const hashPrefix = hash.length >= 8 ? hash.slice(0, 8) : hash;
  return `[segment ${segment.sequence_number} · ${hashPrefix}]`;
}

function formatAnnotationLine(annotation: ReturnType<typeof normalizeAnnotation>): string {
  const annType = annotation.annotation_type;

  switch (annType) {
    case "skip":
      return "  [skip — no response needed]";
    case "flag": {
      const body = annotation.body?.trim();
      return `  [FLAG]${body ? `: ${body}` : ": needs discussion"}`;
    }
    case "note": {
      const body = annotation.body?.trim();
      return body ? `  [note]: ${body}` : "  [note]: acknowledged";
    }
    case "done": {
      const body = annotation.body?.trim();
      return body ? `  [done]: ${body}` : "  [done — already handled]";
    }
    default:
      return `  [${annType}]`;
  }
}

// ---------------------------------------------------------------------------
// Session presentation formatting
// ---------------------------------------------------------------------------

/**
 * Format a collaboration session summary for TUI display.
 */
export function formatSessionSummary(session: any, indent = ""): string[] {
  const lines: string[] = [];
  lines.push(
    `${indent}Session #${session.id}${session.title ? `: ${session.title}` : ""} [${session.status ?? session.Status}]`,
  );
  if (session.task_id ?? session.taskId) lines.push(`${indent}  Task #${session.task_id ?? session.taskId}`);
  if (session.pi_run_id ?? session.piRunId) lines.push(`${indent}  Pi run: ${session.pi_run_id ?? session.piRunId}`);
  if (session.pi_session_id ?? session.piSessionId) lines.push(`${indent}  Pi session: ${session.pi_session_id ?? session.piSessionId}`);
  if (session.created_by ?? session.createdBy) lines.push(`${indent}  Created by: ${session.created_by ?? session.createdBy}`);
  if (session.created_at ?? session.createdAt) {
    const date = new Date(session.created_at ?? session.createdAt);
    lines.push(`${indent}  Created: ${date.toLocaleString()}`);
  }
  const turns = Array.isArray(session.turns ?? session.Turns) ? (session.turns ?? session.Turns) : [];
  if (turns.length > 0) {
    lines.push(`${indent}  Turns: ${turns.length}`);
    const segments = Array.isArray(turns[0]?.segments ?? turns[0]?.Segments) ? (turns[0].segments ?? turns[0].Segments) : [];
    lines.push(`${indent}  Segments: ${segments.length}`);
  }
  const annotations = Array.isArray(session.annotations ?? session.Annotations) ? (session.annotations ?? session.Annotations) : [];
  if (annotations.length > 0) {
    lines.push(`${indent}  Annotations: ${annotations.length}`);
  }
  return lines;
}

/**
 * Format a session detail view including turns/segments and annotations.
 */
export function formatSessionDetail(session: any): string[] {
  const lines = formatSessionSummary(session);

  const turns = Array.isArray(session.turns ?? session.Turns) ? (session.turns ?? session.Turns) : [];
  const annotations = Array.isArray(session.annotations ?? session.Annotations) ? (session.annotations ?? session.Annotations) : [];
  const drafts = Array.isArray(session.drafts ?? session.Drafts) ? (session.drafts ?? session.Drafts) : [];

  for (const turn of turns) {
    const role = turn.role ?? turn.Role ?? "unknown";
    const sourceLabel = turn.source_label ?? turn.SourceLabel ?? turn.source_kind ?? turn.SourceKind ?? "";
    lines.push("");
    lines.push(`--- Turn #${turn.turn_order ?? turn.TurnOrder ?? turn.id} (${role}${sourceLabel ? `, ${sourceLabel}` : ""}) ---`);
    const segments = Array.isArray(turn.segments ?? turn.Segments) ? (turn.segments ?? turn.Segments) : [];
    for (const seg of segments) {
      const segType = seg.segment_type ?? seg.SegmentType ?? "unknown";
      const snip = buildSnippet(normalizeSegment(seg));
      lines.push(`  [${seg.sequence_number ?? seg.SequenceNumber}] ${segType}: ${snip}`);
    }
  }

  if (annotations.length > 0) {
    lines.push("");
    lines.push("--- Annotations ---");
    for (const ann of annotations) {
      const annType = ann.annotation_type ?? ann.AnnotationType ?? "note";
      const body = (ann.body ?? ann.Body ?? "").trim();
      const creator = ann.created_by ?? ann.CreatedBy ?? "";
      lines.push(`  [${annType}]${body ? `: ${body}` : ""}${creator ? ` (${creator})` : ""}`);
    }
  }

  if (drafts.length > 0) {
    const latest = drafts[drafts.length - 1];
    lines.push("");
    const content = (latest.content ?? latest.Content ?? "").slice(0, 200);
    lines.push(`--- Draft (rev ${latest.revision ?? latest.Revision ?? 1}) ---`);
    lines.push(content + (content.length >= 200 ? "..." : ""));
  }

  return lines;
}
