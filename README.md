# den-pi

Den-aware extensions and reusable Pi-side helpers for worker sessions.

`den-pi` owns the code that runs inside or alongside Pi as reusable extensions/helpers. It does **not** own host-side Docker/tmux orchestration, canonical Den state, or MCP tool schemas.

## Contents

- `extensions/den.ts` — generic Den Pi extension tools.
- `extensions/den-subagent.ts` — Pi-side subagent/coder/reviewer helper tools.
- `extensions/exit-alias.ts` — Pi exit alias convenience extension.
- `extensions/pi-powerline-footer/` — powerline-style footer/status extension.
- `extensions/lemonade.ts` — discovers Lemonade models at startup and registers them with Pi.
- `extensions/den-router.ts` — discovers den-router models at startup and registers them with Pi (`DEN_ROUTER_URL`, default `http://127.0.0.1:18082`).
- `lib/` — Pi-side Den packet, subagent, collaboration, context, and cleanup helpers.
- `skills/den-orchestrator/SKILL.md` — generic Den orchestrator skill content for Pi sessions.

## Build and test

This first split preserves source TypeScript for Pi to consume directly. The build step verifies the expected artifact layout and package metadata; smoke tests cover pure library helpers that do not require live Den Core or Pi runtime APIs.

```bash
npm install
npm run build
npm test
```

## Runtime boundary

`den-pi` code receives runtime metadata from Den Core / den-worker-runtime through environment variables and state files. It should not know host details such as Docker socket paths, tmux session names, compose files, or host state-root layouts.

Expected worker-session inputs are documented in `docs/worker-runtime-artifact-contract.md`.

## Migration note from den-mcp

The old active implementation path was `/home/dev/den-mcp/pi-dev`. That tree has been moved here. Consumers should use `/home/dev/den-pi` or the packaged artifact produced from this repo instead of importing from `den-mcp/pi-dev`.
