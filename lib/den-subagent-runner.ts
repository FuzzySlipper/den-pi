import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  SUBAGENT_RUN_SCHEMA,
  SUBAGENT_RUN_SCHEMA_VERSION,
  buildSubagentRunContextMetadata,
  classifySubagentInfrastructureFailure,
  classifySubagentStderrIssue,
  createSubagentOutputExtractor,
  isTerminalAssistantMessage,
  normalizePiWorkEvent,
  parsePiStdoutLine,
  summarizeSubagentUsageFromSessionJsonl,
  type JsonObject,
  buildReasoningCaptureMetadata,
  type ReasoningCaptureOptions,
  type SubagentArtifacts,
  type SubagentUsageSummary,
} from "./den-subagent-pipeline.ts";
import type { SubagentRunRecorder } from "./den-subagent-recorder.ts";
import type { FinalHeadSource, FinalHeadStatus, FinalWorktreeStatus } from "./den-subagent-final-head.ts";
import type { ContextMetrics } from "./den-subagent-pipeline.ts";

export type DenConfig = {
  baseUrl: string;
  projectId: string;
  agent: string;
  role: string;
  instanceId: string;
};

export type RunOptions = {
  role: string;
  prompt: string;
  taskId?: number;
  sessionMode?: "fresh" | "continue" | "fork" | "session";
  session?: string;
  model?: string;
  fallbackModel?: string;
  tools?: string;
  reasoningCapture?: ReasoningCaptureOptions;
  cwd?: string;
  postResult?: boolean;
  rerunOfRunId?: string;
  reviewRoundId?: number;
  workspaceId?: string;
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  baseCommit?: string;
  headCommit?: string;
  purpose?: string;
};

export type SubagentResult = {
  run_id: string;
  role: string;
  task_id?: number;
  review_round_id?: number;
  workspace_id?: string;
  worktree_path?: string;
  branch?: string;
  base_branch?: string;
  base_commit?: string;
  /** Starting/requested head commit from run options (the HEAD before the sub-agent began work). */
  head_commit?: string;
  /** Alias for head_commit — makes the starting/requested semantics explicit. */
  requested_head_commit?: string;
  purpose?: string;
  final_head_commit?: string;
  final_head_status?: FinalHeadStatus;
  final_head_source?: FinalHeadSource;
  final_branch?: string;
  final_worktree_branch?: string;
  final_branch_matches_worktree?: boolean;
  final_worktree_status?: FinalWorktreeStatus;
  final_worktree_status_short?: string;
  final_head_error?: string;
  session_mode: string;
  session?: string;
  pi_session_id?: string;
  pi_session_dir?: string;
  pi_session_file_path?: string;
  pi_session_persisted?: boolean;
  exit_code: number;
  signal?: string;
  pid?: number;
  backend: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  aborted: boolean;
  timeout_kind?: "startup" | "terminal_drain";
  forced_kill: boolean;
  final_output: string;
  assistant_final_found: boolean;
  prompt_echo_detected: boolean;
  output_status: "assistant_final" | "prompt_echo_only" | "no_assistant_final";
  stderr: string;
  stderr_tail: string;
  model?: string;
  message_count: number;
  assistant_message_count: number;
  usage_summary?: SubagentUsageSummary;
  child_error_message?: string;
  infrastructure_failure_reason?: string;
  infrastructure_warning_reason?: string;
  artifacts: SubagentArtifacts;
  fallback_from_model?: string;
  fallback_from_exit_code?: number;
  context_metrics?: ContextMetrics;
};

export type SubagentBackendInput = {
  cfg: DenConfig;
  options: RunOptions;
  cwd: string;
  runId: string;
  recorder: SubagentRunRecorder;
  startedAt: string;
  signal: AbortSignal | undefined;
  controlSource?: SubagentControlSource;
  onUpdate: ((partial: string) => void) | undefined;
};

export type SubagentBackend = {
  name: string;
  run(input: SubagentBackendInput): Promise<SubagentResult>;
};

export type SubagentControlAction = "abort" | "rerun";

export type SubagentControlRequest = {
  action: SubagentControlAction;
  entryId?: number;
  requestedBy?: string;
  reason?: string;
};

export type SubagentControlSource = {
  poll(): Promise<SubagentControlRequest | undefined>;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_FINAL_DRAIN_MS = 5_000;
const DEFAULT_FORCE_KILL_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_CONTROL_POLL_MS = 2_000;

export function createSubagentBackend(): SubagentBackend {
  return piCliSubagentBackend;
}

export const piCliSubagentBackend: SubagentBackend = {
  name: "pi-cli",
  run: runPiCliSubagent,
};

export async function runPiCliSubagent(input: SubagentBackendInput): Promise<SubagentResult> {
  const { cfg, options, cwd, runId, recorder, startedAt, signal, controlSource, onUpdate } = input;
  const artifacts = recorder.artifacts;
  const sessionMode = options.sessionMode ?? "fresh";
  const freshSessionDir = sessionMode === "fresh" && shouldPersistFreshSession() ? artifacts.session_dir : undefined;
  const args = ["--mode", "json", "-p"];
  addSessionArgs(args, sessionMode, options.session, freshSessionDir);
  if (options.model) args.push("--model", options.model);
  const tools = options.tools ?? defaultToolsForRole(options.role);
  if (tools) args.push("--tools", tools);
  const prompt = buildSubagentPrompt(cfg, options);
  args.push(prompt);
  const contextMetadata = buildSubagentRunContextMetadata(options);
  const reasoningCaptureMetadata = buildReasoningCaptureMetadata(options.reasoningCapture);
  let piSessionId: string | undefined;
  let piSessionFilePath: string | undefined;
  const sessionMetadata = () => ({
    pi_session_id: piSessionId ?? null,
    pi_session_dir: freshSessionDir ?? null,
    pi_session_file_path: piSessionFilePath ?? null,
    pi_session_persisted: Boolean(freshSessionDir),
  });

  const env = {
    ...process.env,
    DEN_PI_AGENT: `${cfg.agent}-subagent`,
    DEN_PI_ROLE: options.role,
    DEN_PI_INSTANCE_ID: `pi-${cfg.projectId}-${safeId(options.role)}-${runId}`,
    DEN_PI_PARENT_INSTANCE_ID: cfg.instanceId,
  };

  let stderr = "";
  let buffer = "";
  let pid: number | undefined;
  let aborted = false;
  let timeoutKind: SubagentResult["timeout_kind"];
  let forcedKill = false;
  const outputExtractor = createSubagentOutputExtractor(prompt, recorder);

  const command = normalizeString(process.env.DEN_PI_SUBAGENT_PI_BIN) ?? "pi";
  const startupTimeoutMs = envMillis("DEN_PI_SUBAGENT_STARTUP_TIMEOUT_MS", DEFAULT_STARTUP_TIMEOUT_MS);
  const finalDrainMs = envMillis("DEN_PI_SUBAGENT_FINAL_DRAIN_MS", DEFAULT_FINAL_DRAIN_MS);
  const forceKillMs = envMillis("DEN_PI_SUBAGENT_FORCE_KILL_MS", DEFAULT_FORCE_KILL_MS);
  const heartbeatMs = envMillis("DEN_PI_SUBAGENT_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS);
  const controlPollMs = envMillis("DEN_PI_SUBAGENT_CONTROL_POLL_MS", DEFAULT_CONTROL_POLL_MS);

  const termination = await new Promise<{ exitCode: number; signal?: string }>((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    pid = proc.pid;
    let settled = false;
    let sawJsonEvent = false;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let finalDrainTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let controlTimer: ReturnType<typeof setInterval> | undefined;
    let controlPollInFlight = false;
    const handledControlEntryIds = new Set<number>();
    let abortHandler: (() => void) | undefined;

    const clearTimer = (timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | undefined) => {
      if (timer) clearTimeout(timer);
    };

    const clearTimers = () => {
      clearTimer(startupTimer);
      clearTimer(finalDrainTimer);
      clearTimer(forceKillTimer);
      clearTimer(heartbeatTimer);
      startupTimer = undefined;
      finalDrainTimer = undefined;
      forceKillTimer = undefined;
      heartbeatTimer = undefined;
      controlTimer = undefined;
    };

    const resolveOnce = (code: number | null, closeSignal?: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
      const exitCode = exitCodeFromProcess(code, closeSignal);
      resolve({ exitCode, signal: closeSignal ?? undefined });
    };

    const armForceKill = () => {
      clearTimer(forceKillTimer);
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        forcedKill = true;
        killProcessTree(proc, "SIGKILL");
      }, forceKillMs);
      forceKillTimer.unref?.();
    };

    const terminate = (
      kind: SubagentResult["timeout_kind"],
      markAborted = false,
      eventExtra: JsonObject = {},
    ) => {
      if (settled) return;
      if (kind) timeoutKind = kind;
      if (markAborted) aborted = true;
      void recorder.appendEvent({
        type: kind ? `subagent.${kind}_timeout` : "subagent.abort",
        ts: Date.now(),
        pid: proc.pid ?? null,
        ...contextMetadata,
        ...sessionMetadata(),
        ...eventExtra,
      });
      killProcessTree(proc, "SIGTERM");
      armForceKill();
    };

    const pollControls = async () => {
      if (!controlSource || controlPollInFlight || settled) return;
      controlPollInFlight = true;
      try {
        const request = await controlSource.poll();
        if (!request || settled) return;
        if (request.entryId !== undefined) {
          if (handledControlEntryIds.has(request.entryId)) return;
          handledControlEntryIds.add(request.entryId);
        }

        if (request.action === "abort") {
          stderr += `\n[den-subagent] Abort requested${request.requestedBy ? ` by ${request.requestedBy}` : ""}.`;
          await recorder.appendStderr(`${request.requestedBy ? `[den-subagent] Abort requested by ${request.requestedBy}.` : "[den-subagent] Abort requested."}\n`);
          terminate(undefined, true, {
            source: "den_control",
            request_entry_id: request.entryId ?? null,
            requested_by: request.requestedBy ?? null,
            reason: request.reason ?? null,
          });
        }
      } catch {
        // Control polling is best-effort; Den outages should not break the child run.
      } finally {
        controlPollInFlight = false;
      }
    };

    void recorder.writeStatus({
      schema: SUBAGENT_RUN_SCHEMA,
      schema_version: SUBAGENT_RUN_SCHEMA_VERSION,
      state: "running",
      run_id: runId,
      role: options.role,
      task_id: options.taskId ?? null,
      backend: piCliSubagentBackend.name,
      cwd,
      pid: proc.pid ?? null,
      started_at: startedAt,
      command,
      model: options.model ?? null,
      tools: tools ?? null,
      reasoning_capture: reasoningCaptureMetadata,
      session_mode: sessionMode,
      session: options.session ?? null,
      ...contextMetadata,
      ...sessionMetadata(),
      artifacts,
      process_group: process.platform !== "win32" && proc.pid ? -proc.pid : null,
    });
    void recorder.appendEvent({
      type: "subagent.process_started",
      ts: Date.now(),
      pid: proc.pid ?? null,
      command,
      ...contextMetadata,
      ...sessionMetadata(),
      process_group: process.platform !== "win32" && proc.pid ? -proc.pid : null,
    });
    if (heartbeatMs > 0) {
      heartbeatTimer = setInterval(() => {
        void recorder.appendEvent({
          type: "subagent.heartbeat",
          ts: Date.now(),
          pid: proc.pid ?? null,
          duration_ms: Math.max(0, Date.now() - Date.parse(startedAt)),
          saw_json_event: sawJsonEvent,
          stderr_bytes: Buffer.byteLength(stderr),
          ...contextMetadata,
          ...sessionMetadata(),
        });
      }, heartbeatMs);
      heartbeatTimer.unref?.();
    }
    if (controlSource && controlPollMs > 0) {
      void pollControls();
      controlTimer = setInterval(() => void pollControls(), controlPollMs);
      controlTimer.unref?.();
    }

    if (startupTimeoutMs > 0) {
      startupTimer = setTimeout(() => {
        if (settled || sawJsonEvent) return;
        stderr += `\n[den-subagent] Killed: no JSON output after ${startupTimeoutMs}ms (startup timeout).`;
        terminate("startup");
      }, startupTimeoutMs);
      startupTimer.unref?.();
    }

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = processStdoutLine(line);
        if (!parsed) continue;
        if (!sawJsonEvent) {
          sawJsonEvent = true;
          clearTimer(startupTimer);
          startupTimer = undefined;
        }
        const output = outputExtractor.updateFromEvent(parsed);
        if (output) onUpdate?.(output);
        if (parsed.type === "message_end" && isTerminalAssistantMessage(parsed.message)) {
          clearTimer(finalDrainTimer);
          finalDrainTimer = setTimeout(() => terminate("terminal_drain"), finalDrainMs);
          finalDrainTimer.unref?.();
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      void recorder.appendStderr(text);
    });

    proc.on("error", (error) => {
      stderr += `${error.message}\n`;
      outputExtractor.recordChildError(error.message);
      void recorder.appendEvent({
        type: "subagent.spawn_error",
        ts: Date.now(),
        error: error.message,
        ...contextMetadata,
        ...sessionMetadata(),
      });
      resolveOnce(1);
    });

    proc.on("close", (code, closeSignal) => {
      const parsed = processStdoutLine(buffer);
      if (parsed) outputExtractor.updateFromEvent(parsed);
      resolveOnce(code, closeSignal);
    });

    abortHandler = () => {
      terminate(undefined, true, { source: "tool_signal" });
    };
    if (signal?.aborted) abortHandler();
    else signal?.addEventListener("abort", abortHandler, { once: true });
  });

  const endedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  const output = outputExtractor.snapshot();
  const outputStatus: SubagentResult["output_status"] = output.finalOutput
    ? "assistant_final"
    : output.promptEchoDetected
      ? "prompt_echo_only"
      : "no_assistant_final";
  const stderrTail = tail(stderr.trim(), 2000);
  const discoveredSession = await discoverPiSessionFile(freshSessionDir, piSessionId);
  piSessionId = piSessionId ?? discoveredSession?.sessionId;
  piSessionFilePath = discoveredSession?.filePath;
  if (piSessionId) artifacts.session_id = piSessionId;
  if (piSessionFilePath) artifacts.session_file_path = piSessionFilePath;
  if (piSessionFilePath) {
    await recorder.appendEvent({
      type: "subagent.session_file_detected",
      ts: Date.now(),
      ...contextMetadata,
      ...sessionMetadata(),
    });
  }
  const usageSummary = piSessionFilePath
    ? summarizeSubagentUsageFromSessionJsonl(await readFileOrUndefined(piSessionFilePath))
    : undefined;
  const result: SubagentResult = {
    run_id: runId,
    role: options.role,
    task_id: options.taskId,
    review_round_id: metadataNumber(contextMetadata.review_round_id),
    workspace_id: metadataString(contextMetadata.workspace_id),
    worktree_path: metadataString(contextMetadata.worktree_path),
    branch: metadataString(contextMetadata.branch),
    base_branch: metadataString(contextMetadata.base_branch),
    base_commit: metadataString(contextMetadata.base_commit),
    head_commit: metadataString(contextMetadata.head_commit),
    requested_head_commit: metadataString(contextMetadata.head_commit),
    purpose: metadataString(contextMetadata.purpose),
    session_mode: sessionMode,
    session: options.session,
    pi_session_id: piSessionId,
    pi_session_dir: freshSessionDir,
    pi_session_file_path: piSessionFilePath,
    pi_session_persisted: Boolean(freshSessionDir),
    exit_code: termination.exitCode,
    signal: termination.signal,
    pid,
    backend: piCliSubagentBackend.name,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    aborted,
    timeout_kind: timeoutKind,
    forced_kill: forcedKill,
    final_output: output.finalOutput,
    assistant_final_found: Boolean(output.finalOutput),
    prompt_echo_detected: output.promptEchoDetected,
    output_status: outputStatus,
    stderr,
    stderr_tail: stderrTail,
    model: output.model,
    message_count: output.messageCount,
    assistant_message_count: output.assistantMessageCount,
    usage_summary: usageSummary,
    child_error_message: output.childErrorMessage,
    artifacts,
  };
  if (!subagentSucceeded(result)) {
    result.infrastructure_failure_reason = classifySubagentInfrastructureFailure(result);
  } else {
    result.infrastructure_warning_reason = classifySubagentStderrIssue(stderrTail);
  }

  await recorder.writeStatus({
    schema: SUBAGENT_RUN_SCHEMA,
    schema_version: SUBAGENT_RUN_SCHEMA_VERSION,
    state: subagentSucceeded(result)
      ? "complete"
      : result.aborted
        ? "aborted"
        : result.timeout_kind
          ? "timeout"
          : "failed",
    run_id: runId,
    role: options.role,
    task_id: options.taskId ?? null,
    backend: result.backend,
    cwd,
    pid: pid ?? null,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    exit_code: result.exit_code,
    signal: result.signal ?? null,
    aborted: result.aborted,
    timeout_kind: result.timeout_kind ?? null,
    forced_kill: result.forced_kill,
    assistant_final_found: result.assistant_final_found,
    prompt_echo_detected: result.prompt_echo_detected,
    output_status: result.output_status,
    message_count: result.message_count,
    assistant_message_count: result.assistant_message_count,
    usage_summary: result.usage_summary ?? null,
    model: result.model ?? null,
    reasoning_capture: reasoningCaptureMetadata,
    child_error_message: result.child_error_message ?? null,
    infrastructure_failure_reason: result.infrastructure_failure_reason ?? null,
    infrastructure_warning_reason: result.infrastructure_warning_reason ?? null,
    ...contextMetadata,
    ...sessionMetadata(),
    artifacts,
  });
  await recorder.appendEvent({
    type: "subagent.process_finished",
    ts: Date.now(),
    exit_code: result.exit_code,
    signal: result.signal ?? null,
    timeout_kind: result.timeout_kind ?? null,
    forced_kill: result.forced_kill,
    output_status: result.output_status,
    ...contextMetadata,
    ...sessionMetadata(),
  });

  return result;

  function processStdoutLine(line: string): any | undefined {
    const parsed = parsePiStdoutLine(line);
    if (!parsed) return undefined;
    if (parsed.kind === "json") {
      void recorder.appendStdoutLine(parsed.line);
      if (parsed.event?.type === "session") {
        piSessionId = normalizeString(parsed.event.id) ?? piSessionId;
      }
      const workEvent = normalizePiWorkEvent(parsed.event, Date.now(), {
        runId,
        taskId: options.taskId,
        subagentRole: options.role,
        backend: piCliSubagentBackend.name,
        requestedModel: options.model,
        reasoningCapture: options.reasoningCapture,
      });
      if (workEvent) void recorder.appendEvent(workEvent);
      return parsed.event;
    }

    void recorder.appendRawStdout(parsed.line);
    return undefined;
  }
}

export function buildSubagentPrompt(cfg: DenConfig, options: RunOptions): string {
  const taskLine = options.taskId ? `Den task: #${options.taskId}\n` : "";
  return [
    `You are a fresh ${options.role} sub-agent launched by the Den Pi orchestrator.`,
    `Project: ${cfg.projectId}`,
    taskLine.trim(),
    "",
    "Work only on the bounded request below.",
    "Use Den as the durable record when Den tools are available, but keep final output concise.",
    "If you find ambiguity, report the question instead of broadening scope.",
    "",
    "Request:",
    options.prompt,
  ].filter((line) => line !== "").join("\n");
}

export function addSessionArgs(args: string[], sessionMode: string, session: string | undefined, sessionDir?: string) {
  switch (sessionMode) {
    case "fresh":
      if (sessionDir) args.push("--session-dir", sessionDir);
      else args.push("--no-session");
      return;
    case "continue":
      args.push("--continue");
      return;
    case "fork":
      if (!session) throw new Error("session is required for fork mode.");
      args.push("--fork", session);
      return;
    case "session":
      if (!session) throw new Error("session is required for session mode.");
      args.push("--session", session);
      return;
    default:
      throw new Error("session_mode must be fresh, continue, fork, or session.");
  }
}

export function defaultToolsForRole(_role: string): string | undefined {
  // Leave the tool allowlist open by default so MCP-provided Den tools remain
  // available. Users can pin stricter role-specific allowlists later via config.
  return undefined;
}

export function subagentSucceeded(result: SubagentResult): boolean {
  if (!result.assistant_final_found || result.aborted) return false;
  if (result.exit_code === 0) return true;
  return result.timeout_kind === "terminal_drain";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

function exitCodeFromProcess(code: number | null, signal: NodeJS.Signals | null | undefined): number {
  if (typeof code === "number") return code;
  if (!signal) return 1;
  const signalNumber = signalToNumber(signal);
  return signalNumber ? 128 + signalNumber : 1;
}

function signalToNumber(signal: string): number | undefined {
  const signals: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15,
  };
  return signals[signal];
}

function envMillis(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function killProcessTree(proc: { pid?: number; kill(signal?: NodeJS.Signals | number): boolean }, signal: NodeJS.Signals) {
  if (process.platform !== "win32" && proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fall through to the direct child; the process may not be a group leader.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // The process may already be gone.
  }
}

function tail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function metadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function shouldPersistFreshSession(): boolean {
  const value = process.env.DEN_PI_SUBAGENT_NO_SESSION;
  if (!value) return true;
  return !["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

type DiscoveredSessionFile = {
  filePath: string;
  sessionId?: string;
};

async function discoverPiSessionFile(sessionDir: string | undefined, preferredSessionId: string | undefined): Promise<DiscoveredSessionFile | undefined> {
  if (!sessionDir) return undefined;
  try {
    const entries = await readdir(sessionDir, { withFileTypes: true });
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map(async (entry) => {
        const filePath = path.join(sessionDir, entry.name);
        const info = await stat(filePath);
        const sessionId = await readSessionHeaderId(filePath);
        return { filePath, sessionId, mtimeMs: info.mtimeMs };
      }));
    if (candidates.length === 0) return undefined;
    if (preferredSessionId) {
      const matching = candidates.find((candidate) => candidate.sessionId === preferredSessionId || candidate.filePath.includes(preferredSessionId));
      if (matching) return matching;
    }
    return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  } catch {
    return undefined;
  }
}

async function readFileOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function readSessionHeaderId(filePath: string): Promise<string | undefined> {
  try {
    const text = await readFile(filePath, "utf8");
    const firstLine = text.split("\n", 1)[0]?.trim();
    if (!firstLine) return undefined;
    const header = JSON.parse(firstLine);
    return normalizeString(header?.id);
  } catch {
    return undefined;
  }
}
