# den-pi artifact contract for den-worker-runtime

This document defines how `den-worker-runtime` consumes `den-pi` artifacts for Pi worker sessions.

## Responsibilities

`den-pi` owns Pi-side source artifacts:

- Den-aware Pi extensions in `extensions/`.
- Reusable Pi-side helper libraries in `lib/`.
- Generic Den orchestrator skill content in `skills/`.
- Package metadata describing the extension/skill entrypoints.

`den-worker-runtime` owns host-side installation/bundling into worker sessions. It may copy or mount `den-pi` artifacts, but it must not fork hidden implementation copies.

## Artifact layout

The repo root is the artifact root. A runtime consumer should expect:

```text
package.json
extensions/den.ts
extensions/den-subagent.ts
extensions/exit-alias.ts
extensions/pi-powerline-footer/index.ts
lib/*.ts
skills/den-orchestrator/SKILL.md
docs/worker-runtime-artifact-contract.md
```

`package.json` exposes the canonical Pi metadata:

```json
{
  "pi": {
    "extensions": [
      "./extensions/den.ts",
      "./extensions/den-subagent.ts",
      "./extensions/exit-alias.ts",
      "./extensions/pi-powerline-footer/index.ts"
    ],
    "skills": ["./skills/den-orchestrator/SKILL.md"]
  }
}
```

The initial artifact is source TypeScript. If a future Pi image requires compiled JavaScript, `den-pi` should add a `dist/` contract and keep this source layout as the stable authoring contract.

## Build/version strategy

During local development, `den-worker-runtime` may consume a source checkout path, defaulting to `/home/dev/den-pi`.

For deployed worker hosts, prefer one of:

1. a pinned git commit checkout of `den-pi`; or
2. a packaged tarball produced from `den-pi` after `npm run build` passes.

The worker runtime should record the consumed `den-pi` git commit or package version in worker launch metadata/status so Pi session behavior is reproducible.

## Local agent deployment helper

For den-k8plus local agent use, `den-pi` provides a helper that registers this checkout as the live Pi package root for the Unix `agent` account and creates symlinks into the profile-local Pi discovery directories:

```bash
npm run deploy:local
```

The helper defaults to `~/.pi/agent` for the current Unix user, so run it as the same account that launches Pi (`agent` on den-k8plus), for example:

```bash
sudo -n runuser -u agent -- bash -lc 'cd /home/dev/den-pi && npm run deploy:local'
```

It performs three operations:

1. verifies every `package.json.pi.extensions` and `package.json.pi.skills` artifact exists;
2. symlinks extension files/directories and skill directories into `~/.pi/agent/extensions/` and `~/.pi/agent/skills/`;
3. ensures `~/.pi/agent/settings.json` has `/home/dev/den-pi` in `packages` and removes the stale pre-split `den-mcp/pi-dev` package path.

Use `npm run deploy:local -- --dry-run` to preview changes. Do not edit or copy hidden live Pi extension/skill copies by hand; update this repo and rerun the helper.

## Runtime-provided inputs

`den-pi` code may read bounded worker/session metadata from environment variables and state files provided by Den Core / Worker Runtime. The exact names may evolve, but the boundary is:

- `DEN_CORE_BASE_URL` — Den Core HTTP API base URL.
- `DEN_CORE_TOKEN` or equivalent capability token when auth exists.
- `DEN_WORKER_RUN_ID` — canonical Den worker run id.
- `DEN_PI_SESSION_ID` — runtime session id.
- `DEN_TASK_ID` — Den task id when the worker is task-scoped.
- `DEN_WORKER_ROLE` — role such as `coder`, `reviewer`, `validator`, `raw`.
- `DEN_PROMPT_PACKET_MESSAGE_ID` or state-file ref for bounded startup context.
- `DEN_WORKSPACE_ID` when a specific workspace is assigned.
- Optional state file paths for prompt packet, completion packet draft, and session metadata.

These values should be treated as inputs, not as authority. Canonical task/message/worker state lives in Den Core.

## Allowed Den Core interactions

Pi-side code may call Den Core APIs only for worker/session-scoped operations it has been authorized to perform, such as:

- reading a referenced prompt/context packet;
- posting structured completion/failure packets;
- appending bounded subagent or collaboration telemetry;
- reading task/review metadata necessary for the active worker role.

Pi-side code must not bypass Den Core by opening SQLite files, writing Den task/message storage directly, or relying on Den MCP adapter internals.

## Explicit non-goals

`den-pi` does not own or configure:

- Docker/tmux launch or attach implementation;
- rootless Docker socket/group/permission policy;
- host state root layout or cleanup;
- callback port allocation/binding;
- Den Core canonical DB schemas or migrations;
- MCP tool schemas or MCP adapter response formatting.

Those concerns belong to `den-worker-runtime`, `den-core`, or `den-mcp` respectively.

## Worker runtime consumption checklist

Before launching a worker session, `den-worker-runtime` should:

1. Resolve a `den-pi` artifact root or package version.
2. Run or trust a prior `npm run build` artifact-layout verification.
3. Copy/mount the artifact root into the worker session at a stable path.
4. Install/register every `package.json.pi.extensions` entry with Pi.
5. Install/register every `package.json.pi.skills` entry as available skill content.
6. Provide the bounded runtime environment/state inputs above.
7. Record the `den-pi` commit/version in runtime status.
