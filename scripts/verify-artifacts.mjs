import { existsSync, readFileSync } from "node:fs";

const requiredPaths = [
  "extensions/den.ts",
  "extensions/den-subagent.ts",
  "extensions/exit-alias.ts",
  "extensions/pi-powerline-footer/index.ts",
  "lib/den-packet-intent.ts",
  "lib/den-subagent-pipeline.ts",
  "lib/den-context-status.ts",
  "skills/den-orchestrator/SKILL.md",
  "docs/worker-runtime-artifact-contract.md",
];

const missing = requiredPaths.filter((path) => !existsSync(path));
if (missing.length) {
  console.error(`Missing required den-pi artifacts:\n${missing.map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
for (const extension of pkg.pi?.extensions ?? []) {
  const path = extension.replace(/^\.\//, "");
  if (!existsSync(path)) {
    console.error(`package.json pi extension does not exist: ${extension}`);
    process.exit(1);
  }
}

for (const skill of pkg.pi?.skills ?? []) {
  const path = skill.replace(/^\.\//, "");
  if (!existsSync(path)) {
    console.error(`package.json pi skill does not exist: ${skill}`);
    process.exit(1);
  }
}

console.log(`den-pi artifact layout OK (${requiredPaths.length} required paths)`);
