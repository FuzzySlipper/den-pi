import assert from 'node:assert/strict';
import test from 'node:test';
import { compileResponse, formatSessionSummary, formatSessionDetail } from '../../lib/den-collaboration.ts';
import denExtension, { buildPiSourceContext, extractLastAssistantResponseFromEntries } from '../../extensions/den.ts';

// ---------------------------------------------------------------------------
// compileResponse
// ---------------------------------------------------------------------------

test('compileResponse returns acknowledgment footer for no annotations', () => {
  const segments = [
    { id: 1, sequence_number: 1, segment_hash: 'abc12345def', segment_type: 'paragraph', raw_markdown: 'Hello world.' },
    { id: 2, sequence_number: 2, segment_hash: 'def67890ghi', segment_type: 'paragraph', raw_markdown: 'Second paragraph.' },
  ];
  const annotations = [];
  const result = compileResponse(segments, annotations);
  assert.equal(result, '[no annotations — acknowledged in full, proceed]');
});

test('compileResponse includes annotated segments and footer for partial annotation', () => {
  const segments = [
    { id: 1, sequence_number: 1, segment_hash: 'aaa11111', segment_type: 'paragraph', raw_markdown: 'First paragraph.' },
    { id: 2, sequence_number: 2, segment_hash: 'bbb22222', segment_type: 'paragraph', raw_markdown: 'Second paragraph.' },
    { id: 3, sequence_number: 3, segment_hash: 'ccc33333', segment_type: 'paragraph', raw_markdown: 'Third paragraph.' },
  ];
  const annotations = [
    { id: 100, segment_id: 2, segment_hash: 'bbb22222', annotation_type: 'flag', body: 'needs discussion' },
  ];
  const result = compileResponse(segments, annotations);
  assert.ok(result.includes('[segment 2 · bbb22222]'));
  assert.ok(result.includes('[FLAG]: needs discussion'));
  assert.ok(result.includes('2 section(s) not annotated'));
  assert.ok(!result.includes('First paragraph')); // Unannotated segment not included
});

test('compileResponse handles code block segments', () => {
  const segments = [
    { id: 1, sequence_number: 1, segment_hash: 'code001', segment_type: 'code_block', raw_markdown: 'console.log("hello")', text: 'console.log("hello")' },
  ];
  const annotations = [
    { id: 200, segment_id: 1, segment_hash: 'code001', annotation_type: 'note', body: 'Use const instead' },
  ];
  const result = compileResponse(segments, annotations);
  assert.ok(result.includes('[code block:'));
  assert.ok(result.includes('[note]: Use const instead'));
});

test('compileResponse handles skip annotation type', () => {
  const segments = [
    { id: 1, sequence_number: 1, segment_hash: 'skip001', segment_type: 'paragraph', raw_markdown: 'Skip this.' },
  ];
  const annotations = [
    { id: 300, segment_id: 1, segment_hash: 'skip001', annotation_type: 'skip' },
  ];
  const result = compileResponse(segments, annotations);
  assert.ok(result.includes('[skip — no response needed]'));
});

test('compileResponse handles done annotation type', () => {
  const segments = [
    { id: 1, sequence_number: 1, segment_hash: 'done001', segment_type: 'paragraph', raw_markdown: 'Already done.' },
  ];
  const annotations = [
    { id: 400, segment_id: 1, segment_hash: 'done001', annotation_type: 'done' },
  ];
  const result = compileResponse(segments, annotations);
  assert.ok(result.includes('[done — already handled]'));
});

test('compileResponse handles flag without body', () => {
  const segments = [
    { id: 1, sequence_number: 1, segment_hash: 'flag001', segment_type: 'paragraph', raw_markdown: 'Flagged.' },
  ];
  const annotations = [
    { id: 500, segment_id: 1, segment_hash: 'flag001', annotation_type: 'flag' },
  ];
  const result = compileResponse(segments, annotations);
  assert.ok(result.includes('[FLAG]: needs discussion'));
});

test('compileResponse with all segments annotated omits footer', () => {
  const segments = [
    { id: 1, sequence_number: 1, segment_hash: 'all001', segment_type: 'paragraph', raw_markdown: 'Only segment.' },
  ];
  const annotations = [
    { id: 600, segment_id: 1, segment_hash: 'all001', annotation_type: 'note', body: 'Ok' },
  ];
  const result = compileResponse(segments, annotations);
  assert.ok(result.includes('[segment 1 · all001]'));
  assert.ok(!result.includes('not annotated'));
  assert.ok(!result.includes('[no annotations — acknowledged'));
});

test('compileResponse normalizes camelCase input fields', () => {
  const segments = [
    { id: 1, sequenceNumber: 1, segmentHash: 'cam001', segmentType: 'paragraph', rawMarkdown: 'Camel case.' },
  ];
  const annotations = [
    { id: 700, segmentId: 1, segmentHash: 'cam001', annotationType: 'note', body: 'Noted' },
  ];
  const result = compileResponse(segments, annotations);
  assert.ok(result.includes('[segment 1'));
  assert.ok(result.includes('[note]: Noted'));
});

// ---------------------------------------------------------------------------
// formatSessionSummary
// ---------------------------------------------------------------------------

test('formatSessionSummary includes basic fields', () => {
  const session = {
    id: 42,
    title: 'Test Session',
    status: 'active',
    task_id: 7,
    pi_run_id: 'run-abc',
    pi_session_id: 'sess-xyz',
    created_by: 'pi',
    created_at: '2026-04-28T12:00:00Z',
  };
  const lines = formatSessionSummary(session);
  assert.ok(lines.some(l => l.includes('Session #42: Test Session')));
  assert.ok(lines.some(l => l.includes('Task #7')));
  assert.ok(lines.some(l => l.includes('Pi run: run-abc')));
  assert.ok(lines.some(l => l.includes('Created by: pi')));
});

test('formatSessionSummary handles camelCase field names', () => {
  const session = {
    id: 99,
    title: 'Camel',
    status: 'active',
    taskId: 3,
    piRunId: 'run-456',
    createdBy: 'user',
    createdAt: '2026-04-28T12:00:00Z',
  };
  const lines = formatSessionSummary(session);
  assert.ok(lines.some(l => l.includes('Session #99: Camel')));
  assert.ok(lines.some(l => l.includes('Task #3')));
  assert.ok(lines.some(l => l.includes('Pi run: run-456')));
});

test('formatSessionSummary handles PascalCase status fallback', () => {
  const lines = formatSessionSummary({ id: 100, title: 'Pascal', Status: 'resolved' });
  assert.ok(lines.some(l => l.includes('Session #100: Pascal [resolved]')));
});

// ---------------------------------------------------------------------------
// formatSessionDetail
// ---------------------------------------------------------------------------

test('formatSessionDetail includes turns and segments', () => {
  const session = {
    id: 1,
    status: 'active',
    turns: [
      {
        id: 10,
        turn_order: 1,
        role: 'assistant',
        source_kind: 'pi_response',
        segments: [
          { id: 100, sequence_number: 1, segment_hash: 'seg001', segment_type: 'paragraph', raw_markdown: 'Hello.' },
        ],
      },
    ],
    annotations: [
      { id: 1000, segment_id: 100, segment_hash: 'seg001', annotation_type: 'note', body: 'Noted', created_by: 'user' },
    ],
    drafts: [
      { id: 1, revision: 1, content: '[note]: Noted' },
    ],
  };
  const lines = formatSessionDetail(session);
  assert.ok(lines.some(l => l.includes('Session #1')));
  assert.ok(lines.some(l => l.includes('Turn #1')));
  assert.ok(lines.some(l => l.includes('assistant')));
  assert.ok(lines.some(l => l.includes('[1] paragraph')));
  assert.ok(lines.some(l => l.includes('[note]: Noted')));
  assert.ok(lines.some(l => l.includes('Draft')));
});

test('formatSessionDetail handles empty turns gracefully', () => {
  const session = { id: 1, status: 'active', turns: [], annotations: [], drafts: [] };
  const lines = formatSessionDetail(session);
  assert.ok(lines.some(l => l.includes('Session #1')));
  assert.equal(lines.filter(l => l.includes('---')).length, 0);
});

test('formatSessionDetail with turns but no annotations', () => {
  const session = {
    id: 2,
    status: 'active',
    turns: [
      {
        id: 20,
        turn_order: 1,
        role: 'assistant',
        source_kind: 'pi_response',
        segments: [
          { id: 200, sequence_number: 1, segment_hash: 'seg002', segment_type: 'paragraph', raw_markdown: 'Content.' },
        ],
      },
    ],
    annotations: [],
    drafts: [],
  };
  const lines = formatSessionDetail(session);
  assert.ok(lines.some(l => l.includes('Session #2')));
  assert.ok(lines.some(l => l.includes('[1] paragraph')));
  assert.ok(!lines.some(l => l.includes('--- Annotations')));
});

// ---------------------------------------------------------------------------
// Pi collaboration context helpers
// ---------------------------------------------------------------------------

test('extractLastAssistantResponseFromEntries reads latest text-only assistant branch message', () => {
  const entries = [
    { type: 'message', message: { role: 'assistant', content: 'older text' } },
    { type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'tool preface' }, { type: 'toolCall', name: 'bash' }] } },
    { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [
      { type: 'thinking', thinking: 'private scratchpad' },
      { type: 'text', text: 'final answer' },
      { type: 'reasoning', reasoning: 'internal' },
    ] } },
  ];

  assert.equal(extractLastAssistantResponseFromEntries(entries), 'final answer');
});

test('extractLastAssistantResponseFromEntries skips tool-use messages and falls back', () => {
  const entries = [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'usable answer' }] } },
    { type: 'message', message: { role: 'assistant', stopReason: 'tool_use', content: [{ type: 'text', text: 'ignore me' }] } },
  ];

  assert.equal(extractLastAssistantResponseFromEntries(entries), 'usable answer');
});

test('buildPiSourceContext includes runtime identifiers and removes empty values', () => {
  const context = buildPiSourceContext(
    { projectId: 'den-mcp', agent: 'pi', role: 'conductor', instanceId: 'inst-1', sessionId: 'den-session' },
    {
      sessionManager: {
        getSessionId: () => 'pi-session',
        getSessionFile: () => '/tmp/pi-session.jsonl',
      },
      model: { provider: 'test-provider', id: 'test-model' },
    },
    { task_id: 918, source_kind: 'pi_response', source_ref: undefined },
  );

  assert.equal(context.project_id, 'den-mcp');
  assert.equal(context.task_id, 918);
  assert.equal(context.pi_session_id, 'pi-session');
  assert.equal(context.pi_session_file, '/tmp/pi-session.jsonl');
  assert.equal(context.model, 'test-provider/test-model');
  assert.equal(context.source_ref, undefined);
});

test('den extension collaboration tools expose enums and delete annotation', () => {
  const commands = [];
  const tools = [];
  denExtension({
    on() {},
    registerCommand(name, definition) { commands.push({ name, definition }); },
    registerTool(definition) { tools.push(definition); },
  });

  assert.ok(commands.some((entry) => entry.name === 'den-collab-delete-annotation'));

  const addAnnotation = tools.find((entry) => entry.name === 'den_collab_add_annotation');
  const updateAnnotation = tools.find((entry) => entry.name === 'den_collab_update_annotation');
  const listSessions = tools.find((entry) => entry.name === 'den_collab_list_sessions');
  const updateStatus = tools.find((entry) => entry.name === 'den_collab_update_session_status');
  const deleteAnnotation = tools.find((entry) => entry.name === 'den_collab_delete_annotation');

  assert.deepEqual(addAnnotation.parameters.properties.annotation_type.enum, ['note', 'skip', 'done', 'flag']);
  assert.deepEqual(updateAnnotation.parameters.properties.annotation_type.enum, ['note', 'skip', 'done', 'flag']);
  assert.deepEqual(listSessions.parameters.properties.status.enum, ['active', 'resolved', 'archived']);
  assert.deepEqual(updateStatus.parameters.properties.status.enum, ['active', 'resolved', 'archived']);
  assert.deepEqual(updateStatus.parameters.properties.expected_status.enum, ['active', 'resolved', 'archived']);
  assert.ok(deleteAnnotation, 'den_collab_delete_annotation should be registered');
  assert.deepEqual(deleteAnnotation.parameters.required, ['session_id', 'annotation_id', 'expected_revision']);
});
