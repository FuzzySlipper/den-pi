import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolvePacketIntent,
  resolveIntentFromMetadata,
  getPacketTypeIntentMap,
} from "../../lib/den-packet-intent.ts";

describe("den-packet-intent", () => {
  describe("resolvePacketIntent", () => {
    it("returns handoff for coder_context_packet", () => {
      assert.equal(resolvePacketIntent("coder_context_packet"), "handoff");
    });

    it("returns handoff for implementation_packet", () => {
      assert.equal(resolvePacketIntent("implementation_packet"), "handoff");
    });

    it("returns handoff for validation_packet", () => {
      assert.equal(resolvePacketIntent("validation_packet"), "handoff");
    });

    it("returns handoff for drift_check_packet", () => {
      assert.equal(resolvePacketIntent("drift_check_packet"), "handoff");
    });

    it("returns handoff for subagent_result", () => {
      assert.equal(resolvePacketIntent("subagent_result"), "handoff");
    });

    it("returns handoff for subagent_failure", () => {
      assert.equal(resolvePacketIntent("subagent_failure"), "handoff");
    });

    it("returns review_request for review_request type", () => {
      assert.equal(resolvePacketIntent("review_request"), "review_request");
    });

    it("returns review_feedback for review_feedback type", () => {
      assert.equal(resolvePacketIntent("review_feedback"), "review_feedback");
    });

    it("returns review_feedback for review_findings_packet type", () => {
      assert.equal(resolvePacketIntent("review_findings_packet"), "review_feedback");
    });

    it("returns status_update for unknown types", () => {
      assert.equal(resolvePacketIntent("some_new_packet_type"), "status_update");
    });

    it("returns status_update for undefined", () => {
      assert.equal(resolvePacketIntent(undefined), "status_update");
    });
  });

  describe("resolveIntentFromMetadata", () => {
    it("resolves intent from a metadata object with type", () => {
      assert.equal(
        resolveIntentFromMetadata({ type: "implementation_packet", version: 1 }),
        "handoff",
      );
    });

    it("resolves intent from a JSON-stringified metadata object", () => {
      assert.equal(
        resolveIntentFromMetadata(JSON.stringify({ type: "coder_context_packet", version: 1 })),
        "handoff",
      );
    });

    it("returns status_update for metadata without type", () => {
      assert.equal(
        resolveIntentFromMetadata({ version: 1, prepared_by: "orchestrator" }),
        "status_update",
      );
    });

    it("returns status_update for empty object", () => {
      assert.equal(resolveIntentFromMetadata({}), "status_update");
    });

    it("returns status_update for null", () => {
      assert.equal(resolveIntentFromMetadata(null), "status_update");
    });

    it("returns status_update for non-JSON string", () => {
      assert.equal(resolveIntentFromMetadata("not-json"), "status_update");
    });

    it("returns status_update for undefined", () => {
      assert.equal(resolveIntentFromMetadata(undefined), "status_update");
    });

    it("preserves metadata.type discovery — only maps intent, does not alter metadata", () => {
      // The metadata object should not be mutated.
      const meta = { type: "drift_check_packet", risk: "low" };
      const intent = resolveIntentFromMetadata(meta);
      assert.equal(intent, "handoff");
      assert.deepEqual(meta, { type: "drift_check_packet", risk: "low" });
    });
  });

  describe("getPacketTypeIntentMap", () => {
    it("returns a complete mapping for all known packet types", () => {
      const map = getPacketTypeIntentMap();

      // Structured workflow packets → handoff
      assert.equal(map.coder_context_packet, "handoff");
      assert.equal(map.implementation_packet, "handoff");
      assert.equal(map.validation_packet, "handoff");
      assert.equal(map.drift_check_packet, "handoff");
      assert.equal(map.subagent_result, "handoff");
      assert.equal(map.subagent_failure, "handoff");

      // Review packets → review-specific intents
      assert.equal(map.review_request, "review_request");
      assert.equal(map.review_feedback, "review_feedback");
      assert.equal(map.review_findings_packet, "review_feedback");
    });

    it("returns a copy — mutations do not affect the module mapping", () => {
      const map1 = getPacketTypeIntentMap();
      map1["test_mutation"] = "broken";
      const map2 = getPacketTypeIntentMap();
      assert.equal(map2["test_mutation"], undefined);
    });
  });
});
