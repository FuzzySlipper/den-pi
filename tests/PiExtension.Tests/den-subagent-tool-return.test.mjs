import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { buildSubagentParentToolResult } from '../../lib/den-subagent-parent-tool-result.ts';

const piAgentRoot = process.env.PI_CODING_AGENT_ROOT
  ?? (existsSync('/home/patch/.bun/install/global/node_modules/@mariozechner/pi-coding-agent')
    ? '/home/patch/.bun/install/global/node_modules/@mariozechner/pi-coding-agent'
    : '/usr/lib/node_modules/@mariozechner/pi-coding-agent');
const piAiRoot = process.env.PI_AI_ROOT
  ?? (existsSync('/home/patch/.bun/install/global/node_modules/@mariozechner/pi-ai')
    ? '/home/patch/.bun/install/global/node_modules/@mariozechner/pi-ai'
    : `${piAgentRoot}/node_modules/@mariozechner/pi-ai`);

const { SessionManager } = await import(`${piAgentRoot}/dist/core/session-manager.js`);
const { convertToLlm } = await import(`${piAgentRoot}/dist/core/messages.js`);
const { serializeConversation } = await import(`${piAgentRoot}/dist/core/compaction/utils.js`);
const { convertResponsesMessages } = await import(`${piAiRoot}/dist/providers/openai-responses-shared.js`);

const BASE_ARTIFACTS = {
  dir: '/tmp/den-subagent-runs/run-test',
  stdout_jsonl_path: '/tmp/den-subagent-runs/run-test/stdout.jsonl',
  stderr_log_path: '/tmp/den-subagent-runs/run-test/stderr.log',
  status_json_path: '/tmp/den-subagent-runs/run-test/status.json',
  events_jsonl_path: '/tmp/den-subagent-runs/run-test/events.jsonl',
  session_dir: '/tmp/den-subagent-runs/run-test/sessions',
  session_file_path: '/tmp/den-subagent-runs/run-test/sessions/session.jsonl',
};

function subagentResult(overrides = {}) {
  return {
    run_id: 'run-test',
    role: 'coder',
    task_id: 851,
    review_round_id: undefined,
    workspace_id: undefined,
    worktree_path: undefined,
    branch: 'task/851-slim-subagent-tool-returns',
    base_branch: 'main',
    base_commit: 'base-sha',
    head_commit: 'head-sha',
    purpose: 'implementation',
    session_mode: 'fresh',
    session: undefined,
    pi_session_id: 'pi-session-test',
    pi_session_dir: BASE_ARTIFACTS.session_dir,
    pi_session_file_path: BASE_ARTIFACTS.session_file_path,
    pi_session_persisted: true,
    exit_code: 0,
    signal: undefined,
    pid: 1234,
    backend: 'pi-cli',
    started_at: '2026-04-26T00:00:00.000Z',
    ended_at: '2026-04-26T00:00:05.000Z',
    duration_ms: 5000,
    aborted: false,
    timeout_kind: undefined,
    forced_kill: false,
    final_output: 'Implemented the requested change and ran focused tests.',
    assistant_final_found: true,
    prompt_echo_detected: false,
    output_status: 'assistant_final',
    stderr: '',
    stderr_tail: '',
    model: 'openai-codex/gpt-5.5',
    message_count: 9,
    assistant_message_count: 3,
    child_error_message: undefined,
    infrastructure_failure_reason: undefined,
    infrastructure_warning_reason: undefined,
    artifacts: BASE_ARTIFACTS,
    fallback_from_model: undefined,
    fallback_from_exit_code: undefined,
    ...overrides,
  };
}

function serializedToolResult(result) {
  return JSON.stringify(result);
}

test('sub-agent parent tool return is compact for successful long final output', () => {
  const longFinal = `SUMMARY_START ${'x'.repeat(10_000)} SUMMARY_END`;
  const toolResult = buildSubagentParentToolResult(subagentResult({ final_output: longFinal }));
  const text = toolResult.content[0].text;

  assert.equal(toolResult.isError, false);
  assert.equal(toolResult.details.schema, 'den_subagent_parent_tool_result');
  assert.equal(toolResult.details.run_id, 'run-test');
  assert.equal(toolResult.details.role, 'coder');
  assert.equal(toolResult.details.task_id, 851);
  assert.equal(toolResult.details.state, 'completed');
  assert.equal(toolResult.details.final_output_truncated, true);
  assert.equal(toolResult.details.final_output_chars, longFinal.length);
  assert.match(text, /Sub-agent completed \(coder\)/);
  assert.match(text, /Final summary \(bounded parent copy\):/);
  assert.match(text, /omitted from the parent tool result/);
  assert.ok(text.length < 2_500, `tool content should stay compact, got ${text.length}`);
  assert.ok(serializedToolResult(toolResult).length < 6_000, 'details should not carry huge final output metadata');
});

test('sub-agent parent tool return omits verbose stderr and raw child transcripts', () => {
  const toolResult = buildSubagentParentToolResult(subagentResult({
    exit_code: 1,
    assistant_final_found: false,
    output_status: 'no_assistant_final',
    final_output: '',
    stderr: `VERBOSE_STDERR_SENTINEL ${'stderr '.repeat(20_000)}`,
    stderr_tail: 'STDERR_TAIL_SENTINEL should not be returned to parent context',
    child_error_message: `CHILD_ERROR_SENTINEL ${'child '.repeat(1_000)}`,
    infrastructure_failure_reason: 'child_error',
    stdout: 'RAW_STDOUT_SENTINEL should not be copied from accidental result fields',
    work_events: [{ result_preview: 'RAW_WORK_EVENT_SENTINEL should not be copied' }],
    session_transcript: 'RAW_SESSION_TRANSCRIPT_SENTINEL should not be copied',
    massive_metadata: { nested: 'MASSIVE_METADATA_SENTINEL'.repeat(5_000) },
  }));

  const serialized = serializedToolResult(toolResult);
  assert.equal(toolResult.isError, true);
  assert.equal(toolResult.details.state, 'infrastructure_failed');
  assert.equal(toolResult.details.stderr, undefined);
  assert.equal(toolResult.details.stderr_tail, undefined);
  assert.equal(toolResult.details.work_events, undefined);
  assert.equal(toolResult.details.session_transcript, undefined);
  assert.equal(toolResult.details.massive_metadata, undefined);
  assert.ok(toolResult.details.child_error_truncated, 'child error preview should be bounded');
  assert.match(toolResult.content[0].text, /Failure summary \(bounded parent copy\):/);
  assert.match(toolResult.content[0].text, /CHILD_ERROR_SENTINEL/);
  assert.doesNotMatch(serialized, /VERBOSE_STDERR_SENTINEL/);
  assert.doesNotMatch(serialized, /STDERR_TAIL_SENTINEL/);
  assert.doesNotMatch(serialized, /RAW_STDOUT_SENTINEL/);
  assert.doesNotMatch(serialized, /RAW_WORK_EVENT_SENTINEL/);
  assert.doesNotMatch(serialized, /RAW_SESSION_TRANSCRIPT_SENTINEL/);
  assert.doesNotMatch(serialized, /MASSIVE_METADATA_SENTINEL/);
  assert.ok(serialized.length < 7_000, `tool result should stay bounded, got ${serialized.length}`);
});

test('sub-agent parent tool return keeps artifact paths without artifact contents', () => {
  const toolResult = buildSubagentParentToolResult(subagentResult({
    artifacts: {
      ...BASE_ARTIFACTS,
      dir: '/tmp/den-subagent-runs/artifact-heavy',
      stdout_jsonl_path: '/tmp/den-subagent-runs/artifact-heavy/stdout.jsonl',
      stderr_log_path: '/tmp/den-subagent-runs/artifact-heavy/stderr.log',
      status_json_path: '/tmp/den-subagent-runs/artifact-heavy/status.json',
      events_jsonl_path: '/tmp/den-subagent-runs/artifact-heavy/events.jsonl',
      session_dir: '/tmp/den-subagent-runs/artifact-heavy/sessions',
      session_file_path: '/tmp/den-subagent-runs/artifact-heavy/sessions/session.jsonl',
      stdout_jsonl_content: 'RAW_ARTIFACT_STDOUT_CONTENT_SENTINEL',
      events_jsonl_content: 'RAW_ARTIFACT_WORK_EVENT_CONTENT_SENTINEL',
    },
  }));

  assert.equal(toolResult.details.artifacts.dir, '/tmp/den-subagent-runs/artifact-heavy');
  assert.equal(toolResult.details.artifacts.events_jsonl_path, '/tmp/den-subagent-runs/artifact-heavy/events.jsonl');
  assert.equal(toolResult.details.artifacts.session_file_path, '/tmp/den-subagent-runs/artifact-heavy/sessions/session.jsonl');
  const serialized = serializedToolResult(toolResult);
  assert.doesNotMatch(serialized, /RAW_ARTIFACT_STDOUT_CONTENT_SENTINEL/);
  assert.doesNotMatch(serialized, /RAW_ARTIFACT_WORK_EVENT_CONTENT_SENTINEL/);
});

test('sub-agent parent tool return includes recovery guidance for aborted coder run with branch state', () => {
  const toolResult = buildSubagentParentToolResult(subagentResult({
    exit_code: 143,
    signal: 'SIGTERM',
    aborted: true,
    assistant_final_found: false,
    output_status: 'no_assistant_final',
    final_output: '',
    final_head_commit: 'abc123def456789',
    final_head_status: 'dirty_uncommitted',
    final_head_source: 'supplied_branch',
    final_branch: 'task/1078-subagent-abort-recovery',
    final_worktree_branch: 'task/1078-subagent-abort-recovery',
    final_branch_matches_worktree: true,
    final_worktree_status: 'dirty_uncommitted',
    final_worktree_status_short: ' M pi-dev/lib/example.ts',
  }));

  assert.equal(toolResult.isError, true);
  // aborted → classifySubagentInfrastructureFailure returns 'aborted' → infrastructure_failed
  assert.equal(toolResult.details.state, 'infrastructure_failed');
  assert.equal(toolResult.details.aborted, true);

  // Recovery guidance fields present in details
  assert.ok(toolResult.details.recovery_guidance, 'should have recovery_guidance');
  assert.equal(toolResult.details.recovery_branch, 'task/1078-subagent-abort-recovery');
  assert.equal(toolResult.details.recovery_head_commit, 'abc123def456789');
  assert.equal(toolResult.details.recovery_worktree_dirty, true);
  assert.ok(Array.isArray(toolResult.details.recovery_actions), 'should have recovery_actions array');
  assert.ok(toolResult.details.recovery_actions.length > 0, 'should have at least one recovery action');

  // Text output includes recovery guidance
  const text = toolResult.content[0].text;
  assert.match(text, /Recovery guidance:/);
  assert.match(text, /Sub-agent was aborted/);
  assert.equal((text.match(/Sub-agent was aborted/g) ?? []).length, 1, 'failure summary should not be duplicated in recovery guidance');
  assert.doesNotMatch(toolResult.details.recovery_guidance, /Sub-agent was aborted/);
  assert.match(text, /Branch: task\/1078-subagent-abort-recovery/);
  assert.match(text, /Worktree: dirty/);
  assert.match(text, /do NOT auto-reset or delete the branch/);
  assert.match(text, /artifacts/);

  // Verify artifact path is referenced
  assert.match(text, new RegExp(BASE_ARTIFACTS.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('sub-agent parent tool return includes recovery guidance for failed coder run with clean branch', () => {
  const toolResult = buildSubagentParentToolResult(subagentResult({
    exit_code: 1,
    aborted: false,
    assistant_final_found: false,
    output_status: 'no_assistant_final',
    final_output: '',
    final_head_commit: 'deadbeef12345678',
    final_head_status: 'clean',
    final_head_source: 'supplied_branch',
    final_branch: 'task/1078-test',
    final_worktree_branch: 'task/1078-test',
    final_branch_matches_worktree: true,
    final_worktree_status: 'clean',
    final_worktree_status_short: undefined,
    child_error_message: 'Process crashed with unhandled exception',
  }));

  assert.equal(toolResult.isError, true);
  // child_error_message → classifySubagentInfrastructureFailure returns 'child_error' → infrastructure_failed
  assert.equal(toolResult.details.state, 'infrastructure_failed');

  // Recovery guidance present
  assert.ok(toolResult.details.recovery_guidance, 'should have recovery_guidance');
  assert.equal(toolResult.details.recovery_branch, 'task/1078-test');
  assert.equal(toolResult.details.recovery_head_commit, 'deadbeef12345678');
  assert.equal(toolResult.details.recovery_worktree_dirty, false);

  const text = toolResult.content[0].text;
  assert.match(text, /Recovery guidance:/);
  assert.match(text, /Worktree: clean/);
  assert.match(text, /Branch: task\/1078-test/);
  assert.match(text, /Head: deadbeef12345678/);
});

test('sub-agent parent tool return omits recovery guidance for successful run', () => {
  const toolResult = buildSubagentParentToolResult(subagentResult());

  assert.equal(toolResult.isError, false);
  assert.equal(toolResult.details.recovery_guidance, undefined);
  assert.equal(toolResult.details.recovery_actions, undefined);

  const text = toolResult.content[0].text;
  assert.doesNotMatch(text, /Recovery guidance:/);
});

test('sub-agent parent tool return omits recovery guidance when no branch state is available', () => {
  const toolResult = buildSubagentParentToolResult(subagentResult({
    exit_code: 1,
    aborted: true,
    assistant_final_found: false,
    output_status: 'no_assistant_final',
    final_output: '',
    // No final_head_commit, no final_branch, no final_worktree_status
    final_head_commit: undefined,
    final_head_status: undefined,
    final_branch: undefined,
    final_worktree_branch: undefined,
    final_worktree_status: undefined,
  }));

  assert.equal(toolResult.isError, true);
  assert.equal(toolResult.details.recovery_guidance, undefined);
  assert.equal(toolResult.details.recovery_actions, undefined);

  const text = toolResult.content[0].text;
  assert.doesNotMatch(text, /Recovery guidance:/);
});

test('sub-agent parent tool return recovery guidance for abort with partial assistant output', () => {
  const toolResult = buildSubagentParentToolResult(subagentResult({
    exit_code: 143,
    signal: 'SIGTERM',
    aborted: true,
    assistant_final_found: true,
    output_status: 'assistant_final',
    final_output: 'Partial implementation: added recovery helper but tests not yet run.',
    final_head_commit: 'cafe0123456789',
    final_head_status: 'dirty_uncommitted',
    final_branch: 'task/1078-test',
    final_worktree_branch: 'task/1078-test',
    final_worktree_status: 'dirty_uncommitted',
  }));

  assert.equal(toolResult.isError, true);

  const text = toolResult.content[0].text;
  assert.match(text, /Recovery guidance:/);
  // With assistant_final_found, guidance should say "partial work and commits"
  assert.match(text, /partial work and commits/);
  assert.match(text, /continue manually or rerun/);
});

test('sub-agent parent tool return shows requested head distinct from final head in text', () => {
  const toolResult = buildSubagentParentToolResult(subagentResult({
    head_commit: 'launch-sha-abc123',
    requested_head_commit: 'launch-sha-abc123',
    final_head_commit: 'final-sha-def456',
    final_head_status: 'clean',
    final_head_source: 'supplied_branch',
    final_branch: 'task/851-slim-subagent-tool-returns',
    final_worktree_branch: 'task/851-slim-subagent-tool-returns',
    final_branch_matches_worktree: true,
    final_worktree_status: 'clean',
  }));

  const text = toolResult.content[0].text;
  assert.match(text, /Final branch head: final-sha-def456/);
  assert.match(text, /Requested \(starting\) head: launch-sha-abc123/);
  assert.equal(toolResult.details.requested_head_commit, 'launch-sha-abc123');
  assert.equal(toolResult.details.final_head_commit, 'final-sha-def456');
  assert.equal(toolResult.isError, false);
});

test('sub-agent parent tool return omits requested head line when it matches final head', () => {
  const toolResult = buildSubagentParentToolResult(subagentResult({
    head_commit: 'same-sha',
    requested_head_commit: 'same-sha',
    final_head_commit: 'same-sha',
    final_head_status: 'clean',
    final_head_source: 'supplied_branch',
    final_branch: 'task/851',
    final_worktree_branch: 'task/851',
    final_branch_matches_worktree: true,
    final_worktree_status: 'clean',
  }));

  const text = toolResult.content[0].text;
  assert.match(text, /Final branch head: same-sha/);
  assert.doesNotMatch(text, /Requested \(starting\) head/);
  assert.equal(toolResult.details.requested_head_commit, 'same-sha');
  assert.equal(toolResult.details.final_head_commit, 'same-sha');
});

test('sub-agent parent tool return includes quota-specific recovery guidance for clean worktree', () => {
  const toolResult = buildSubagentParentToolResult(subagentResult({
    exit_code: 1,
    aborted: false,
    assistant_final_found: false,
    output_status: 'no_assistant_final',
    final_output: '',
    final_head_commit: 'deadbeef12345678',
    final_head_status: 'clean',
    final_branch: 'task/1125-quota-test',
    final_worktree_branch: 'task/1125-quota-test',
    final_worktree_status: 'clean',
    infrastructure_failure_reason: 'quota',
    child_error_message: '429 Too Many Requests - quota exceeded for model gpt-5.5',
  }));

  assert.equal(toolResult.isError, true);
  assert.equal(toolResult.details.state, 'infrastructure_failed');
  assert.equal(toolResult.details.infrastructure_failure_reason, 'quota');

  // Recovery guidance present
  assert.ok(toolResult.details.recovery_guidance, 'should have recovery_guidance');
  assert.equal(toolResult.details.recovery_branch, 'task/1125-quota-test');
  assert.equal(toolResult.details.recovery_worktree_dirty, false);

  const text = toolResult.content[0].text;
  assert.match(text, /Recovery guidance:/);
  assert.match(text, /Quota\/provider-limit failure/);
  assert.match(text, /No dirty partial work detected/);
  assert.match(text, /alternate model is configured/);
  assert.match(text, /rerun `den_run_coder` with `model=/);
  assert.match(text, /Record the retry decision/);

  // Failure summary should mention quota
  assert.match(text, /Sub-agent infrastructure failure: quota\/provider-limit exceeded/);
  // Infrastructure failure reason appears in text
  assert.match(text, /429 Too Many Requests/);
});

test('sub-agent parent tool return includes quota-specific recovery guidance for dirty worktree', () => {
  const toolResult = buildSubagentParentToolResult(subagentResult({
    exit_code: 1,
    aborted: false,
    assistant_final_found: false,
    output_status: 'no_assistant_final',
    final_output: '',
    final_head_commit: 'abc123def456789',
    final_head_status: 'dirty_uncommitted',
    final_branch: 'task/1125-quota-dirty',
    final_worktree_branch: 'task/1125-quota-dirty',
    final_worktree_status: 'dirty_uncommitted',
    final_worktree_status_short: ' M pi-dev/lib/example.ts',
    infrastructure_failure_reason: 'quota',
    child_error_message: 'rate limit exceeded for model gpt-4o',
  }));

  assert.equal(toolResult.isError, true);
  assert.equal(toolResult.details.state, 'infrastructure_failed');
  assert.equal(toolResult.details.infrastructure_failure_reason, 'quota');

  // Recovery guidance present
  assert.ok(toolResult.details.recovery_guidance, 'should have recovery_guidance');
  assert.equal(toolResult.details.recovery_worktree_dirty, true);

  const text = toolResult.content[0].text;
  assert.match(text, /Recovery guidance:/);
  assert.match(text, /Worktree has uncommitted dirty partial work/);
  assert.match(text, /Option A:/);
  assert.match(text, /Option B:/);
  assert.match(text, /Option C:/);
  assert.match(text, /rerun coder from this branch/);
  assert.match(text, /alternate model/);
  assert.match(text, /sub-agent-unavailable exception/);
  assert.match(text, /Do NOT auto-discard dirty work/);
  assert.match(text, /Record the chosen recovery path/);
  assert.doesNotMatch(text, /No dirty partial work detected/);
});

test('sub-agent parent tool return classifies quota failure from child_error_message with 429 pattern', () => {
  const toolResult = buildSubagentParentToolResult(subagentResult({
    exit_code: 1,
    aborted: false,
    assistant_final_found: false,
    output_status: 'no_assistant_final',
    final_output: '',
    final_head_commit: 'abc123',
    final_head_status: 'clean',
    final_branch: 'task/quota-429',
    final_worktree_branch: 'task/quota-429',
    final_worktree_status: 'clean',
    infrastructure_failure_reason: 'quota',
    child_error_message: 'Provider returned 429 - too many requests',
  }));

  assert.equal(toolResult.details.state, 'infrastructure_failed');
  assert.equal(toolResult.details.infrastructure_failure_reason, 'quota');

  const text = toolResult.content[0].text;
  assert.match(text, /Recovery guidance:/);
  assert.match(text, /too many requests/);
});

test('sub-agent parent tool return recovery guidance for quota failure preserves assistant output', () => {
  const toolResult = buildSubagentParentToolResult(subagentResult({
    exit_code: 143,
    signal: 'SIGTERM',
    aborted: false,
    assistant_final_found: true,
    output_status: 'assistant_final',
    final_output: 'Partial implementation: added recovery helper but not yet complete.',
    final_head_commit: 'cafe0123456789',
    final_head_status: 'dirty_uncommitted',
    final_branch: 'task/1125-quota-partial',
    final_worktree_branch: 'task/1125-quota-partial',
    final_worktree_status: 'dirty_uncommitted',
    infrastructure_failure_reason: 'quota',
    child_error_message: 'Usage quota exceeded for model',
  }));

  const text = toolResult.content[0].text;
  assert.match(text, /Recovery guidance:/);
  // Quota-specific guidance takes priority; assistant_final_found also applies
  assert.match(text, /quota/i);
  assert.match(text, /Worktree has uncommitted dirty partial work/);
  // Should NOT show generic assistant_final guidance for quota
  assert.match(text, /Option A:/);
  assert.doesNotMatch(text, /do NOT auto-reset or delete the branch/);
});

test('Pi parent session stores tool-result details, while compaction/provider payloads use content only', () => {
  const sentinel = 'DETAILS_SENTINEL_SHOULD_NOT_REACH_PROVIDER_PAYLOAD';
  const toolMessage = {
    role: 'toolResult',
    toolCallId: 'call_1|fc_1',
    toolName: 'den_run_subagent',
    content: [{ type: 'text', text: 'VISIBLE_PARENT_TOOL_CONTENT' }],
    details: { sentinel, nested: { stderr: 'VERBOSE_DETAILS_STDERR' } },
    isError: false,
    timestamp: Date.now(),
  };

  const session = SessionManager.inMemory('/repo');
  session.appendMessage(toolMessage);
  const parentContext = session.buildSessionContext();
  assert.equal(parentContext.messages[0].details.sentinel, sentinel, 'Pi session context retains tool-result details');

  const llmMessages = convertToLlm(parentContext.messages);
  assert.equal(llmMessages[0].details.sentinel, sentinel, 'Pi convertToLlm passes tool-result details through to provider adapters');

  const compacted = serializeConversation(llmMessages);
  assert.match(compacted, /VISIBLE_PARENT_TOOL_CONTENT/);
  assert.doesNotMatch(compacted, new RegExp(sentinel));

  const model = {
    id: 'gpt-test',
    name: 'gpt-test',
    api: 'openai-responses',
    provider: 'openai',
    input: ['text'],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
  const providerPayload = convertResponsesMessages(model, { messages: llmMessages }, new Set(['openai']), {});
  const providerPayloadText = JSON.stringify(providerPayload);
  assert.match(providerPayloadText, /VISIBLE_PARENT_TOOL_CONTENT/);
  assert.doesNotMatch(providerPayloadText, new RegExp(sentinel));
  assert.doesNotMatch(providerPayloadText, /VERBOSE_DETAILS_STDERR/);
});
