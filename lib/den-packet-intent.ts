/**
 * Packet intent mapping for Den task-thread messages.
 *
 * Policy (delegated-coder-workflow-policy):
 *   "Use `intent` values aligned with existing Den policy: `handoff` for
 *    packets, `review_request` / `review_feedback` for review rounds."
 *
 * This module maps `metadata.type` to the appropriate `intent` value so
 * that `sendTaskMessage` callers do not need to decide intent ad-hoc.
 *
 * @module den-packet-intent
 */

// ---------------------------------------------------------------------------
// Known packet types → intent mapping
// ---------------------------------------------------------------------------

/**
 * Mapping from `metadata.type` to the canonical `intent` value.
 *
 * Structured workflow packets use `handoff`.  Review-related packets
 * use review-specific intents.  Anything not listed falls back to
 * `status_update` for backward compatibility.
 */
const PACKET_TYPE_INTENT_MAP: Record<string, string> = {
  // Structured workflow packets → handoff
  coder_context_packet: "handoff",
  implementation_packet: "handoff",
  validation_packet: "handoff",
  drift_check_packet: "handoff",
  subagent_result: "handoff",
  subagent_failure: "handoff",

  // Review packets → review-specific intents
  review_request: "review_request",
  review_feedback: "review_feedback",
  review_findings_packet: "review_feedback",
};

/**
 * Resolve the appropriate Den message `intent` for a given `metadata.type`.
 *
 * @param metadataType - The `metadata.type` value (e.g. `"implementation_packet"`).
 * @returns The canonical intent string.
 */
export function resolvePacketIntent(metadataType: string | undefined): string {
  if (!metadataType) return "status_update";
  return PACKET_TYPE_INTENT_MAP[metadataType] ?? "status_update";
}

/**
 * Extract `metadata.type` from a metadata object (which may be a parsed
 * object or already a string) and resolve the appropriate intent.
 *
 * @param metadata - The metadata object or string passed to `sendTaskMessage`.
 * @returns The canonical intent string.
 */
export function resolveIntentFromMetadata(metadata: unknown): string {
  let type: string | undefined;
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata);
      type = parsed?.type;
    } catch {
      // Not JSON — no type to extract.
    }
  } else if (metadata && typeof metadata === "object") {
    type = (metadata as Record<string, unknown>).type as string | undefined;
  }
  return resolvePacketIntent(type);
}

/**
 * Return the full mapping for inspection/testing.
 * Not intended for production use — prefer `resolvePacketIntent`.
 */
export function getPacketTypeIntentMap(): Readonly<Record<string, string>> {
  return { ...PACKET_TYPE_INTENT_MAP };
}
