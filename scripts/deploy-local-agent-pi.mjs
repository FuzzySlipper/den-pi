#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packagePath = join(repoRoot, "package.json");
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));

const dryRun = process.argv.includes("--dry-run");
const agentDir = resolve(process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent"));
const settingsPath = process.env.PI_SETTINGS_PATH
  ? resolve(process.env.PI_SETTINGS_PATH)
  : join(agentDir, "settings.json");
const extensionsDir = join(agentDir, "extensions");
const skillsDir = join(agentDir, "skills");
const libDir = join(agentDir, "lib");

function log(message) {
  console.log(`${dryRun ? "[dry-run] " : ""}${message}`);
}

function ensureDir(path) {
  if (dryRun) {
    log(`ensure dir ${path}`);
    return;
  }
  mkdirSync(path, { recursive: true });
}

function assertArtifact(relPath) {
  const path = resolve(repoRoot, relPath);
  if (!existsSync(path)) {
    throw new Error(`Missing artifact ${relPath} (${path})`);
  }
  return path;
}

function existingLinkStatus(linkPath) {
  try {
    return lstatSync(linkPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function replaceSymlink(target, linkPath) {
  const st = existingLinkStatus(linkPath);
  if (st) {
    if (!st.isSymbolicLink()) {
      throw new Error(`${linkPath} exists and is not a symlink; refusing to replace it automatically`);
    }
    if (dryRun) {
      log(`replace symlink ${linkPath} -> ${target}`);
    } else {
      unlinkSync(linkPath);
      symlinkSync(target, linkPath);
    }
    return;
  }
  if (dryRun) {
    log(`create symlink ${linkPath} -> ${target}`);
  } else {
    symlinkSync(target, linkPath);
  }
}

function extensionLinkName(relPath) {
  const name = basename(relPath);
  if (name === "index.ts") return basename(dirname(relPath));
  return name;
}

function skillLinkName(relPath) {
  const parent = basename(dirname(relPath));
  if (basename(relPath).toLowerCase() === "skill.md") return parent;
  return basename(relPath, extname(relPath));
}

function loadSettings() {
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(readFileSync(settingsPath, "utf8"));
}

function saveSettings(settings) {
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  const current = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  if (current === content) {
    log(`${settingsPath} already up to date`);
    return;
  }
  if (dryRun) {
    log(`would write ${settingsPath}`);
    return;
  }
  if (current !== null) {
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const backup = `${settingsPath}.bak-den-pi-deploy-${stamp}`;
    renameSync(settingsPath, backup);
    log(`backup ${settingsPath} -> ${backup}`);
  }
  writeFileSync(settingsPath, content, { mode: 0o644 });
}

function normalizePackageEntry(entry) {
  return String(entry).replaceAll("\\", "/");
}

function isStaleDenPiEntry(entry) {
  const normalized = normalizePackageEntry(entry);
  return normalized.includes("den-mcp/pi-dev")
    || normalized === repoRoot
    || normalized.endsWith("/den-pi")
    || normalized === "../../dev/den-pi";
}

const extensions = pkg.pi?.extensions ?? [];
const skills = pkg.pi?.skills ?? [];
if (!Array.isArray(extensions) || !Array.isArray(skills)) {
  throw new Error("package.json must contain pi.extensions and pi.skills arrays");
}

log(`repo root: ${repoRoot}`);
log(`Pi agent dir: ${agentDir}`);
ensureDir(agentDir);
ensureDir(extensionsDir);
ensureDir(skillsDir);
replaceSymlink(assertArtifact("./lib"), libDir);

for (const rel of extensions) {
  const artifact = assertArtifact(rel);
  const target = basename(rel) === "index.ts" ? dirname(artifact) : artifact;
  replaceSymlink(target, join(extensionsDir, extensionLinkName(rel)));
}

for (const rel of skills) {
  const artifact = assertArtifact(rel);
  const target = basename(rel).toLowerCase() === "skill.md" ? dirname(artifact) : artifact;
  replaceSymlink(target, join(skillsDir, skillLinkName(rel)));
}

const settings = loadSettings();
const packages = Array.isArray(settings.packages) ? settings.packages : [];
settings.packages = packages.filter((entry) => !isStaleDenPiEntry(entry));
if (!settings.packages.includes(repoRoot)) settings.packages.push(repoRoot);
saveSettings(settings);

log(`registered package root ${repoRoot} in ${settingsPath}`);
log("den-pi local Pi artifact deployment complete");
