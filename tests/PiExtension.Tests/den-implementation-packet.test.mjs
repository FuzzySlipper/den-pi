import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractImplementationPacket,
  validatePacket,
  formatImplementationPacketMessage,
  buildImplementationPacketMeta,
  findDuplicateImplementationPacketMessage,
  detectIncompleteCoderPrompt,
  formatPacketMissingNoticeMessage,
  buildPacketMissingNoticeMeta,
  REQUIRED_FIELDS,
} from '../../lib/den-implementation-packet.ts';
import { buildSubagentRunMetadata } from '../../lib/den-subagent-pipeline.ts';

// ---------------------------------------------------------------------------
// Sample coder output fixtures
// ---------------------------------------------------------------------------

const COMPLETE_CODER_OUTPUT = `
# Implementation Summary

## Branch and head commit

Branch: \`task/123-add-feature\`
Head commit: \`abc123def456\`

## Summary of what changed

Added a new helper module for parsing markdown sections. The module provides
a forgiving parser that extracts structured data from free-form coder output.

## Files changed

- \`pi-dev/lib/den-implementation-packet.ts\`
- \`pi-dev/extensions/den-subagent.ts\`
- \`tests/PiExtension.Tests/den-implementation-packet.test.mjs\`

## Tests run with pass/fail/skip results

Ran \`node --test tests/PiExtension.Tests/den-implementation-packet.test.mjs\`.
All 12 tests passed (12 pass, 0 fail, 0 skip).

## Acceptance checklist with evidence

- ✅ Packet extraction works on sample coder output — verified by unit tests.
- ✅ Packet posted to Den task thread — integration verified manually.
- ✅ Partial packets produce clear warnings — tested below.
- ✅ Reviewer can find packet — metadata.type is \`implementation_packet\`.

## Known gaps / open questions

- Does not handle reviewer runs (out of scope).
- Deduplication of coder-self-posted packets is a known gap.

## Risk notes for reviewer attention

- The parser is regex-based; unusual heading formats may not be extracted.
  Missing fields produce a \`partial\` completeness flag.
`;

const PARTIAL_CODER_OUTPUT = `
# Implementation

## Summary

Made some changes to the config loader.

## Files changed

- \`src/config.ts\`
`;

const EMPTY_OUTPUT = ``;

const MINIMAL_COMPLETE_OUTPUT = `
## Branch

\`main\`

## Head commit

\`deadbeef\`

## Summary

Fixed a typo.

## Files changed

- README.md

## Tests run

All tests pass.

## Acceptance checklist

- [x] Typo fixed

## Known gaps

None.

## Risk notes

Low risk.
`;

// ---------------------------------------------------------------------------
// extractImplementationPacket
// ---------------------------------------------------------------------------

test('extractImplementationPacket extracts a complete packet from sample output', () => {
  const result = extractImplementationPacket(COMPLETE_CODER_OUTPUT);

  assert.equal(result.completeness, 'complete');
  assert.equal(result.missing_fields.length, 0);
  assert.equal(result.packet.branch, 'task/123-add-feature');
  assert.equal(result.packet.head_commit, 'abc123def456');
  assert.ok(result.packet.summary?.includes('parsing markdown sections'));
  assert.ok(Array.isArray(result.packet.files_changed));
  assert.equal(result.packet.files_changed?.length, 3);
  assert.ok(result.packet.tests_run?.includes('12 tests passed'));
  assert.ok(result.packet.acceptance_checklist?.includes('Packet extraction works'));
  assert.ok(result.packet.known_gaps?.includes('Deduplication'));
  assert.ok(result.packet.risk_notes?.includes('regex-based'));
});

test('extractImplementationPacket returns partial for incomplete output', () => {
  const result = extractImplementationPacket(PARTIAL_CODER_OUTPUT);

  assert.equal(result.completeness, 'partial');
  assert.ok(result.missing_fields.length > 0);
  assert.ok(result.missing_fields.includes('branch'));
  assert.ok(result.missing_fields.includes('head_commit'));
  assert.ok(result.missing_fields.includes('tests_run'));
  assert.ok(result.missing_fields.includes('acceptance_checklist'));
  assert.ok(result.missing_fields.includes('known_gaps'));
  assert.ok(result.missing_fields.includes('risk_notes'));
  assert.ok(result.packet.summary?.includes('config loader'));
  assert.ok(Array.isArray(result.packet.files_changed));
  assert.equal(result.packet.files_changed?.length, 1);
});

test('extractImplementationPacket handles empty output', () => {
  const result = extractImplementationPacket(EMPTY_OUTPUT);

  assert.equal(result.completeness, 'partial');
  // All required fields missing
  for (const field of REQUIRED_FIELDS) {
    assert.ok(result.missing_fields.includes(field), `Expected ${field} to be missing`);
  }
});

test('extractImplementationPacket extracts minimal complete output', () => {
  const result = extractImplementationPacket(MINIMAL_COMPLETE_OUTPUT);

  assert.equal(result.completeness, 'complete');
  assert.equal(result.missing_fields.length, 0);
  assert.equal(result.packet.branch, 'main');
  assert.equal(result.packet.head_commit, 'deadbeef');
  assert.equal(result.packet.summary, 'Fixed a typo.');
});

test('extractImplementationPacket extracts branch from inline on-branch pattern', () => {
  const output = `
Work completed on branch \`task/456-fix-bug\`.
Head commit is \`a1b2c3d4e5f6\`.
`;
  const result = extractImplementationPacket(output);
  // "on branch \`...\`" must be extracted by the inline fallback pattern.
  assert.equal(result.packet.branch, 'task/456-fix-bug');
  // "Head commit is" does not match the inline patterns (they require
  // "head commit:" or "commit \`...\`"). This is expected — inline
  // extraction is best-effort for known prompt patterns.
  assert.equal(result.packet.head_commit, undefined);
});

test('extractImplementationPacket extracts head_commit from inline commit pattern', () => {
  const output = 'Commit \`deadbeef12345678\` pushed to branch \`main\` on branch \`task/fix\`.';
  const result = extractImplementationPacket(output);
  assert.equal(result.packet.head_commit, 'deadbeef12345678');
  // "on branch \`task/fix\`" matches; plain "branch \`main\`" does not.
  assert.equal(result.packet.branch, 'task/fix');
});

test('extractImplementationPacket extracts branch from heading line without backticks', () => {
  const output = `
## Branch: task/949-heading-fields

## Head Commit
abcdef1234567890
`;
  const result = extractImplementationPacket(output);
  assert.equal(result.packet.branch, 'task/949-heading-fields');
  assert.equal(result.packet.head_commit, 'abcdef1234567890');
});

test('extractImplementationPacket extracts safe commit heading-line forms without backticks', () => {
  const headCommitOutput = `
## Branch
main

## Head Commit: abcdef1234567890
`;
  assert.equal(extractImplementationPacket(headCommitOutput).packet.head_commit, 'abcdef1234567890');

  const commitAliasOutput = `
## Branch
main

## Commit: 1234567890abcdef
`;
  assert.equal(extractImplementationPacket(commitAliasOutput).packet.head_commit, '1234567890abcdef');
});

test('extractImplementationPacket ignores unsafe heading-line branch and commit values', () => {
  const output = `
## Branch: not a branch sentence

## Commit: not-a-commit
`;
  const result = extractImplementationPacket(output);
  assert.equal(result.packet.branch, undefined);
  assert.equal(result.packet.head_commit, undefined);

  const sentinelResult = extractImplementationPacket('## Branch: not');
  assert.equal(sentinelResult.packet.branch, undefined);
});

test('extractImplementationPacket returns undefined branch/commit when no inline patterns match', () => {
  const output = `
Done. No branch or commit info here.
`;
  const result = extractImplementationPacket(output);
  assert.equal(result.packet.branch, undefined);
  assert.equal(result.packet.head_commit, undefined);
});

// ---------------------------------------------------------------------------
// validatePacket
// ---------------------------------------------------------------------------

test('validatePacket returns complete for a fully populated packet', () => {
  const packet = {
    branch: 'main',
    head_commit: 'abc123',
    summary: 'Did things.',
    files_changed: ['a.ts'],
    tests_run: 'All pass.',
    acceptance_checklist: '- [x] Done',
    known_gaps: 'None.',
    risk_notes: 'Low.',
  };
  const result = validatePacket(packet);
  assert.equal(result.completeness, 'complete');
  assert.equal(result.missing_fields.length, 0);
});

test('validatePacket returns partial when required fields are missing', () => {
  const result = validatePacket({ summary: 'Partial.' });
  assert.equal(result.completeness, 'partial');
  assert.ok(result.missing_fields.includes('branch'));
  assert.ok(result.missing_fields.includes('head_commit'));
  assert.ok(result.missing_fields.includes('files_changed'));
});

test('validatePacket treats empty string as missing', () => {
  const result = validatePacket({ branch: '', head_commit: 'abc', summary: 's', files_changed: ['f'], tests_run: 't', acceptance_checklist: 'a', known_gaps: 'k', risk_notes: 'r' });
  assert.equal(result.completeness, 'partial');
  assert.ok(result.missing_fields.includes('branch'));
});

test('validatePacket treats empty array as missing', () => {
  const result = validatePacket({ branch: 'b', head_commit: 'abc', summary: 's', files_changed: [], tests_run: 't', acceptance_checklist: 'a', known_gaps: 'k', risk_notes: 'r' });
  assert.equal(result.completeness, 'partial');
  assert.ok(result.missing_fields.includes('files_changed'));
});

// ---------------------------------------------------------------------------
// formatImplementationPacketMessage
// ---------------------------------------------------------------------------

test('formatImplementationPacketMessage produces markdown with all sections', () => {
  const extraction = extractImplementationPacket(COMPLETE_CODER_OUTPUT);
  const msg = formatImplementationPacketMessage(
    { run_id: 'run1', role: 'coder', task_id: 940, purpose: 'implementation' },
    extraction,
  );
  assert.ok(msg.includes('# Implementation Packet'));
  assert.ok(msg.includes('**Completeness:** complete'));
  assert.ok(msg.includes('## Branch'));
  assert.ok(msg.includes('task/123-add-feature'));
  assert.ok(msg.includes('## Head Commit'));
  assert.ok(msg.includes('abc123def456'));
  assert.ok(msg.includes('## Summary'));
  assert.ok(msg.includes('## Files Changed'));
  assert.ok(msg.includes('## Tests Run'));
  assert.ok(msg.includes('## Acceptance Checklist'));
  assert.ok(msg.includes('## Known Gaps'));
  assert.ok(msg.includes('## Risk Notes'));
  // No warning for complete packet
  assert.ok(!msg.includes('⚠️'));
});

test('formatImplementationPacketMessage includes drift warning for partial packets', () => {
  const extraction = extractImplementationPacket(PARTIAL_CODER_OUTPUT);
  const msg = formatImplementationPacketMessage(
    { run_id: 'run2', role: 'coder', task_id: 940, purpose: 'implementation' },
    extraction,
  );
  assert.ok(msg.includes('**Completeness:** partial'));
  assert.ok(msg.includes('⚠️'));
  assert.ok(msg.includes('Missing fields:'));
});

test('formatImplementationPacketMessage handles empty extraction gracefully', () => {
  const extraction = extractImplementationPacket('');
  const msg = formatImplementationPacketMessage(
    { run_id: 'run3', role: 'coder', task_id: 940 },
    extraction,
  );
  assert.ok(msg.includes('# Implementation Packet'));
  assert.ok(msg.includes('**Completeness:** partial'));
  assert.ok(msg.includes('⚠️'));
});

// ---------------------------------------------------------------------------
// buildImplementationPacketMeta
// ---------------------------------------------------------------------------

test('buildImplementationPacketMeta produces correct metadata', () => {
  const extraction = extractImplementationPacket(COMPLETE_CODER_OUTPUT);
  const meta = buildImplementationPacketMeta(
    { run_id: 'run1', role: 'coder', task_id: 940, purpose: 'implementation' },
    extraction,
  );
  assert.equal(meta.type, 'implementation_packet');
  assert.equal(meta.prepared_by, 'coder_run');
  assert.equal(meta.workflow, 'expanded_isolation_with_context');
  assert.equal(meta.version, 1);
  assert.equal(meta.packet_completeness, 'complete');
  assert.deepEqual(meta.packet_missing_fields, []);
  assert.equal(meta.run_id, 'run1');
  assert.equal(meta.role, 'coder');
  assert.equal(meta.task_id, 940);
  assert.equal(meta.branch, 'task/123-add-feature');
  assert.equal(meta.head_commit, 'abc123def456');
  assert.equal(meta.purpose, 'implementation');
});

test('buildImplementationPacketMeta reflects partial completeness', () => {
  const extraction = extractImplementationPacket(PARTIAL_CODER_OUTPUT);
  const meta = buildImplementationPacketMeta(
    { run_id: 'run2', role: 'coder', task_id: 940 },
    extraction,
  );
  assert.equal(meta.type, 'implementation_packet');
  assert.equal(meta.packet_completeness, 'partial');
  assert.ok(meta.packet_missing_fields.length > 0);
  assert.ok(meta.packet_missing_fields.includes('branch'));
});

test('buildImplementationPacketMeta falls back to result branch/head_commit', () => {
  const extraction = extractImplementationPacket('no structured output');
  const meta = buildImplementationPacketMeta(
    { run_id: 'run3', role: 'coder', task_id: 940, branch: 'fallback-branch', head_commit: 'fallback123' },
    extraction,
  );
  assert.equal(meta.branch, 'fallback-branch');
  assert.equal(meta.head_commit, 'fallback123');
});

test('buildImplementationPacketMeta handles null task_id', () => {
  const extraction = extractImplementationPacket('');
  const meta = buildImplementationPacketMeta(
    { run_id: 'run4', role: 'coder' },
    extraction,
  );
  assert.equal(meta.task_id, null);
});

test('buildImplementationPacketMeta prefers final head commit over launch head fallback', () => {
  const extraction = extractImplementationPacket('no structured output');
  const meta = buildImplementationPacketMeta(
    { run_id: 'run5', role: 'coder', head_commit: 'launch123', final_head_commit: 'final456' },
    extraction,
  );
  assert.equal(meta.head_commit, 'final456');
});

test('buildImplementationPacketMeta includes requested_head_commit distinct from final head', () => {
  const extraction = extractImplementationPacket('no structured output');
  const meta = buildImplementationPacketMeta(
    { run_id: 'run6', role: 'coder', head_commit: 'launch-sha', final_head_commit: 'final-sha', requested_head_commit: 'launch-sha' },
    extraction,
  );
  // head_commit prefers final
  assert.equal(meta.head_commit, 'final-sha');
  // requested_head_commit preserves the starting head
  assert.equal(meta.requested_head_commit, 'launch-sha');
});

test('buildImplementationPacketMeta falls back requested_head_commit to head_commit when not explicit', () => {
  const extraction = extractImplementationPacket('no structured output');
  const meta = buildImplementationPacketMeta(
    { run_id: 'run7', role: 'coder', head_commit: 'launch-sha' },
    extraction,
  );
  assert.equal(meta.requested_head_commit, 'launch-sha');
});

// ---------------------------------------------------------------------------
// findDuplicateImplementationPacketMessage
// ---------------------------------------------------------------------------

test('findDuplicateImplementationPacketMessage handles empty and malformed message inputs', () => {
  assert.equal(findDuplicateImplementationPacketMessage([], {
    run_id: 'auto-run',
    task_id: 940,
    branch: 'task/940',
    head_commit: 'abc1234',
  }), undefined);

  assert.equal(findDuplicateImplementationPacketMessage([
    { id: 1, task_id: 940 },
    { id: 2, task_id: 940, metadata: null },
    { id: 3, task_id: 940, metadata: '{not json' },
  ], {
    run_id: 'auto-run',
    task_id: 940,
    branch: 'task/940',
    head_commit: 'abc1234',
  }), undefined);
});

test('findDuplicateImplementationPacketMessage prefers exact run id matches', () => {
  const messages = [
    { id: 1, task_id: 940, metadata: { type: 'implementation_packet', run_id: 'older-run', branch: 'task/a', head_commit: 'abc1234' } },
    { id: 2, task_id: 940, metadata: { type: 'implementation_packet', run_id: 'manual-run', branch: 'task/b', head_commit: 'def5678' } },
  ];

  const duplicate = findDuplicateImplementationPacketMessage(messages, {
    run_id: 'manual-run',
    task_id: 940,
    branch: 'task/c',
    head_commit: '9999999',
  });

  assert.equal(duplicate?.id, 2);
});

test('findDuplicateImplementationPacketMessage matches same task head and branch for manual packets', () => {
  const messages = [
    { id: 9, task_id: 940, metadata: JSON.stringify({ type: 'implementation_packet', prepared_by: 'coder', branch: 'task/940', head_commit: 'abc1234' }) },
    { id: 10, task_id: 941, metadata: { type: 'implementation_packet', branch: 'task/940', head_commit: 'abc1234' } },
    { id: 11, task_id: 940, metadata: { type: 'review_request_packet', branch: 'task/940', head_commit: 'abc1234' } },
    { id: 12, task_id: 940, metadata: { type: 'implementation_packet', prepared_by: 'coder', branch: 'task/940', head_commit: 'abc1234' } },
  ];

  const duplicate = findDuplicateImplementationPacketMessage(messages, {
    run_id: 'auto-run',
    task_id: 940,
    branch: 'task/940',
    head_commit: 'abc1234',
  });

  assert.equal(duplicate?.id, 12);
});

test('findDuplicateImplementationPacketMessage matches manual packets by final resolved head when launch head is stale', () => {
  const messages = [
    { id: 20, task_id: 951, metadata: { type: 'implementation_packet', branch: 'task/951', head_commit: 'final999' } },
    { id: 19, task_id: 951, metadata: { type: 'implementation_packet', branch: 'task/951', head_commit: 'launch111', final_head_commit: 'final999' } },
  ];

  const duplicate = findDuplicateImplementationPacketMessage(messages, {
    run_id: 'auto-run',
    task_id: 951,
    branch: 'task/951',
    head_commit: 'launch111',
    final_head_commit: 'final999',
  });

  assert.equal(duplicate?.id, 20);
});

test('findDuplicateImplementationPacketMessage does not match different branch for same head', () => {
  const messages = [
    { id: 1, task_id: 940, metadata: { type: 'implementation_packet', branch: 'task/other', head_commit: 'abc1234' } },
  ];

  const duplicate = findDuplicateImplementationPacketMessage(messages, {
    run_id: 'auto-run',
    task_id: 940,
    branch: 'task/940',
    head_commit: 'abc1234',
  });

  assert.equal(duplicate, undefined);
});

// ---------------------------------------------------------------------------
// REQUIRED_FIELDS constant
// ---------------------------------------------------------------------------

test('REQUIRED_FIELDS contains all expected fields', () => {
  assert.deepEqual([...REQUIRED_FIELDS], [
    'branch',
    'head_commit',
    'summary',
    'files_changed',
    'tests_run',
    'acceptance_checklist',
    'known_gaps',
    'risk_notes',
  ]);
});

// ---------------------------------------------------------------------------
// Heading flexibility
// ---------------------------------------------------------------------------

test('extractImplementationPacket matches headings at various markdown levels', () => {
  const output = `
# Branch
main

## Head Commit
abc1234

### Summary
Did things.

#### Files Changed
- a.ts

##### Tests Run
All pass.

###### Acceptance Checklist
All checked.

## Known Gaps
None.

### Risk Notes
Low risk.
`;
  const result = extractImplementationPacket(output);
  assert.equal(result.completeness, 'complete');
  assert.equal(result.packet.branch, 'main');
  assert.equal(result.packet.head_commit, 'abc1234');
});

test('extractImplementationPacket handles combined branch+commit heading', () => {
  const output = `
## Branch and Head Commit

Branch: \`feature/x\`
Commit: \`abcdef12\`

## Summary
Changes.

## Files Changed
- a.ts

## Tests Run
All pass.

## Acceptance Checklist
Done.

## Known Gaps
None.

## Risk Notes
Low.
`;
  const result = extractImplementationPacket(output);
  assert.equal(result.completeness, 'complete');
  assert.equal(result.packet.branch, 'feature/x');
  assert.equal(result.packet.head_commit, 'abcdef12');
});

test('extractImplementationPacket handles artifact links section', () => {
  const output = `
## Branch
main

## Head Commit
abc123

## Summary
Summary.

## Files Changed
- a.ts

## Tests Run
All pass.

## Acceptance Checklist
Done.

## Known Gaps
None.

## Risk Notes
None.

## Artifact Links
- https://example.com/build/123
- https://example.com/logs/456
`;
  const result = extractImplementationPacket(output);
  assert.equal(result.completeness, 'complete');
  assert.ok(Array.isArray(result.packet.artifact_links));
  assert.equal(result.packet.artifact_links?.length, 2);
  assert.ok(result.packet.artifact_links?.[0]?.includes('example.com/build'));
});

// ---------------------------------------------------------------------------
// Regression: packetMeta branch/head_commit must not be overwritten by nulls
// ---------------------------------------------------------------------------

test('packetMeta branch and head_commit survive merge with buildSubagentRunMetadata that has nulls', () => {
  // Simulate a coder run where contextIdentity has null branch/head_commit
  // (common because the runner often doesn't know the final commit before launch).
  const extraction = extractImplementationPacket(COMPLETE_CODER_OUTPUT);
  const packetMeta = buildImplementationPacketMeta(
    { run_id: 'run1', role: 'coder', task_id: 940, purpose: 'implementation' },
    extraction,
  );

  // Build run metadata with null branch/head_commit (simulates coder launch context).
  const runMeta = buildSubagentRunMetadata({
    runId: 'run1',
    role: 'coder',
    taskId: 940,
    cwd: '/tmp/worktree',
    backend: 'pi-cli',
    model: 'test-model',
    tools: 'read,bash',
    sessionMode: 'fresh',
    session: null,
    rerunOfRunId: null,
    reviewRoundId: null,
    workspaceId: null,
    worktreePath: '/tmp/worktree',
    branch: null,
    baseBranch: null,
    baseCommit: null,
    headCommit: null,
    purpose: null,
    artifacts: null,
  });

  // BUG was: { ...packetMeta, ...runMeta } => runMeta.branch=null overwrites packetMeta.branch
  // FIX is:  { ...runMeta, ...packetMeta } => packetMeta.branch wins
  const merged = { ...runMeta, ...packetMeta };

  assert.equal(merged.branch, 'task/123-add-feature',
    'packetMeta.branch must survive merge with runMeta that has branch=null');
  assert.equal(merged.head_commit, 'abc123def456',
    'packetMeta.head_commit must survive merge with runMeta that has head_commit=null');
  assert.equal(merged.type, 'implementation_packet');
  assert.equal(merged.packet_completeness, 'complete');
});

test('old spread order (packetMeta first) loses branch/head_commit to null runMeta', () => {
  // This test documents the old buggy behavior to make the regression obvious.
  const extraction = extractImplementationPacket(COMPLETE_CODER_OUTPUT);
  const packetMeta = buildImplementationPacketMeta(
    { run_id: 'run1', role: 'coder', task_id: 940, purpose: 'implementation' },
    extraction,
  );

  const runMeta = buildSubagentRunMetadata({
    runId: 'run1',
    role: 'coder',
    taskId: 940,
    cwd: '/tmp/worktree',
    backend: 'pi-cli',
    model: 'test-model',
    tools: 'read,bash',
    sessionMode: 'fresh',
    session: null,
    rerunOfRunId: null,
    reviewRoundId: null,
    workspaceId: null,
    worktreePath: '/tmp/worktree',
    branch: null,
    baseBranch: null,
    baseCommit: null,
    headCommit: null,
    purpose: null,
    artifacts: null,
  });

  // OLD buggy order: packetMeta first, then runMeta overwrites with nulls.
  const buggyMerged = { ...packetMeta, ...runMeta };
  assert.equal(buggyMerged.branch, null,
    'old spread order clobbers branch with null — confirms the bug existed');
  assert.equal(buggyMerged.head_commit, null,
    'old spread order clobbers head_commit with null — confirms the bug existed');
});

// ---------------------------------------------------------------------------
// Incomplete prompt detection
// ---------------------------------------------------------------------------

test('detectIncompleteCoderPrompt returns true for #908-style incomplete output', () => {
  // This is the exact style of output that caused the #908 issue.
  assert.equal(
    detectIncompleteCoderPrompt('Now post the implementation packet to the Den task thread:'),
    true,
    'Should detect "Now post the implementation packet to the Den task thread:"'
  );

  assert.equal(
    detectIncompleteCoderPrompt('now post the implementation packet'),
    true,
    'Should detect lowercase "now post the implementation packet"'
  );

  assert.equal(
    detectIncompleteCoderPrompt('Post the implementation packet to the task thread.'),
    true,
    'Should detect "Post the implementation packet to the task thread."'
  );

  assert.equal(
    detectIncompleteCoderPrompt("Let's post the implementation packet now."),
    true,
    'Should detect "Let\'s post the implementation packet now."'
  );

  assert.equal(
    detectIncompleteCoderPrompt('I\'ll now post the implementation packet.'),
    true,
    'Should detect "I\'ll now post the implementation packet."'
  );

  assert.equal(
    detectIncompleteCoderPrompt('Next, let\'s post the implementation packet.'),
    true,
    'Should detect "Next, let\'s post the implementation packet."'
  );
});

test('detectIncompleteCoderPrompt returns false for complete packets', () => {
  assert.equal(
    detectIncompleteCoderPrompt(COMPLETE_CODER_OUTPUT),
    false,
    'Should not flag complete output as incomplete'
  );

  assert.equal(
    detectIncompleteCoderPrompt(MINIMAL_COMPLETE_OUTPUT),
    false,
    'Should not flag minimal complete output as incomplete'
  );
});

test('detectIncompleteCoderPrompt returns false for empty output', () => {
  assert.equal(
    detectIncompleteCoderPrompt(''),
    false,
    'Should not flag empty output as incomplete prompt'
  );
});

test('detectIncompleteCoderPrompt returns false for partial output without prompt pattern', () => {
  assert.equal(
    detectIncompleteCoderPrompt(PARTIAL_CODER_OUTPUT),
    false,
    'Should not flag partial output without prompt pattern'
  );
});

test('extractImplementationPacket sets incomplete_prompt_detected for #908-style output', () => {
  const result = extractImplementationPacket('Now post the implementation packet to the Den task thread:');
  assert.equal(result.incomplete_prompt_detected, true,
    'Should detect incomplete prompt in extraction result');
  assert.equal(result.completeness, 'partial',
    'Should still be partial completeness');
  assert.ok(result.missing_fields.length > 0,
    'Should still report missing fields');
});

test('extractImplementationPacket sets incomplete_prompt_detected false for complete output', () => {
  const result = extractImplementationPacket(COMPLETE_CODER_OUTPUT);
  assert.equal(result.incomplete_prompt_detected, false,
    'Should not flag complete output as incomplete prompt');
});

test('validatePacket sets incomplete_prompt_detected to false', () => {
  const result = validatePacket({ branch: 'main' });
  assert.equal(result.incomplete_prompt_detected, false,
    'validatePacket should set incomplete_prompt_detected to false');
});

test('formatPacketMissingNoticeMessage produces notice with missing fields', () => {
  const extraction = extractImplementationPacket('Now post the implementation packet to the Den task thread:');
  const msg = formatPacketMissingNoticeMessage(
    {
      run_id: 'run-908',
      role: 'coder',
      task_id: 908,
      branch: 'task/908-fix',
      head_commit: 'abc123def',
      final_output: 'Now post the implementation packet to the Den task thread:',
    },
    extraction,
  );

  assert.ok(msg.includes('# Implementation Packet Missing'),
    'Should have packet missing title');
  assert.ok(msg.includes('⚠️'),
    'Should have warning emoji');
  assert.ok(msg.includes('did not produce a complete implementation packet'),
    'Should explain the issue');
  assert.ok(msg.includes('Missing fields:'),
    'Should list missing fields');
  assert.ok(msg.includes('task/908-fix'),
    'Should include branch from run context');
  assert.ok(msg.includes('abc123def'),
    'Should include head_commit from run context');
  assert.ok(msg.includes('Now post the implementation packet'),
    'Should include truncated coder output');
  assert.ok(msg.includes('## Next steps'),
    'Should include next steps section');
});

test('buildPacketMissingNoticeMeta produces correct metadata', () => {
  const extraction = extractImplementationPacket('Now post the implementation packet to the Den task thread:');
  const meta = buildPacketMissingNoticeMeta(
    {
      run_id: 'run-908',
      role: 'coder',
      task_id: 908,
      branch: 'task/908-fix',
      head_commit: 'abc123def',
      purpose: 'implementation',
    },
    extraction,
  );

  assert.equal(meta.type, 'implementation_packet_missing',
    'Should have implementation_packet_missing type');
  assert.equal(meta.prepared_by, 'coder_run',
    'Should have coder_run prepared_by');
  assert.equal(meta.packet_completeness, 'missing',
    'Should be missing completeness');
  assert.equal(meta.run_id, 'run-908',
    'Should have correct run_id');
  assert.equal(meta.task_id, 908,
    'Should have correct task_id');
  assert.equal(meta.branch, 'task/908-fix',
    'Should have correct branch');
  assert.equal(meta.head_commit, 'abc123def',
    'Should have correct head_commit');
  assert.equal(meta.incomplete_prompt_detected, true,
    'Should flag incomplete_prompt_detected');
  assert.ok(meta.packet_missing_fields.length > 0,
    'Should list missing fields');
});

// ---------------------------------------------------------------------------
// Task #1097: Partial packet policy boundary
//
// These tests encode the decision that only prompt-like partial outputs are
// routed to implementation_packet_missing. Non-prompt partial outputs
// (those with structured content but missing required fields) remain as
// partial implementation_packet messages to preserve useful coder output.
// ---------------------------------------------------------------------------

test('detectIncompleteCoderPrompt does not flag prompt phrase inside a complete packet', () => {
  // A complete packet that happens to contain the prompt phrase in the
  // Risk Notes section must NOT be flagged. The heading-count guard
  // (>= 3 required headings) prevents this false positive.
  const output = `
## Branch

task/1097-partial-packet-policy

## Head Commit

abc123def456

## Summary

Evaluated the partial packet boundary and added tests.

## Files Changed

- pi-dev/lib/den-implementation-packet.ts
- tests/PiExtension.Tests/den-implementation-packet.test.mjs

## Tests Run

All 52 tests pass.

## Acceptance Checklist

- ✅ Policy boundary documented and tested.

## Known Gaps

None.

## Risk Notes

Now post the implementation packet to the Den task thread for review.
`;

  assert.equal(
    detectIncompleteCoderPrompt(output),
    false,
    'Complete packet with prompt phrase in Risk Notes must not be flagged'
  );

  const result = extractImplementationPacket(output);
  assert.equal(result.incomplete_prompt_detected, false,
    'Extraction must not flag complete packet with prompt phrase');
  assert.equal(result.completeness, 'complete');
});

test('detectIncompleteCoderPrompt does not flag prompt phrase inside a partial packet with 3+ headings', () => {
  // A partial packet with 3+ required headings but containing the prompt
  // phrase in a section body must NOT be flagged. It is a real (partial)
  // packet, not an incomplete prompt.
  const output = `
## Branch

task/1097-partial-packet-policy

## Head Commit

abc123def456

## Summary

Now post the implementation packet to the Den task thread.
`;

  assert.equal(
    detectIncompleteCoderPrompt(output),
    false,
    'Partial packet with 3 headings and prompt phrase in summary must not be flagged'
  );

  const result = extractImplementationPacket(output);
  assert.equal(result.incomplete_prompt_detected, false);
  assert.equal(result.completeness, 'partial');
  assert.ok(result.missing_fields.includes('files_changed'));
  assert.ok(result.missing_fields.includes('tests_run'));
});

test('detectIncompleteCoderPrompt flags prompt-only output with 2 headings', () => {
  // An output with only 2 headings where the content is just an instruction
  // to post the packet should be flagged as an incomplete prompt.
  const output = `
## Summary

Now post the implementation packet to the Den task thread:

## Files Changed

- some-file.ts
`;

  assert.equal(
    detectIncompleteCoderPrompt(output),
    true,
    'Output with only 2 headings and prompt phrase must be flagged'
  );

  const result = extractImplementationPacket(output);
  assert.equal(result.incomplete_prompt_detected, true);
});

test('non-prompt partial packets preserve useful structured content as implementation_packet', () => {
  // A partial output without any prompt phrase but with some structured
  // content must be extracted as a partial packet (not packet_missing).
  // This preserves useful coder output like branch, summary, and files.
  const output = `
## Branch

task/1097-partial-packet-policy

## Head Commit

abc123def456

## Summary

Made progress on the implementation but ran out of context.

## Files Changed

- pi-dev/lib/den-implementation-packet.ts
`;

  const result = extractImplementationPacket(output);

  // Not flagged as incomplete prompt — this is real structured content.
  assert.equal(result.incomplete_prompt_detected, false);

  // Partial completeness preserves useful output.
  assert.equal(result.completeness, 'partial');
  assert.equal(result.packet.branch, 'task/1097-partial-packet-policy');
  assert.equal(result.packet.head_commit, 'abc123def456');
  assert.ok(result.packet.summary?.includes('ran out of context'));
  assert.ok(Array.isArray(result.packet.files_changed));
  assert.equal(result.packet.files_changed?.length, 1);

  // Missing fields clearly reported.
  assert.ok(result.missing_fields.includes('tests_run'));
  assert.ok(result.missing_fields.includes('acceptance_checklist'));
  assert.ok(result.missing_fields.includes('known_gaps'));
  assert.ok(result.missing_fields.includes('risk_notes'));
});

test('partial implementation_packet message includes drift warning for non-prompt partials', () => {
  // Non-prompt partial packets should include the standard drift warning
  // listing missing fields, so the orchestrator and reviewer can clearly see
  // what the coder did not provide.
  const output = `
## Branch

task/1097-test

## Summary

Partial work done.
`;
  const extraction = extractImplementationPacket(output);
  const msg = formatImplementationPacketMessage(
    { run_id: 'run-partial', role: 'coder', task_id: 1097 },
    extraction,
  );

  assert.ok(msg.includes('**Completeness:** partial'));
  assert.ok(msg.includes('⚠️'));
  assert.ok(msg.includes('Missing fields:'));
  assert.ok(msg.includes('branch: `task/1097-test`')
    || msg.includes('`task/1097-test`'),
    'Useful branch info preserved in partial packet message');
  assert.ok(msg.includes('Partial work done'),
    'Useful summary preserved in partial packet message');
});

test('multiline regex anchoring: prompt phrase on middle line without headings is flagged', () => {
  // The multiline `m` flag makes `^` match any line start. This test
  // verifies that a prompt phrase appearing on a middle line (not the first)
  // is still detected when there are no structured headings.
  const output = 'I completed the task.\nNow post the implementation packet to the Den task thread:';

  assert.equal(
    detectIncompleteCoderPrompt(output),
    true,
    'Prompt phrase on middle line without headings must be flagged'
  );

  const result = extractImplementationPacket(output);
  assert.equal(result.incomplete_prompt_detected, true);
});

test('multiline regex anchoring: prompt phrase on last line of complete packet is not flagged', () => {
  // Verifies that the heading-count guard prevents false positives when
  // the prompt phrase appears on the last line of a complete packet.
  const output = `
## Branch

task/test

## Head Commit

abc123

## Summary

Done.

## Files Changed

- a.ts

## Tests Run

Pass.

## Acceptance Checklist

Done.

## Known Gaps

None.

## Risk Notes

Low. Now post the implementation packet.
`;

  assert.equal(
    detectIncompleteCoderPrompt(output),
    false,
    'Prompt phrase on last line of complete packet must not be flagged'
  );

  const result = extractImplementationPacket(output);
  assert.equal(result.incomplete_prompt_detected, false);
  assert.equal(result.completeness, 'complete');
});
