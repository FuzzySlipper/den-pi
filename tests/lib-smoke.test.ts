import test from "node:test";
import assert from "node:assert/strict";
import { resolvePacketIntent, resolveIntentFromMetadata, getPacketTypeIntentMap } from "../lib/den-packet-intent.ts";
import { normalizeString, oneLine, optionalNumber } from "../lib/den-string-utils.ts";

test("packet intent mapping preserves canonical Den intents", () => {
  assert.equal(resolvePacketIntent("coder_context_packet"), "handoff");
  assert.equal(resolvePacketIntent("implementation_packet"), "handoff");
  assert.equal(resolvePacketIntent("review_findings_packet"), "review_feedback");
  assert.equal(resolvePacketIntent("review_request"), "review_request");
  assert.equal(resolvePacketIntent("unknown_packet"), "status_update");
  assert.equal(resolvePacketIntent(undefined), "status_update");
});

test("packet intent can be resolved from object or JSON metadata", () => {
  assert.equal(resolveIntentFromMetadata({ type: "validation_packet" }), "handoff");
  assert.equal(resolveIntentFromMetadata(JSON.stringify({ type: "review_feedback" })), "review_feedback");
  assert.equal(resolveIntentFromMetadata("not-json"), "status_update");
});

test("packet intent map is returned as a defensive copy", () => {
  const map = getPacketTypeIntentMap();
  assert.equal(map.implementation_packet, "handoff");
  map.implementation_packet = "mutated";
  assert.equal(getPacketTypeIntentMap().implementation_packet, "handoff");
});

test("string utilities normalize bounded values", () => {
  assert.equal(normalizeString("  hello  "), "hello");
  assert.equal(normalizeString("   "), undefined);
  assert.equal(oneLine("a\n  b\t c", 20), "a b c");
  assert.equal(oneLine("0123456789", 4), "0123");
  assert.equal(optionalNumber(42), 42);
  assert.equal(optionalNumber(Number.NaN), undefined);
  assert.equal(optionalNumber("42"), undefined);
});
