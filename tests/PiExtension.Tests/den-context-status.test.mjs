import assert from 'node:assert/strict';
import test from 'node:test';
import denExtension from '../../extensions/den.ts';
import {
  buildDenContextStatus,
  buildDenContextStatusToolResult,
  captureDenContextStatus,
  summarizeDenContextStatusForMetadata,
} from '../../lib/den-context-status.ts';
import {
  buildDenContextCompactionToolResult,
  compactionGuardrails,
  formatDenContextCompactionResult,
  requestDenContextCompaction,
} from '../../lib/den-context-compaction.ts';

const generatedAt = '2026-04-27T00:00:00.000Z';

function baseInput(overrides = {}) {
  return {
    generatedAt,
    cwd: '/repo',
    sessionId: 'session-1',
    sessionFile: '/tmp/session.jsonl',
    model: {
      provider: 'openai',
      id: 'gpt-test',
      contextWindow: 100_000,
      maxTokens: 16_384,
    },
    compaction: {
      enabled: true,
      reserveTokens: 16_000,
      keepRecentTokens: 20_000,
    },
    sessionEntries: [],
    ...overrides,
  };
}

test('context status classifies ok, watch, and compact-after-task thresholds', () => {
  const ok = buildDenContextStatus(baseInput({
    contextUsage: { tokens: 20_000, contextWindow: 100_000, percent: 20 },
  }));
  assert.equal(ok.context.source, 'pi_context_usage_estimate');
  assert.equal(ok.context.confidence, 'medium');
  assert.equal(ok.recommendation.status, 'ok');
  assert.equal(ok.compaction.auto_compact_threshold_percent, 84);
  assert.equal(ok.compaction.watch_threshold_percent, 63);
  assert.equal(ok.compaction.compact_after_task_threshold_percent, 75.6);

  const watch = buildDenContextStatus(baseInput({
    contextUsage: { tokens: 70_000, contextWindow: 100_000, percent: 70 },
  }));
  assert.equal(watch.recommendation.status, 'watch');
  assert.match(watch.recommendation.reason, /70\.0%/);

  const compact = buildDenContextStatus(baseInput({
    contextUsage: { tokens: 76_000, contextWindow: 100_000, percent: 76 },
  }));
  assert.equal(compact.recommendation.status, 'compact_after_current_task');
  assert.match(compact.recommendation.action, /den_compact_context/);
});

test('context status handles missing and unknown usage conservatively', () => {
  const missing = buildDenContextStatus(baseInput({
    contextUsage: null,
    sessionEntries: [],
  }));
  assert.equal(missing.context.source, 'unavailable');
  assert.equal(missing.context.confidence, 'unknown');
  assert.equal(missing.context.accuracy, 'unknown');
  assert.equal(missing.context.used_tokens_estimate, null);
  assert.equal(missing.recommendation.status, 'watch');
  assert.match(missing.recommendation.reason, /unknown/);

  const postCompaction = buildDenContextStatus(baseInput({
    contextUsage: { tokens: null, contextWindow: 100_000, percent: null },
  }));
  assert.equal(postCompaction.context.source, 'pi_context_usage_estimate');
  assert.equal(postCompaction.context.confidence, 'unknown');
  assert.equal(postCompaction.recommendation.status, 'watch');
  assert.match(postCompaction.context.notes.join('\n'), /immediately after compaction/);
});

test('context status falls back to last assistant provider usage when Pi usage is unavailable', () => {
  const status = buildDenContextStatus(baseInput({
    contextUsage: null,
    sessionEntries: [
      { type: 'message', timestamp: '2026-04-26T00:00:00.000Z', message: { role: 'assistant', stopReason: 'stop', usage: { input: 1_000, output: 2_000, cacheRead: 3_000, cacheWrite: 4_000, totalTokens: 0 } } },
      { type: 'message', timestamp: '2026-04-26T00:01:00.000Z', message: { role: 'assistant', stopReason: 'stop', usage: { input: 40_000, output: 5_000, cacheRead: 5_000, cacheWrite: 0, totalTokens: 50_000 } } },
    ],
  }));

  assert.equal(status.context.source, 'provider_reported_last_assistant_usage');
  assert.equal(status.context.confidence, 'low');
  assert.equal(status.context.used_tokens_estimate, 50_000);
  assert.equal(status.context.used_percent_estimate, 50);
  assert.equal(status.context.last_usage_timestamp, '2026-04-26T00:01:00.000Z');
  assert.match(status.context.notes.join('\n'), /can be stale/);
});

test('captureDenContextStatus uses ctx.getContextUsage ahead of stale session usage', () => {
  const ctx = {
    cwd: '/repo',
    model: { provider: 'openai', id: 'gpt-test', contextWindow: 100_000, maxTokens: 16_384 },
    getContextUsage() {
      return { tokens: 25_000, contextWindow: 100_000, percent: 25 };
    },
    sessionManager: {
      getSessionId: () => 'session-ctx',
      getSessionFile: () => '/tmp/session-ctx.jsonl',
      getBranch: () => [
        { type: 'message', timestamp: '2026-04-26T00:02:00.000Z', message: { role: 'assistant', stopReason: 'stop', usage: { input: 90_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 90_000 } } },
      ],
    },
    settingsManager: {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_000, keepRecentTokens: 20_000 }),
    },
  };

  const status = captureDenContextStatus(ctx);
  assert.equal(status.context.source, 'pi_context_usage_estimate');
  assert.equal(status.context.used_tokens_estimate, 25_000);
  assert.equal(status.context.used_percent_estimate, 25);
  assert.equal(status.session.session_id, 'session-ctx');
  assert.equal(status.session.branch_entry_count, 1);
});

test('den extension registers context status and compact commands/tools', () => {
  const commands = [];
  const tools = [];
  denExtension({
    on() {},
    registerCommand(name, definition) {
      commands.push({ name, definition });
    },
    registerTool(definition) {
      tools.push(definition);
    },
  });

  assert.ok(commands.some((entry) => entry.name === 'den-context-status'));
  assert.ok(commands.some((entry) => entry.name === 'den-compaction-status'));
  assert.ok(commands.some((entry) => entry.name === 'den-compact-context'));
  const statusTool = tools.find((entry) => entry.name === 'den_context_status');
  assert.ok(statusTool, 'den_context_status should be registered');
  assert.deepEqual(statusTool.parameters, { type: 'object', properties: {}, additionalProperties: false });

  const compactTool = tools.find((entry) => entry.name === 'den_compact_context');
  assert.ok(compactTool, 'den_compact_context should be registered');
  assert.deepEqual(compactTool.parameters.required, ['durable_context_posted']);
  assert.equal(compactTool.parameters.properties.durable_context_posted.type, 'boolean');
});

test('den_compact_context refuses before durable Den context is confirmed', () => {
  let compactCalled = false;
  const result = requestDenContextCompaction({ compact: () => { compactCalled = true; } }, {
    durableContextPosted: false,
    customInstructions: 'Keep task state',
  });

  assert.equal(result.requested, false);
  assert.equal(result.status, 'blocked');
  assert.equal(compactCalled, false);
  assert.equal(result.resume_configured, false);
  assert.match(result.resume_note, /not requested/);
  const toolResult = buildDenContextCompactionToolResult(result);
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0].text, /durable Den context/);
});

test('den_compact_context reports unavailable when Pi runtime has no compact hook', () => {
  const result = requestDenContextCompaction({}, {
    durableContextPosted: true,
  });

  assert.equal(result.requested, false);
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /does not expose ctx\.compact/);
  assert.equal(result.resume_configured, false);
  const toolResult = buildDenContextCompactionToolResult(result);
  assert.equal(toolResult.isError, true);
});

test('den_compact_context reports failed when compact throws synchronously', () => {
  const result = requestDenContextCompaction({
    compact() { throw new Error('boom'); },
  }, {
    durableContextPosted: true,
  });

  assert.equal(result.requested, false);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /boom/);
});

test('den_compact_context requests Pi compaction with orchestrator instructions', async () => {
  const calls = [];
  const notifications = [];
  const result = requestDenContextCompaction({
    compact(options) { calls.push(options); },
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  }, {
    durableContextPosted: true,
    customInstructions: 'Focus on workflow decisions',
    safePointNotes: 'After merge summary',
  });

  assert.equal(result.requested, true);
  assert.equal(result.status, 'requested');
  assert.equal(result.custom_instructions, 'Focus on workflow decisions');
  assert.equal(result.safe_point_notes, 'After merge summary');
  assert.equal(result.resume_configured, false); // no sendResumeMessage
  assert.match(result.resume_note, /no sendResumeMessage callback available/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].customInstructions, 'Focus on workflow decisions');
  calls[0].onComplete({});
  assert.deepEqual(notifications, [{ message: 'Den orchestrator context compaction completed.', level: 'info' }]);
});

test('den_compact_context tool execute triggers idle resume through extension context', async () => {
  const tools = [];
  const resumeMessages = [];
  denExtension({
    on() {},
    registerCommand() {},
    registerTool(definition) { tools.push(definition); },
    sendUserMessage(message, options) { resumeMessages.push({ message, options }); },
  });
  const tool = tools.find((entry) => entry.name === 'den_compact_context');
  const calls = [];
  const result = await tool.execute('call-1', {
    durable_context_posted: true,
    custom_instructions: 'Keep Den handoffs',
    safe_point_notes: 'Between tasks',
  }, undefined, undefined, {
    compact(options) { calls.push(options); },
    isIdle() { return true; },
    ui: { notify() {} },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.status, 'requested');
  assert.equal(result.details.resume_configured, true); // sendResumeMessage is wired up via extension closure
  assert.equal(calls.length, 1);
  assert.equal(calls[0].customInstructions, 'Keep Den handoffs');
  calls[0].onComplete({ summary: 'test', firstKeptEntryId: 'abc', tokensBefore: 1000, details: {} });
  assert.equal(resumeMessages.length, 1);
  assert.equal(resumeMessages[0].options, undefined);
});

test('den_compact_context tool queues follow-up resume if context still reports busy', async () => {
  const tools = [];
  const resumeMessages = [];
  denExtension({
    on() {},
    registerCommand() {},
    registerTool(definition) { tools.push(definition); },
    sendUserMessage(message, options) { resumeMessages.push({ message, options }); },
  });
  const tool = tools.find((entry) => entry.name === 'den_compact_context');
  const calls = [];
  const result = await tool.execute('call-1', {
    durable_context_posted: true,
  }, undefined, undefined, {
    compact(options) { calls.push(options); },
    isIdle() { return false; },
    ui: { notify() {} },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.resume_configured, true);
  calls[0].onComplete({ summary: 'test', firstKeptEntryId: 'abc', tokensBefore: 1000, details: {} });
  assert.equal(resumeMessages.length, 1);
  assert.deepEqual(resumeMessages[0].options, { deliverAs: 'followUp' });
});

test('context status tool result and binding metadata stay compact', () => {
  const status = buildDenContextStatus(baseInput({
    contextUsage: { tokens: 76_000, contextWindow: 100_000, percent: 76 },
  }));
  const toolResult = buildDenContextStatusToolResult(status);
  const metadata = summarizeDenContextStatusForMetadata(status);

  assert.equal(toolResult.isError, false);
  assert.match(toolResult.content[0].text, /Context recommendation: compact_after_current_task/);
  assert.equal(toolResult.details.schema, 'den_context_status');
  assert.equal(metadata.recommendation, 'compact_after_current_task');
  assert.equal(metadata.used_percent_estimate, 76);
  assert.ok(JSON.stringify(toolResult).length < 6_000, 'context status tool result should remain bounded');
  assert.ok(JSON.stringify(metadata).length < 1_000, 'binding metadata summary should remain compact');
});

test('den_compact_context sends resume message via callback after compaction completes', () => {
  const compactCalls = [];
  const resumeMessages = [];
  const result = requestDenContextCompaction({
    compact(options) { compactCalls.push(options); },
    ui: { notify() {} },
  }, {
    durableContextPosted: true,
    resumeAfterCompaction: true,
  }, {
    sendResumeMessage: (message) => resumeMessages.push(message),
  });

  assert.equal(result.requested, true);
  assert.equal(result.status, 'requested');
  assert.equal(result.resume_configured, true);
  assert.match(result.resume_note, /follow-up prompt will be sent automatically/);

  // Simulate compaction completing
  assert.equal(compactCalls.length, 1);
  assert.equal(resumeMessages.length, 0);
  compactCalls[0].onComplete({ summary: 'test', firstKeptEntryId: 'abc', tokensBefore: 1000, details: {} });
  assert.equal(resumeMessages.length, 1);
  assert.match(resumeMessages[0], /compaction completed/i);
  assert.match(resumeMessages[0], /Re-read/);
});

test('den_compact_context does not resume when resumeAfterCompaction is false', () => {
  const compactCalls = [];
  const resumeMessages = [];
  const result = requestDenContextCompaction({
    compact(options) { compactCalls.push(options); },
    ui: { notify() {} },
  }, {
    durableContextPosted: true,
    resumeAfterCompaction: false,
  }, {
    sendResumeMessage: (message) => resumeMessages.push(message),
  });

  assert.equal(result.requested, true);
  assert.equal(result.resume_configured, false);
  assert.match(result.resume_note, /not requested/);

  compactCalls[0].onComplete({ summary: 'test', firstKeptEntryId: 'abc', tokensBefore: 1000, details: {} });
  assert.equal(resumeMessages.length, 0, 'should not send resume when resumeAfterCompaction is false');
});

test('den_compact_context does not resume when sendResumeMessage is not provided', () => {
  const compactCalls = [];
  const result = requestDenContextCompaction({
    compact(options) { compactCalls.push(options); },
    ui: { notify() {} },
  }, {
    durableContextPosted: true,
    resumeAfterCompaction: true,
  }); // no options with sendResumeMessage

  assert.equal(result.requested, true);
  assert.equal(result.resume_configured, false);
  assert.match(result.resume_note, /no sendResumeMessage callback available/);

  // onComplete should not throw
  compactCalls[0].onComplete({ summary: 'test', firstKeptEntryId: 'abc', tokensBefore: 1000, details: {} });
});

test('den_compact_context does not resume on compaction error', () => {
  const compactCalls = [];
  const resumeMessages = [];
  const result = requestDenContextCompaction({
    compact(options) { compactCalls.push(options); },
    ui: { notify() {} },
  }, {
    durableContextPosted: true,
    resumeAfterCompaction: true,
  }, {
    sendResumeMessage: (message) => resumeMessages.push(message),
  });

  assert.equal(result.resume_configured, true);

  // Simulate compaction failing
  compactCalls[0].onError(new Error('API quota exceeded'));
  assert.equal(resumeMessages.length, 0, 'should not send resume on error');
});

test('den_compact_context handles resume callback error gracefully', () => {
  const compactCalls = [];
  const notifications = [];
  const result = requestDenContextCompaction({
    compact(options) { compactCalls.push(options); },
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  }, {
    durableContextPosted: true,
    resumeAfterCompaction: true,
  }, {
    sendResumeMessage: () => { throw new Error('agent still streaming'); },
  });

  assert.equal(result.resume_configured, true);

  // onComplete should not throw even if sendResumeMessage throws
  compactCalls[0].onComplete({ summary: 'test', firstKeptEntryId: 'abc', tokensBefore: 1000, details: {} });
  const errorNotification = notifications.find((n) => n.level === 'error');
  assert.ok(errorNotification, 'should notify on resume failure');
  assert.match(errorNotification.message, /resume failed/);
});

test('den_compact_context handles async resume callback rejection gracefully', async () => {
  const compactCalls = [];
  const notifications = [];
  const result = requestDenContextCompaction({
    compact(options) { compactCalls.push(options); },
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  }, {
    durableContextPosted: true,
    resumeAfterCompaction: true,
  }, {
    sendResumeMessage: async () => { throw new Error('agent still streaming'); },
  });

  assert.equal(result.resume_configured, true);
  compactCalls[0].onComplete({ summary: 'test', firstKeptEntryId: 'abc', tokensBefore: 1000, details: {} });
  await new Promise((resolve) => setImmediate(resolve));
  const errorNotification = notifications.find((n) => n.level === 'error');
  assert.ok(errorNotification, 'should notify on async resume failure');
  assert.match(errorNotification.message, /resume failed/);
});

test('den_compact_context tool exposes resume_after_compaction parameter', async () => {
  const tools = [];
  denExtension({
    on() {},
    registerCommand() {},
    registerTool(definition) { tools.push(definition); },
  });
  const tool = tools.find((entry) => entry.name === 'den_compact_context');
  assert.ok(tool.parameters.properties.resume_after_compaction);
  assert.equal(tool.parameters.properties.resume_after_compaction.type, 'boolean');
  assert.match(tool.description, /fire-and-forget/);
  assert.match(tool.description, /resume_after_compaction/);
});

test('formatDenContextCompactionResult includes resume info', () => {
  const result = {
    schema: 'den_context_compaction_request',
    schema_version: 1,
    requested: true,
    status: 'requested',
    reason: 'test',
    custom_instructions: 'keep state',
    safe_point_notes: 'between tasks',
    resume_configured: true,
    resume_note: 'A follow-up prompt will be sent automatically after compaction.',
    guardrails: ['rail1'],
  };
  const formatted = formatDenContextCompactionResult(result);
  assert.match(formatted, /Resume after compaction: yes/);
  assert.match(formatted, /follow-up prompt will be sent/);
});

test('compaction guardrails mention fire-and-forget and resume semantics', () => {
  const guardrails = compactionGuardrails();
  assert.ok(guardrails.length >= 5, 'should have updated guardrails');
  const combined = guardrails.join('\n');
  assert.match(combined, /fire-and-forget/);
  assert.match(combined, /resume_after_compaction/);
  assert.match(combined, /suspended/);
  assert.match(combined, /extension\/session reloads/);
  assert.match(combined, /manually resume/);
});
