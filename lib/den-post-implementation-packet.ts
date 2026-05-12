/**
 * Post-result automation for posting coder implementation packets.
 *
 * After a successful coder sub-agent run, this module encapsulates the logic
 * that extracts the implementation packet from the coder's final output and
 * posts the appropriate message to the Den task thread:
 *
 * - If the output is a prompt-like incomplete string (e.g., "Now post the
 *   implementation packet to the Den task thread:"), it posts an
 *   `implementation_packet_missing` notice.
 * - Otherwise, it posts a normal `implementation_packet` (complete or partial).
 *
 * The function accepts injectable dependencies for Den API calls so it can
 * be tested without a running Den server.
 *
 * @module den-post-implementation-packet
 */

import { optionalNumber } from "./den-string-utils.ts";
import {
  extractImplementationPacket,
  formatImplementationPacketMessage,
  buildImplementationPacketMeta,
  findDuplicateImplementationPacketMessage,
  formatPacketMissingNoticeMessage,
  buildPacketMissingNoticeMeta,
  type ExtractionResult,
} from "./den-implementation-packet.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A sub-agent result with the fields needed for packet posting. */
export interface CoderRunResult {
  final_output: string;
  run_id: string;
  role: string;
  task_id?: number;
  branch?: string;
  head_commit?: string;
  final_head_commit?: string;
  final_branch?: string;
  requested_head_commit?: string;
  purpose?: string;
  usage_summary?: Record<string, unknown> | null;
}

/** Injectable dependencies for Den API calls. */
export interface PacketPostingDeps {
  /** Send a task-thread message. Returns the created message (with id). */
  sendMessage: (content: string, metadata: Record<string, unknown>) => Promise<{ id?: number }>;
  /** Fetch existing task-thread messages (for duplicate detection). */
  getExistingMessages: () => Promise<Array<{ id?: number; metadata?: unknown; task_id?: number | null }>>;
  /** Record a packet lifecycle ops event. */
  recordLifecycleOps: (packetType: string, messageId: number | undefined, extra: Record<string, unknown>) => Promise<void>;
  /** Build the base run metadata to spread into packet messages. */
  buildRunMetadata: () => Record<string, unknown>;
}

/** Parameters for the post-result packet posting function. */
export interface PacketPostingParams {
  taskId: number;
  result: CoderRunResult;
  finalHeadMetadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function metadataString(entry: unknown, key: string): string | undefined {
  const val = (entry as any)?.[key];
  if (val === undefined || val === null) return undefined;
  const str = String(val).trim();
  return str || undefined;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Post the implementation packet (or packet-missing notice) for a completed
 * coder sub-agent run.
 *
 * This function encapsulates the post-result automation branch that:
 * 1. Extracts the implementation packet from the coder's final output.
 * 2. If the output is a prompt-like incomplete string, posts an
 *    `implementation_packet_missing` notice with the appropriate metadata.
 * 3. Otherwise, posts a normal `implementation_packet` (complete or partial)
 *    with deduplication against existing task-thread messages.
 * 4. Records the appropriate packet lifecycle ops event.
 *
 * @param deps - Injectable Den API dependencies.
 * @param params - Run context and result.
 */
export async function postCoderImplementationPacket(
  deps: PacketPostingDeps,
  params: PacketPostingParams,
): Promise<void> {
  const { taskId, result, finalHeadMetadata } = params;

  const extraction = extractImplementationPacket(result.final_output);

  if (extraction.incomplete_prompt_detected) {
    // Incomplete prompt detected: post a packet-missing notice instead of
    // a real implementation packet.
    const noticeContent = formatPacketMissingNoticeMessage(result, extraction);
    const noticeMeta = buildPacketMissingNoticeMeta(result, extraction);
    const noticeMessage = await deps.sendMessage(noticeContent, {
      ...deps.buildRunMetadata(),
      ...noticeMeta,
      incomplete_prompt_detected: true,
      usage_summary: result.usage_summary ?? null,
      ...finalHeadMetadata,
    });
    await deps.recordLifecycleOps(
      "implementation_packet_missing",
      optionalNumber(noticeMessage?.id),
      {
        run_id: result.run_id,
        role: result.role,
        branch: result.branch ?? null,
        head_commit: result.final_head_commit ?? result.head_commit ?? null,
        missing_fields: extraction.missing_fields,
      },
    );
  } else {
    // Normal packet path: post the extracted implementation packet.
    const packetContent = formatImplementationPacketMessage(result, extraction);
    const extractedPacketMeta = buildImplementationPacketMeta(result, extraction);
    const packetMeta = {
      ...extractedPacketMeta,
      branch: metadataString(finalHeadMetadata, "final_branch") ?? extractedPacketMeta.branch,
      head_commit: metadataString(finalHeadMetadata, "final_head_commit") ?? extractedPacketMeta.head_commit,
    };

    // Duplicate detection: skip posting if a matching packet already exists.
    let duplicatePacket: any | undefined;
    try {
      const existingPackets = await deps.getExistingMessages();
      duplicatePacket = findDuplicateImplementationPacketMessage(existingPackets, {
        ...packetMeta,
        final_branch: metadataString(finalHeadMetadata, "final_branch") ?? null,
        final_head_commit: metadataString(finalHeadMetadata, "final_head_commit") ?? null,
      });
    } catch {
      // Duplicate detection is best-effort; still try to post the auto packet.
    }

    const packetMessage = duplicatePacket ?? await deps.sendMessage(packetContent, {
      ...deps.buildRunMetadata(),
      ...packetMeta,
      usage_summary: result.usage_summary ?? null,
      ...finalHeadMetadata,
    });
    await deps.recordLifecycleOps(
      "implementation_packet",
      optionalNumber(packetMessage?.id),
      {
        run_id: result.run_id,
        role: result.role,
        branch: result.branch ?? null,
        head_commit: result.final_head_commit ?? result.head_commit ?? null,
        duplicate_skipped: duplicatePacket !== undefined,
      },
    );
  }
}
