import { appendFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeSubagentRunEvent,
  type JsonObject,
  type SubagentArtifacts,
} from "./den-subagent-pipeline.ts";

export type SubagentProgressPublisher = (event: JsonObject) => Promise<void> | void;

export type SubagentRunRecorder = {
  artifacts: SubagentArtifacts;
  writeStatus(payload: JsonObject): Promise<void>;
  appendEvent(event: JsonObject): Promise<void>;
  flushEvents(): Promise<void>;
  appendStdoutLine(line: string): Promise<void>;
  appendRawStdout(line: string): Promise<void>;
  appendStderr(text: string): Promise<void>;
};

export async function createSubagentRunRecorder(
  runId: string,
  options: {
    progressPublisher?: SubagentProgressPublisher;
    createProgressPublisher?: (artifacts: SubagentArtifacts) => SubagentProgressPublisher | undefined;
  } = {},
): Promise<SubagentRunRecorder> {
  const artifacts = await createRunArtifacts(runId);
  const progressPublisher = options.progressPublisher ?? options.createProgressPublisher?.(artifacts);
  let eventChain = Promise.resolve();
  return {
    artifacts,
    writeStatus(payload: JsonObject) {
      return writeRunStatus(artifacts, payload);
    },
    appendEvent(event: JsonObject) {
      const normalizedEvent = normalizeSubagentRunEvent(event);
      eventChain = eventChain
        .then(() => Promise.all([
          appendRunEvent(artifacts, normalizedEvent),
          progressPublisher?.(normalizedEvent) ?? Promise.resolve(),
        ]))
        .then(() => undefined);
      return eventChain;
    },
    flushEvents() {
      return eventChain;
    },
    appendStdoutLine(line: string) {
      return appendText(artifacts.stdout_jsonl_path, `${line}\n`);
    },
    appendRawStdout(line: string) {
      return appendJsonl(artifacts.stdout_jsonl_path, {
        type: "raw_stdout",
        ts: Date.now(),
        line,
      });
    },
    appendStderr(text: string) {
      return appendText(artifacts.stderr_log_path, text);
    },
  };
}

export function subagentRunArtifactRoot(): string {
  const agentDir = normalizeEnvString(process.env.PI_CODING_AGENT_DIR);
  return path.join(agentDir ?? path.join(os.homedir(), ".pi", "agent"), "den-subagent-runs");
}

async function createRunArtifacts(runId: string): Promise<SubagentArtifacts> {
  const dir = path.join(subagentRunArtifactRoot(), runId);
  await mkdir(dir, { recursive: true });
  const artifacts = {
    dir,
    stdout_jsonl_path: path.join(dir, "stdout.jsonl"),
    stderr_log_path: path.join(dir, "stderr.log"),
    status_json_path: path.join(dir, "status.json"),
    events_jsonl_path: path.join(dir, "events.jsonl"),
    session_dir: path.join(dir, "sessions"),
  };
  await Promise.all([
    mkdir(artifacts.session_dir, { recursive: true }),
    writeFile(artifacts.stdout_jsonl_path, "", "utf8"),
    writeFile(artifacts.stderr_log_path, "", "utf8"),
    writeFile(artifacts.events_jsonl_path, "", "utf8"),
  ]);
  return artifacts;
}

async function writeRunStatus(artifacts: SubagentArtifacts, payload: JsonObject) {
  try {
    await writeFile(artifacts.status_json_path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // Artifact writes should not break the sub-agent run.
  }
}

async function appendRunEvent(artifacts: SubagentArtifacts, event: JsonObject) {
  return appendJsonl(artifacts.events_jsonl_path, event);
}

async function appendJsonl(filePath: string, payload: JsonObject) {
  return appendText(filePath, `${JSON.stringify(payload)}\n`);
}

async function appendText(filePath: string, text: string) {
  try {
    await appendFile(filePath, text, "utf8");
  } catch {
    // Artifact writes are best-effort.
  }
}

function normalizeEnvString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
