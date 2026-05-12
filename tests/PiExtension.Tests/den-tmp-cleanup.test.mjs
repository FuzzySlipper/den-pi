/**
 * Tests for safe /tmp cleanup plan builder and executor.
 *
 * @module den-tmp-cleanup.test
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkActiveAgents,
  executeTmpCleanup,
  formatCleanupPlan,
  formatCleanupResult,
  planTmpCleanup,
  scanDirectory,
  scanByPrefix,
  buildTmpCleanupToolResult,
  buildTmpCleanupToolParameters,
} from '../../lib/den-tmp-cleanup.ts';

// ---------------------------------------------------------------------------
// Helper: create a temp dir with known files
// ---------------------------------------------------------------------------

async function createTempFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'den-cleanup-test-'));
  await writeFile(path.join(root, 'file1.txt'), 'hello');
  await writeFile(path.join(root, 'file2.bin'), Buffer.alloc(1024, 0x42));
  await mkdir(path.join(root, 'subdir'));
  await writeFile(path.join(root, 'subdir', 'nested.txt'), 'nested');
  return root;
}

// ---------------------------------------------------------------------------
// scanDirectory
// ---------------------------------------------------------------------------

test('scanDirectory returns entries for existing dir', async () => {
  const root = await createTempFixture();
  try {
    const entries = await scanDirectory(root);
    const names = entries.map((e) => path.basename(e.path)).sort();
    assert.deepEqual(names, ['file1.txt', 'file2.bin', 'nested.txt', 'subdir']);
    const file1 = entries.find((e) => e.path.endsWith('file1.txt'));
    assert.ok(file1);
    assert.equal(file1.bytes, 5);
    assert.equal(file1.isDir, false);
    const subdir = entries.find((e) => e.path.endsWith('subdir'));
    assert.ok(subdir);
    assert.equal(subdir.bytes, 0);
    assert.equal(subdir.isDir, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanDirectory can scan only direct children', async () => {
  const root = await createTempFixture();
  try {
    const entries = await scanDirectory(root, { recursive: false });
    const names = entries.map((e) => path.basename(e.path)).sort();
    assert.deepEqual(names, ['file1.txt', 'file2.bin', 'subdir']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanDirectory returns empty for nonexistent dir', async () => {
  const entries = await scanDirectory('/tmp/nonexistent-cleanup-test-xyzzy');
  assert.deepEqual(entries, []);
});

// ---------------------------------------------------------------------------
// scanByPrefix
// ---------------------------------------------------------------------------

test('scanByPrefix matches files with given prefix', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prefix-test-'));
  try {
    await writeFile(path.join(root, 'foo-bar.txt'), 'a');
    await writeFile(path.join(root, 'foo-baz.txt'), 'bb');
    await writeFile(path.join(root, 'other.txt'), 'ccc');
    const entries = await scanByPrefix(root, 'foo-');
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => path.basename(e.path).startsWith('foo-')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanByPrefix returns empty for nonexistent dir', async () => {
  const entries = await scanByPrefix('/tmp/nonexistent-prefix-test', 'foo-');
  assert.deepEqual(entries, []);
});

// ---------------------------------------------------------------------------
// planTmpCleanup
// ---------------------------------------------------------------------------

test('planTmpCleanup returns plan for existing dir', async () => {
  const root = await createTempFixture();
  try {
    const plan = await planTmpCleanup({
      projectId: 'test-project',
      rootDir: root,
      includeLegacyPatterns: false,
    });
    assert.equal(plan.projectId, 'test-project');
    assert.equal(plan.rootDir, root);
    assert.equal(plan.totalFiles, 3); // file1.txt, file2.bin, and nested.txt
    assert.equal(plan.totalBytes, 5 + 1024 + 6);
    assert.equal(plan.entries.length, 4); // 3 files + 1 dir
    assert.equal(plan.includedLegacyPatterns, false);
    assert.deepEqual(plan.legacyEntries, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('planTmpCleanup handles empty dir', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'empty-cleanup-test-'));
  try {
    const plan = await planTmpCleanup({
      projectId: 'test-project',
      rootDir: root,
      includeLegacyPatterns: false,
    });
    assert.equal(plan.totalFiles, 0);
    assert.equal(plan.totalBytes, 0);
    assert.equal(plan.includedLegacyPatterns, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('planTmpCleanup defaults to project den-mcp', async () => {
  const plan = await planTmpCleanup({
    includeLegacyPatterns: false,
  });
  assert.equal(plan.projectId, 'den-mcp');
  assert.equal(plan.rootDir, path.join(os.tmpdir(), 'den-mcp'));
});

test('planTmpCleanup rejects unsafe root outside project tmp', async () => {
  await assert.rejects(
    () => planTmpCleanup({ projectId: 'test-project', rootDir: '/', includeLegacyPatterns: false }),
    /Unsafe tmp cleanup root/,
  );
  await assert.rejects(
    () => planTmpCleanup({ projectId: 'test-project', rootDir: os.tmpdir(), includeLegacyPatterns: false }),
    /Unsafe tmp cleanup root/,
  );
});

// ---------------------------------------------------------------------------
// checkActiveAgents
// ---------------------------------------------------------------------------

test('checkActiveAgents returns otherActive=false when no agents', () => {
  const result = checkActiveAgents('pi', []);
  assert.equal(result.otherActive, false);
  assert.deepEqual(result.agents, []);
});

test('checkActiveAgents returns otherActive=false when undefined', () => {
  const result = checkActiveAgents('pi', undefined);
  assert.equal(result.otherActive, false);
  assert.deepEqual(result.agents, []);
});

test('checkActiveAgents detects other agents', () => {
  const result = checkActiveAgents('pi', [
    { agent: 'pi' },
    { agent: 'reviewer-1' },
    { agent: 'coder-2' },
  ]);
  assert.equal(result.otherActive, true);
  assert.deepEqual(result.agents, ['reviewer-1', 'coder-2']);
});

test('checkActiveAgents ignores current agent', () => {
  const result = checkActiveAgents('pi', [
    { agent: 'pi', role: 'orchestrator' },
  ]);
  assert.equal(result.otherActive, false);
  assert.deepEqual(result.agents, []);
});

// ---------------------------------------------------------------------------
// formatCleanupPlan
// ---------------------------------------------------------------------------

test('formatCleanupPlan produces human-readable output', async () => {
  const root = await createTempFixture();
  try {
    const plan = await planTmpCleanup({
      projectId: 'test-project',
      rootDir: root,
      includeLegacyPatterns: false,
    });
    const lines = formatCleanupPlan(plan);
    assert.ok(lines[0].includes('test-project'));
    assert.ok(lines.some((l) => l.includes('Root:')));
    assert.ok(lines.some((l) => l.includes('Files:')));
    assert.ok(lines.some((l) => l.includes('file1.txt')));
    assert.ok(lines.some((l) => l.includes('file2.bin')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('formatCleanupPlan handles empty plan', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'empty-format-test-'));
  try {
    const plan = await planTmpCleanup({
      projectId: 'test-project',
      rootDir: root,
      includeLegacyPatterns: false,
    });
    const lines = formatCleanupPlan(plan);
    assert.ok(lines.some((l) => l.includes('empty or does not exist')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// executeTmpCleanup
// ---------------------------------------------------------------------------

test('executeTmpCleanup dry-run does not delete', async () => {
  const root = await createTempFixture();
  try {
    const plan = await planTmpCleanup({
      projectId: 'test-project',
      rootDir: root,
      includeLegacyPatterns: false,
    });
    const result = await executeTmpCleanup(plan, {
      destructive: false,
      currentAgent: 'pi',
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.deletedCount, 0);
    assert.equal(result.freedBytes, 0);
    assert.equal(result.blockedByActiveAgents, false);
    // Files should still exist
    const remaining = await readdir(root);
    assert.equal(remaining.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('executeTmpCleanup dry-run is the default', async () => {
  const root = await createTempFixture();
  try {
    const plan = await planTmpCleanup({
      projectId: 'test-project',
      rootDir: root,
      includeLegacyPatterns: false,
    });
    const result = await executeTmpCleanup(plan, { currentAgent: 'pi' });
    assert.equal(result.dryRun, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('executeTmpCleanup destructive deletes files', async () => {
  const root = await createTempFixture();
  try {
    const plan = await planTmpCleanup({
      projectId: 'test-project',
      rootDir: root,
      includeLegacyPatterns: false,
    });
    const result = await executeTmpCleanup(plan, {
      destructive: true,
      force: true,
      currentAgent: 'pi',
    });
    assert.equal(result.dryRun, false);
    assert.equal(result.deletedCount, 3); // 3 files including nested file
    assert.ok(result.freedBytes > 0);
    assert.equal(result.blockedByActiveAgents, false);
    // Files and now-empty subdir should be gone
    const remaining = await readdir(root);
    assert.equal(remaining.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('executeTmpCleanup blocks on active agents without force', async () => {
  const root = await createTempFixture();
  try {
    const plan = await planTmpCleanup({
      projectId: 'test-project',
      rootDir: root,
      includeLegacyPatterns: false,
    });
    const result = await executeTmpCleanup(plan, {
      destructive: true,
      force: false,
      currentAgent: 'pi',
      activeAgents: [
        { agent: 'pi' },
        { agent: 'other-agent' },
      ],
    });
    assert.equal(result.blockedByActiveAgents, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.deletedCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('executeTmpCleanup force overrides agent check', async () => {
  const root = await createTempFixture();
  try {
    const plan = await planTmpCleanup({
      projectId: 'test-project',
      rootDir: root,
      includeLegacyPatterns: false,
    });
    const result = await executeTmpCleanup(plan, {
      destructive: true,
      force: true,
      currentAgent: 'pi',
      activeAgents: [
        { agent: 'pi' },
        { agent: 'other-agent' },
      ],
    });
    assert.equal(result.blockedByActiveAgents, false);
    assert.equal(result.dryRun, false);
    assert.equal(result.deletedCount, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('executeTmpCleanup non-destructive ignores agent check', async () => {
  const root = await createTempFixture();
  try {
    const plan = await planTmpCleanup({
      projectId: 'test-project',
      rootDir: root,
      includeLegacyPatterns: false,
    });
    const result = await executeTmpCleanup(plan, {
      destructive: false,
      force: false,
      currentAgent: 'pi',
      activeAgents: [
        { agent: 'pi' },
        { agent: 'other-agent' },
      ],
    });
    assert.equal(result.blockedByActiveAgents, false);
    assert.equal(result.dryRun, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// formatCleanupResult
// ---------------------------------------------------------------------------

test('formatCleanupResult shows preview for dry-run', () => {
  const plan = {
    projectId: 'test-project',
    rootDir: '/tmp/test-project',
    entries: [{ path: '/tmp/test-project/file.txt', bytes: 100, isDir: false }],
    totalBytes: 100,
    totalFiles: 1,
    includedLegacyPatterns: false,
    legacyEntries: [],
  };
  const result = {
    dryRun: true,
    plan,
    deletedCount: 0,
    freedBytes: 0,
    errors: [],
    blockedByActiveAgents: false,
  };
  const lines = formatCleanupResult(result);
  assert.ok(lines.some((l) => l.includes('preview')));
});

test('formatCleanupResult counts legacy entries in delete hint', () => {
  const plan = {
    projectId: 'den-mcp',
    rootDir: '/tmp/den-mcp',
    entries: [{ path: '/tmp/den-mcp/file.txt', bytes: 100, isDir: false }],
    totalBytes: 100,
    totalFiles: 1,
    includedLegacyPatterns: true,
    legacyEntries: [
      { path: '/tmp/den-mcp-test-a.db', bytes: 50, isDir: false },
      { path: '/tmp/den-mcp-test-b.db-wal', bytes: 75, isDir: false },
    ],
  };
  const result = {
    dryRun: true,
    plan,
    deletedCount: 0,
    freedBytes: 0,
    errors: [],
    blockedByActiveAgents: false,
  };
  const lines = formatCleanupResult(result);
  assert.ok(lines.some((l) => l.includes('delete 3 file(s)')));
});

test('formatCleanupResult shows blocked message', () => {
  const plan = {
    projectId: 'test-project',
    rootDir: '/tmp/test-project',
    entries: [],
    totalBytes: 0,
    totalFiles: 0,
    includedLegacyPatterns: false,
    legacyEntries: [],
  };
  const result = {
    dryRun: true,
    plan,
    deletedCount: 0,
    freedBytes: 0,
    errors: [],
    blockedByActiveAgents: true,
  };
  const lines = formatCleanupResult(result);
  assert.ok(lines.some((l) => l.includes('blocked')));
  assert.ok(lines.some((l) => l.includes('--force')));
});

test('formatCleanupResult shows deletion stats', () => {
  const plan = {
    projectId: 'test-project',
    rootDir: '/tmp/test-project',
    entries: [],
    totalBytes: 0,
    totalFiles: 0,
    includedLegacyPatterns: false,
    legacyEntries: [],
  };
  const result = {
    dryRun: false,
    plan,
    deletedCount: 5,
    freedBytes: 102400,
    errors: [],
    blockedByActiveAgents: false,
  };
  const lines = formatCleanupResult(result);
  assert.ok(lines.some((l) => l.includes('completed')));
  assert.ok(lines.some((l) => l.includes('5')));
});

// ---------------------------------------------------------------------------
// buildTmpCleanupToolResult / Tool Parameters
// ---------------------------------------------------------------------------

test('buildTmpCleanupToolResult returns structured content', () => {
  const plan = {
    projectId: 'test-project',
    rootDir: '/tmp/test-project',
    entries: [],
    totalBytes: 0,
    totalFiles: 0,
    includedLegacyPatterns: false,
    legacyEntries: [],
  };
  const result = {
    dryRun: true,
    plan,
    deletedCount: 0,
    freedBytes: 0,
    errors: [],
    blockedByActiveAgents: false,
  };
  const output = buildTmpCleanupToolResult(result);
  assert.ok(Array.isArray(output.content));
  assert.equal(output.content.length, 1);
  assert.equal(output.content[0].type, 'text');
  assert.ok(typeof output.content[0].text === 'string');
  assert.equal(output.details.dry_run, true);
  assert.equal(output.details.project_id, 'test-project');
});

test('buildTmpCleanupToolParameters returns valid schema', () => {
  const params = buildTmpCleanupToolParameters();
  assert.equal(params.type, 'object');
  assert.ok(params.properties.project_id);
  assert.ok(params.properties.destructive);
  assert.ok(params.properties.force);
  assert.equal(params.additionalProperties, false);
});
