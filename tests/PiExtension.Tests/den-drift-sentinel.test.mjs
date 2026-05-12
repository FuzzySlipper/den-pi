import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDriftSentinelPacketMeta,
  buildDriftSentinelPrompt,
  formatDriftSentinelPacketMessage,
  parseDriftSentinelOutput,
} from '../../lib/den-drift-sentinel.ts';

test('buildDriftSentinelPrompt is bounded and forbids correctness review', () => {
  const prompt = buildDriftSentinelPrompt({
    task: {
      id: 936,
      title: 'Prototype cheap drift sentinel sub-agent role',
      intent: 'Add a manual drift sentinel before full review.',
    },
    coder_context_packet: '# Coder Context Packet\nUse den-drift-check infrastructure.',
    implementation_packet: '# Implementation Packet\nChanged prompt helpers.',
    deterministic_drift: '# Drift Check Packet\nRisk: medium',
    diffstat: '2 files changed, 20 insertions(+)',
    changed_files: ['M pi-dev/lib/den-drift-sentinel.ts', 'M tests/PiExtension.Tests/den-drift-sentinel.test.mjs'],
    suspicious_hunks: ['diff --git a/tests/example b/tests/example\n+changed harness'],
    max_section_chars: 200,
  });

  assert.match(prompt, /cheap drift-sentinel sub-agent/);
  assert.match(prompt, /not\*\* a correctness reviewer/i);
  assert.match(prompt, /Do not perform a correctness review/i);
  assert.match(prompt, /Return JSON only/);
  assert.match(prompt, /coder_context_packet/);
  assert.match(prompt, /implementation_packet/);
  assert.match(prompt, /Deterministic drift results/);
  assert.match(prompt, /Changed files/);
  assert.match(prompt, /Selected suspicious hunks/);
  assert.match(prompt, /low\|medium\|high/);
});

test('parseDriftSentinelOutput accepts fenced JSON and normalizes stable fields', () => {
  const parsed = parseDriftSentinelOutput(`\n\`\`\`json\n{
    "risk": "high",
    "conductor_attention_needed": true,
    "recommendation": "rerun_or_rework_before_review",
    "reasons": [{ "category": "tests", "severity": "blocking", "summary": "CI harness changed", "evidence": ["changed files"] }]
  }\n\`\`\`\n`);

  assert.equal(parsed.risk, 'high');
  assert.equal(parsed.conductor_attention_needed, true);
  assert.equal(parsed.recommendation, 'rerun_or_rework_before_review');
  assert.equal(parsed.reasons?.length, 1);
});

test('formatDriftSentinelPacketMessage and metadata post as drift_check_packet', () => {
  const output = JSON.stringify({
    risk: 'medium',
    conductor_attention_needed: true,
    recommendation: 'flag_conductor',
    reasons: [{ category: 'scope', severity: 'warning', summary: 'Out-of-scope file changed.', evidence: ['changed files'] }],
  });
  const parsed = parseDriftSentinelOutput(output);
  const message = formatDriftSentinelPacketMessage({
    task_id: 936,
    branch: 'task/936-drift-sentinel',
    base_ref: 'main',
    head_commit: 'abc1234',
    deterministic_risk: 'medium',
    deterministic_message_id: 2001,
    sentinel_output: output,
    parsed,
  });
  const meta = buildDriftSentinelPacketMeta({
    task_id: 936,
    branch: 'task/936-drift-sentinel',
    base_ref: 'main',
    head_commit: 'abc1234',
    deterministic_risk: 'medium',
    deterministic_message_id: 2001,
    parsed,
  });

  assert.match(message, /# Drift Check Packet — Drift Sentinel/);
  assert.match(message, /\*\*Risk:\*\* medium/);
  assert.match(message, /not a correctness review/);
  assert.equal(meta.type, 'drift_check_packet');
  assert.equal(meta.prepared_by, 'drift_sentinel');
  assert.equal(meta.risk, 'medium');
  assert.equal(meta.conductor_attention_needed, true);
  assert.equal(meta.source_deterministic_risk, 'medium');
});
