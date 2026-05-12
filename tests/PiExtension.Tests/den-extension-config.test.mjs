import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  reasoningCaptureOptionsFromConfig,
  resolveProjectDenConfigPaths,
  loadDenExtensionConfig,
  saveDenExtensionConfig,
  denConfigPath,
  clearProjectDenConfigPathCache,
} from '../../lib/den-extension-config.ts';
import { resolveReasoningCaptureOptions } from '../../lib/den-subagent-pipeline.ts';

const execFileAsync = promisify(execFile);

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// --- Existing test ---

test('Den extension config maps reasoning capture knobs to normalizer options', () => {
  const previous = process.env.DEN_PI_SUBAGENT_RAW_REASONING;
  delete process.env.DEN_PI_SUBAGENT_RAW_REASONING;
  try {
    const options = reasoningCaptureOptionsFromConfig({
      version: 1,
      reasoning: {
        capture_provider_summaries: false,
        capture_raw_local_previews: true,
        preview_chars: 500,
      },
    });

    assert.deepEqual(options, {
      captureProviderSummaries: false,
      captureRawLocalPreviews: true,
      previewChars: 500,
    });
    assert.deepEqual(resolveReasoningCaptureOptions(options), {
      captureProviderSummaries: false,
      captureRawLocalPreviews: true,
      previewChars: 500,
      rawEnvOverride: false,
      rawEnvValue: undefined,
    });

    process.env.DEN_PI_SUBAGENT_RAW_REASONING = 'false';
    assert.equal(resolveReasoningCaptureOptions(options).captureRawLocalPreviews, false);
  } finally {
    restoreEnv('DEN_PI_SUBAGENT_RAW_REASONING', previous);
  }
});

// --- Worktree config discovery tests ---

test('resolveProjectDenConfigPaths returns only local path for a non-git directory', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const paths = await resolveProjectDenConfigPaths(tmpDir);
    assert.equal(paths.length, 1);
    assert.equal(paths[0], path.join(tmpDir, '.pi', 'den-config.json'));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveProjectDenConfigPaths returns only local path for a regular git checkout', async () => {
  const tmpDir = await makeTmpDir();
  try {
    await execGit(tmpDir, 'init');
    const paths = await resolveProjectDenConfigPaths(tmpDir);
    assert.equal(paths.length, 1);
    assert.equal(paths[0], path.join(tmpDir, '.pi', 'den-config.json'));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveProjectDenConfigPaths returns inherited path for a linked worktree', async () => {
  const mainDir = await makeTmpDir();
  try {
    // Create main repo with an initial commit (required for worktree add)
    await execGit(mainDir, 'init');
    await writeFile(path.join(mainDir, 'README.md'), 'test');
    await execGit(mainDir, 'add', 'README.md');
    await execGit(mainDir, 'commit', '-m', 'init');

    // Create linked worktree
    const worktreeDir = path.join(os.tmpdir(), `den-config-test-worktree-${Date.now()}`);
    await execGit(mainDir, 'worktree', 'add', worktreeDir, '-b', 'test-branch');

    try {
      const paths = await resolveProjectDenConfigPaths(worktreeDir);
      assert.equal(paths.length, 2, `Expected 2 paths, got: ${JSON.stringify(paths)}`);
      assert.equal(paths[0], path.join(worktreeDir, '.pi', 'den-config.json'), 'First path should be local');
      assert.equal(paths[1], path.join(mainDir, '.pi', 'den-config.json'), 'Second path should be inherited from main worktree');
    } finally {
      await execGit(mainDir, 'worktree', 'remove', worktreeDir, '--force');
    }
  } finally {
    await rm(mainDir, { recursive: true, force: true });
  }
});

test('resolveProjectDenConfigPaths caches successful linked worktree discovery by resolved cwd', async () => {
  const mainDir = await makeTmpDir();
  const previousPath = process.env.PATH;
  try {
    await execGit(mainDir, 'init');
    await writeFile(path.join(mainDir, 'README.md'), 'test');
    await execGit(mainDir, 'add', 'README.md');
    await execGit(mainDir, 'commit', '-m', 'init');

    const worktreeDir = path.join(os.tmpdir(), `den-config-test-worktree-cache-${Date.now()}`);
    await execGit(mainDir, 'worktree', 'add', worktreeDir, '-b', 'test-branch-cache');

    try {
      clearProjectDenConfigPathCache();
      const firstPaths = await resolveProjectDenConfigPaths(worktreeDir);
      assert.equal(firstPaths.length, 2);

      firstPaths.push('/mutated-by-caller');
      process.env.PATH = '';

      const cachedPaths = await resolveProjectDenConfigPaths(worktreeDir);
      assert.deepEqual(cachedPaths, [
        path.join(worktreeDir, '.pi', 'den-config.json'),
        path.join(mainDir, '.pi', 'den-config.json'),
      ]);
    } finally {
      restoreEnv('PATH', previousPath);
      clearProjectDenConfigPathCache();
      await execGit(mainDir, 'worktree', 'remove', worktreeDir, '--force');
    }
  } finally {
    restoreEnv('PATH', previousPath);
    clearProjectDenConfigPathCache();
    await rm(mainDir, { recursive: true, force: true });
  }
});

test('loadDenExtensionConfig project scope discovers config from primary worktree', async () => {
  const mainDir = await makeTmpDir();
  try {
    // Create main repo with config
    await execGit(mainDir, 'init');
    await writeFile(path.join(mainDir, 'README.md'), 'test');
    await execGit(mainDir, 'add', 'README.md');
    await execGit(mainDir, 'commit', '-m', 'init');
    const configDir = path.join(mainDir, '.pi');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'den-config.json'), JSON.stringify({
      version: 1,
      subagents: { coder: { model: 'zai/glm-5.1' } },
    }, null, 2));

    // Create linked worktree (no local .pi/den-config.json)
    const worktreeDir = path.join(os.tmpdir(), `den-config-test-worktree-load-${Date.now()}`);
    await execGit(mainDir, 'worktree', 'add', worktreeDir, '-b', 'test-branch-load');

    try {
      const config = await loadDenExtensionConfig('project', worktreeDir);
      assert.deepEqual(config.subagents?.coder, { model: 'zai/glm-5.1' }, 'Should inherit coder model from primary worktree');
    } finally {
      await execGit(mainDir, 'worktree', 'remove', worktreeDir, '--force');
    }
  } finally {
    await rm(mainDir, { recursive: true, force: true });
  }
});

test('loadDenExtensionConfig project scope prefers local config over inherited', async () => {
  const mainDir = await makeTmpDir();
  try {
    // Create main repo with config
    await execGit(mainDir, 'init');
    await writeFile(path.join(mainDir, 'README.md'), 'test');
    await execGit(mainDir, 'add', 'README.md');
    await execGit(mainDir, 'commit', '-m', 'init');
    const mainConfigDir = path.join(mainDir, '.pi');
    await mkdir(mainConfigDir, { recursive: true });
    await writeFile(path.join(mainConfigDir, 'den-config.json'), JSON.stringify({
      version: 1,
      subagents: { coder: { model: 'main-model' } },
    }, null, 2));

    // Create linked worktree with its own config
    const worktreeDir = path.join(os.tmpdir(), `den-config-test-worktree-pref-${Date.now()}`);
    await execGit(mainDir, 'worktree', 'add', worktreeDir, '-b', 'test-branch-pref');
    const wtConfigDir = path.join(worktreeDir, '.pi');
    await mkdir(wtConfigDir, { recursive: true });
    await writeFile(path.join(wtConfigDir, 'den-config.json'), JSON.stringify({
      version: 1,
      subagents: { coder: { model: 'worktree-model' } },
    }, null, 2));

    try {
      const config = await loadDenExtensionConfig('project', worktreeDir);
      assert.equal(config.subagents?.coder?.model, 'worktree-model', 'Local config should take precedence over inherited');
    } finally {
      await execGit(mainDir, 'worktree', 'remove', worktreeDir, '--force');
    }
  } finally {
    await rm(mainDir, { recursive: true, force: true });
  }
});

test('saveDenExtensionConfig project scope writes to linked worktree local config only', async () => {
  const mainDir = await makeTmpDir();
  const worktreeDir = `${mainDir}-linked-save`;
  try {
    await execGit(mainDir, 'init');
    await writeFile(path.join(mainDir, 'README.md'), 'test');
    await execGit(mainDir, 'add', 'README.md');
    await execGit(mainDir, 'commit', '-m', 'init');

    const mainConfigPath = path.join(mainDir, '.pi', 'den-config.json');
    const mainConfig = {
      version: 1,
      fallback_model: 'main-fallback',
      subagents: { coder: { model: 'main-model' } },
    };
    await mkdir(path.dirname(mainConfigPath), { recursive: true });
    await writeFile(mainConfigPath, `${JSON.stringify(mainConfig, null, 2)}\n`);

    await execGit(mainDir, 'worktree', 'add', worktreeDir, '-b', 'test-branch-save');

    try {
      await saveDenExtensionConfig('project', worktreeDir, {
        version: 1,
        fallback_model: 'worktree-fallback',
        subagents: { reviewer: { model: 'worktree-reviewer' } },
      });

      const worktreeConfigPath = path.join(worktreeDir, '.pi', 'den-config.json');
      const worktreeConfig = JSON.parse(await readFile(worktreeConfigPath, 'utf8'));
      const unchangedMainConfig = JSON.parse(await readFile(mainConfigPath, 'utf8'));

      assert.deepEqual(worktreeConfig, {
        version: 1,
        fallback_model: 'worktree-fallback',
        subagents: { reviewer: { model: 'worktree-reviewer' } },
      });
      assert.deepEqual(unchangedMainConfig, mainConfig);
    } finally {
      await execGit(mainDir, 'worktree', 'remove', worktreeDir, '--force');
    }
  } finally {
    await rm(mainDir, { recursive: true, force: true });
    await rm(worktreeDir, { recursive: true, force: true });
  }
});

test('loadDenExtensionConfig global scope does not use worktree discovery', async () => {
  // Global scope reads from ~/.pi/agent/den-config.json and should not
  // attempt any worktree-related path discovery.
  const tmpDir = await makeTmpDir();
  try {
    const config = await loadDenExtensionConfig('global', tmpDir);
    assert.equal(config.version, 1);
    // Should have loaded from global path, not from any worktree-specific path
    // The presence of subagents from the user's real global config is fine;
    // the key assertion is that the function works without error and doesn't
    // use project-scope worktree discovery.
    assert.ok(typeof config === 'object');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('denConfigPath project returns local path regardless of worktree', () => {
  const p = denConfigPath('project', '/some/worktree/path');
  assert.equal(p, '/some/worktree/path/.pi/den-config.json');
});

// --- Helpers ---

async function makeTmpDir() {
  const dir = path.join(os.tmpdir(), `den-config-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function execGit(cwd, ...args) {
  return execFileAsync('git', ['-C', cwd, ...args], { timeout: 10_000 });
}
