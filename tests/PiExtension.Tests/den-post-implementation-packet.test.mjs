/**
 * Integration/mock tests for the post-result automation branch that posts
 * implementation packets (or packet-missing notices) after a coder sub-agent
 * run completes.
 *
 * These tests verify that the actual post-result automation path in
 * `postCoderImplementationPacket` correctly routes:
 *
 * - Prompt-like incomplete outputs (e.g., "Now post the implementation packet
 *   to the Den task thread:") to `implementation_packet_missing`.
 * - Complete structured outputs to `implementation_packet`.
 *
 * This is the integration coverage requested by review finding R1077-2.
 *
 * @module den-post-implementation-packet.test
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  postCoderImplementationPacket,
} from '../../lib/den-post-implementation-packet.ts';

// ---------------------------------------------------------------------------
// Complete coder output fixture
// ---------------------------------------------------------------------------

const COMPLETE_CODER_OUTPUT = `
## Branch and head commit

Branch: \`task/908-fix-incomplete-packet\`
Head commit: \`abc123def456\`

## Summary of what changed

Fixed the post-result automation to detect incomplete prompts.

## Files changed

- \`pi-dev/lib/den-implementation-packet.ts\`
- \`pi-dev/lib/den-post-implementation-packet.ts\`

## Tests run

All 51 tests passed (51 pass, 0 fail, 0 skip).

## Acceptance checklist

- [x] Incomplete prompts detected and routed correctly

## Known gaps

None.

## Risk notes

Low risk.
`;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockDeps(overrides = {}) {
  return {
    async sendMessage(content, metadata) {
      return { id: 42 };
    },
    async getExistingMessages() {
      return [];
    },
    async recordLifecycleOps(packetType, messageId, extra) {},
    buildRunMetadata() {
      return { schema: 'den_subagent_run', run_id: 'run-test' };
    },
    ...overrides,
  };
}

function coderResult(overrides = {}) {
  return {
    final_output: COMPLETE_CODER_OUTPUT,
    run_id: 'run-908',
    role: 'coder',
    task_id: 908,
    branch: 'task/908-fix-incomplete-packet',
    head_commit: 'abc123def456',
    purpose: 'implementation',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: incomplete prompt → implementation_packet_missing
// ---------------------------------------------------------------------------

test('incomplete prompt output routes to implementation_packet_missing', async () => {
  const sentMessages = [];
  const lifecycleOps = [];

  const deps = createMockDeps({
    async sendMessage(content, metadata) {
      sentMessages.push({ content, metadata });
      return { id: 100 };
    },
    async recordLifecycleOps(packetType, messageId, extra) {
      lifecycleOps.push({ packetType, messageId, extra });
    },
  });

  await postCoderImplementationPacket(deps, {
    taskId: 908,
    result: coderResult({
      final_output: 'Now post the implementation packet to the Den task thread:',
    }),
    finalHeadMetadata: {},
  });

  // Exactly one message was sent.
  assert.equal(sentMessages.length, 1, 'should post exactly one message');

  // The message content is a packet-missing notice.
  const msg = sentMessages[0];
  assert.ok(msg.content.includes('# Implementation Packet Missing'),
    'message content should be a packet-missing notice');
  assert.ok(msg.content.includes('⚠️'),
    'message should include warning emoji');
  assert.ok(msg.content.includes('did not produce a complete implementation packet'),
    'message should explain the issue');

  // The metadata type is implementation_packet_missing.
  assert.equal(msg.metadata.type, 'implementation_packet_missing',
    'metadata.type should be implementation_packet_missing');
  assert.equal(msg.metadata.incomplete_prompt_detected, true,
    'metadata should flag incomplete_prompt_detected');
  assert.equal(msg.metadata.packet_completeness, 'missing',
    'metadata should report missing completeness');
  assert.equal(msg.metadata.prepared_by, 'coder_run',
    'metadata prepared_by should be coder_run');
  assert.equal(msg.metadata.run_id, 'run-908',
    'metadata should have correct run_id');

  // Lifecycle ops recorded for implementation_packet_missing.
  assert.equal(lifecycleOps.length, 1, 'should record one lifecycle op');
  assert.equal(lifecycleOps[0].packetType, 'implementation_packet_missing',
    'lifecycle op should be implementation_packet_missing');
  assert.equal(lifecycleOps[0].messageId, 100,
    'lifecycle op should reference the posted message id');
  assert.equal(lifecycleOps[0].extra.run_id, 'run-908',
    'lifecycle extra should have run_id');
});

test('incomplete prompt variant "Post the implementation packet" routes to packet_missing', async () => {
  const sentMessages = [];

  const deps = createMockDeps({
    async sendMessage(content, metadata) {
      sentMessages.push({ content, metadata });
      return { id: 101 };
    },
  });

  await postCoderImplementationPacket(deps, {
    taskId: 908,
    result: coderResult({
      final_output: 'Post the implementation packet to the task thread.',
    }),
    finalHeadMetadata: {},
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].metadata.type, 'implementation_packet_missing');
  assert.equal(sentMessages[0].metadata.incomplete_prompt_detected, true);
});

test('incomplete prompt "Let\'s post the implementation packet now" routes to packet_missing', async () => {
  const sentMessages = [];

  const deps = createMockDeps({
    async sendMessage(content, metadata) {
      sentMessages.push({ content, metadata });
      return { id: 102 };
    },
  });

  await postCoderImplementationPacket(deps, {
    taskId: 908,
    result: coderResult({
      final_output: "Let's post the implementation packet now.",
    }),
    finalHeadMetadata: {},
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].metadata.type, 'implementation_packet_missing');
});

// ---------------------------------------------------------------------------
// Tests: complete output → implementation_packet
// ---------------------------------------------------------------------------

test('complete structured output routes to implementation_packet', async () => {
  const sentMessages = [];
  const lifecycleOps = [];

  const deps = createMockDeps({
    async sendMessage(content, metadata) {
      sentMessages.push({ content, metadata });
      return { id: 200 };
    },
    async recordLifecycleOps(packetType, messageId, extra) {
      lifecycleOps.push({ packetType, messageId, extra });
    },
  });

  await postCoderImplementationPacket(deps, {
    taskId: 908,
    result: coderResult(),
    finalHeadMetadata: {},
  });

  assert.equal(sentMessages.length, 1, 'should post exactly one message');

  const msg = sentMessages[0];
  assert.ok(msg.content.includes('# Implementation Packet'),
    'message should be an implementation packet');
  assert.ok(msg.content.includes('**Completeness:** complete'),
    'message should report complete');
  assert.ok(!msg.content.includes('⚠️'),
    'complete packet should not have warning');

  // The metadata type is implementation_packet (not packet_missing).
  assert.equal(msg.metadata.type, 'implementation_packet',
    'metadata.type should be implementation_packet');
  assert.equal(msg.metadata.packet_completeness, 'complete',
    'metadata should report complete');
  assert.equal(msg.metadata.run_id, 'run-908');

  // Lifecycle ops recorded for implementation_packet.
  assert.equal(lifecycleOps.length, 1);
  assert.equal(lifecycleOps[0].packetType, 'implementation_packet');
  assert.equal(lifecycleOps[0].messageId, 200);
});

test('partial non-prompt output routes to implementation_packet with partial completeness', async () => {
  const sentMessages = [];

  const deps = createMockDeps({
    async sendMessage(content, metadata) {
      sentMessages.push({ content, metadata });
      return { id: 201 };
    },
  });

  const partialOutput = `
## Branch

task/908-partial

## Head Commit

abc123

## Summary

Made progress but ran out of context.

## Files Changed

- src/main.ts
`;

  await postCoderImplementationPacket(deps, {
    taskId: 908,
    result: coderResult({ final_output: partialOutput }),
    finalHeadMetadata: {},
  });

  assert.equal(sentMessages.length, 1);
  // Non-prompt partial packets should be implementation_packet, not packet_missing.
  assert.equal(sentMessages[0].metadata.type, 'implementation_packet',
    'non-prompt partial should be implementation_packet');
  assert.equal(sentMessages[0].metadata.packet_completeness, 'partial',
    'should report partial completeness');
  assert.ok(Array.isArray(sentMessages[0].metadata.packet_missing_fields));
  assert.ok(sentMessages[0].metadata.packet_missing_fields.length > 0);
});

// ---------------------------------------------------------------------------
// Tests: deduplication for implementation_packet path
// ---------------------------------------------------------------------------

test('implementation_packet skips posting when duplicate exists', async () => {
  const sentMessages = [];
  const lifecycleOps = [];

  // Simulate an existing implementation_packet message for the same run.
  const existingMessages = [
    {
      id: 50,
      task_id: 908,
      metadata: JSON.stringify({
        type: 'implementation_packet',
        run_id: 'run-908',
        branch: 'task/908-fix-incomplete-packet',
        head_commit: 'abc123def456',
      }),
    },
  ];

  const deps = createMockDeps({
    async sendMessage(content, metadata) {
      sentMessages.push({ content, metadata });
      return { id: 200 };
    },
    async getExistingMessages() {
      return existingMessages;
    },
    async recordLifecycleOps(packetType, messageId, extra) {
      lifecycleOps.push({ packetType, messageId, extra });
    },
  });

  await postCoderImplementationPacket(deps, {
    taskId: 908,
    result: coderResult(),
    finalHeadMetadata: {},
  });

  // No new message should be sent (duplicate detected).
  assert.equal(sentMessages.length, 0,
    'should not send a new message when duplicate exists');

  // Lifecycle ops should still be recorded with duplicate_skipped.
  assert.equal(lifecycleOps.length, 1);
  assert.equal(lifecycleOps[0].packetType, 'implementation_packet');
  assert.equal(lifecycleOps[0].extra.duplicate_skipped, true,
    'should flag duplicate_skipped');
});

// ---------------------------------------------------------------------------
// Tests: finalHeadMetadata integration
// ---------------------------------------------------------------------------

test('finalHeadMetadata overrides branch and head_commit in implementation_packet metadata', async () => {
  const sentMessages = [];

  const deps = createMockDeps({
    async sendMessage(content, metadata) {
      sentMessages.push({ content, metadata });
      return { id: 300 };
    },
  });

  await postCoderImplementationPacket(deps, {
    taskId: 908,
    result: coderResult(),
    finalHeadMetadata: {
      final_branch: 'task/908-resolved',
      final_head_commit: 'final789',
    },
  });

  assert.equal(sentMessages.length, 1);
  // final_head_commit from finalHeadMetadata should override.
  assert.equal(sentMessages[0].metadata.head_commit, 'final789',
    'head_commit should come from finalHeadMetadata');
  assert.equal(sentMessages[0].metadata.branch, 'task/908-resolved',
    'branch should come from finalHeadMetadata');
});

test('finalHeadMetadata is spread into packet_missing metadata', async () => {
  const sentMessages = [];

  const deps = createMockDeps({
    async sendMessage(content, metadata) {
      sentMessages.push({ content, metadata });
      return { id: 301 };
    },
  });

  await postCoderImplementationPacket(deps, {
    taskId: 908,
    result: coderResult({
      final_output: 'Now post the implementation packet to the Den task thread:',
    }),
    finalHeadMetadata: {
      final_branch: 'task/908-final',
      final_head_commit: 'deadbeef',
    },
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].metadata.type, 'implementation_packet_missing');
  assert.equal(sentMessages[0].metadata.final_branch, 'task/908-final');
  assert.equal(sentMessages[0].metadata.final_head_commit, 'deadbeef');
});

// ---------------------------------------------------------------------------
// Tests: usage_summary propagation
// ---------------------------------------------------------------------------

test('usage_summary is propagated to both packet_missing and implementation_packet metadata', async () => {
  // packet_missing path
  const missingMessages = [];
  const missingDeps = createMockDeps({
    async sendMessage(content, metadata) {
      missingMessages.push({ content, metadata });
      return { id: 400 };
    },
  });

  await postCoderImplementationPacket(missingDeps, {
    taskId: 908,
    result: coderResult({
      final_output: 'Now post the implementation packet to the Den task thread:',
      usage_summary: { total_tokens: 500, source: 'test' },
    }),
    finalHeadMetadata: {},
  });

  assert.equal(missingMessages[0].metadata.usage_summary.total_tokens, 500);

  // implementation_packet path
  const packetMessages = [];
  const packetDeps = createMockDeps({
    async sendMessage(content, metadata) {
      packetMessages.push({ content, metadata });
      return { id: 401 };
    },
  });

  await postCoderImplementationPacket(packetDeps, {
    taskId: 908,
    result: coderResult({
      usage_summary: { total_tokens: 1000, source: 'test' },
    }),
    finalHeadMetadata: {},
  });

  assert.equal(packetMessages[0].metadata.usage_summary.total_tokens, 1000);
});
