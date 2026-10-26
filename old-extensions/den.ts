import { createHash } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  buildDenContextStatusToolResult,
  captureDenContextStatus,
  formatDenContextStatusLines,
  summarizeDenContextStatusForMetadata,
} from "../lib/den-context-status.ts";
import {
  buildDenContextCompactionToolResult,
  formatDenContextCompactionResult,
  requestDenContextCompaction,
} from "../lib/den-context-compaction.ts";
import { normalizePiWorkEvent, type ReasoningCaptureOptions } from "../lib/den-subagent-pipeline.ts";
import {
  loadMergedDenExtensionConfig,
  reasoningCaptureOptionsFromConfig,
} from "../lib/den-extension-config.ts";
import { errorMessage, normalizeString, optionalNumber } from "../lib/den-string-utils.ts";
import {
  compileResponse,
  formatSessionSummary,
  formatSessionDetail,
} from "../lib/den-collaboration.ts";

type JsonObject = Record<string, unknown>;

type DenConfig = {
  baseUrl: string;
  projectId: string;
  agent: string;
  role: string;
  instanceId: string;
  sessionId: string;
};

export type ParentAgentWorkIdentity = {
  projectId: string;
  agent: string;
  role: string;
  instanceId: string;
  sessionId: string;
  taskId?: number;
  cwd?: string;
  sessionFile?: string;
  piSessionId?: string;
  model?: string;
  reasoningCapture?: ReasoningCaptureOptions;
};

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let config: DenConfig | undefined;
let bindingState: "unknown" | "bound" | "unbound" | "offline" = "unknown";
let bindingMessage: string | undefined;
let lastInboxLines: string[] = [];
let currentTaskId: number | undefined;
let resolvedAgentGuidance: any | undefined;
const parentWorkMirrorLastAt = new Map<string, number>();
let parentReasoningCaptureCache: { cwd: string; loadedAt: number; options?: ReasoningCaptureOptions } | undefined;
const PARENT_REASONING_CONFIG_CACHE_MS = 5_000;

const DEFAULT_BASE_URL = "http://192.168.1.10:5199";
const HEARTBEAT_SECONDS = 60;
const ORCHESTRATOR_GUIDANCE_SLUG = "pi-orchestrator-guidance";
const GLOBAL_ORCHESTRATOR_GUIDANCE_SLUG = "pi-orchestrator-guidance-default";
const COLLAB_ANNOTATION_TYPES = ["note", "skip", "done", "flag"] as const;
const COLLAB_SESSION_STATUSES = ["active", "resolved", "archived"] as const;
const EMPTY_TOOL_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as any;
const DEN_COMPACT_CONTEXT_PARAMETERS = {
  type: "object",
  properties: {
    durable_context_posted: {
      type: "boolean",
      description: "Confirm durable Den task/thread status has been posted or is already up to date before compacting.",
    },
    custom_instructions: {
      type: "string",
      description: "Optional custom compaction instructions. Defaults preserve Den workflow state, decisions, branch/head, tests, findings, and next steps.",
    },
    safe_point_notes: {
      type: "string",
      description: "Optional note explaining why this is a safe compaction point, e.g. after merge summary or between tasks.",
    },
    resume_after_compaction: {
      type: "boolean",
      description: "Whether to send a follow-up prompt automatically after compaction to resume the orchestrator session. Default: true. Set to false only if you intend to stop after compaction.",
    },
  },
  required: ["durable_context_posted"],
  additionalProperties: false,
} as any;

export default function denExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    clearHeartbeat();
    config = undefined;
    bindingState = "unknown";
    bindingMessage = undefined;
    resolvedAgentGuidance = undefined;
    ctx.ui.setStatus("den-guidance", undefined);

    try {
      config = await resolveConfig(ctx);
      bindingState = "bound";
      await checkIn(config, ctx, "idle");
      resolvedAgentGuidance = await getAgentGuidanceQuietly(config, ctx);
      startHeartbeat(config, ctx);
      ctx.ui.setStatus("den", `Den ${config.projectId}/${config.role}`);
      ctx.ui.notify(`Den connected: ${config.projectId} (${config.instanceId})`, "info");
    } catch (error) {
      config = undefined;
      resolvedAgentGuidance = undefined;
      ctx.ui.setStatus("den-guidance", undefined);
      if (error instanceof UnboundProjectError) {
        bindingState = "unbound";
        bindingMessage = error.message;
        ctx.ui.setStatus("den", "Den: no project bound");
        return;
      }

      bindingState = "offline";
      bindingMessage = `Den check-in failed: ${errorMessage(error)}`;
      ctx.ui.setStatus("den", "Den offline");
      ctx.ui.notify(bindingMessage, "error");
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!resolvedAgentGuidance?.content || !Array.isArray(resolvedAgentGuidance.sources) || resolvedAgentGuidance.sources.length === 0) {
      return;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${resolvedAgentGuidance.content}`,
    };
  });

  pi.on("agent_start", async (_event, ctx) => {
    const cfg = await ensureConfig(ctx);
    if (!cfg) return;
    ctx.ui.setStatus("den", `Den ${cfg.projectId}/${cfg.role}: busy`);
    scheduleParentAgentWorkMirror({ type: "agent_start" }, ctx);
    await checkInQuietly(cfg, ctx, "busy");
  });

  pi.on("turn_start", (event, ctx) => {
    scheduleParentAgentWorkMirror(event, ctx);
  });

  pi.on("turn_end", (event, ctx) => {
    scheduleParentAgentWorkMirror(event, ctx);
  });

  pi.on("message_update", (event, ctx) => {
    scheduleParentAgentWorkMirror(event, ctx);
  });

  pi.on("message_end", (event, ctx) => {
    scheduleParentAgentWorkMirror(event, ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    scheduleParentAgentWorkMirror(event, ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    scheduleParentAgentWorkMirror(event, ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const cfg = await ensureConfig(ctx);
    if (!cfg) return;
    ctx.ui.setStatus("den", `Den ${cfg.projectId}/${cfg.role}: idle`);
    await checkInQuietly(cfg, ctx, "idle");
    try {
      lastInboxLines = await buildInboxLines(cfg);
      if (lastInboxLines.length > 0) ctx.ui.setWidget("den-inbox", lastInboxLines);
    } catch {
      // Inbox refresh is advisory; do not disturb the main agent turn.
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearHeartbeat();
    const cfg = await ensureConfig(ctx);
    if (!cfg) return;
    try {
      await denFetch(cfg, "/api/agents/checkout", {
        method: "POST",
        body: {
          agent: cfg.agent,
          project_id: cfg.projectId,
          session_id: cfg.sessionId,
          instance_id: cfg.instanceId,
        },
      });
    } catch {
      // Shutdown is best-effort; the server ages out stale bindings.
    }
  });

  pi.registerCommand("den-status", {
    description: "Show the current Den Pi binding.",
    handler: async (_args, ctx) => {
      const cfg = await ensureConfig(ctx);
      if (!cfg) {
        const lines = formatUnboundStatus(ctx);
        ctx.ui.setWidget("den-status", lines);
        ctx.ui.notify(lines.join("\n"), bindingState === "offline" ? "error" : "info");
        return;
      }

      const bindings = await denFetch(cfg, `/api/agents/bindings?${query({
        projectId: cfg.projectId,
        agentIdentity: cfg.agent,
        role: cfg.role,
        transportKind: "pi_extension",
      })}`);
      ctx.ui.setWidget("den-status", [
        `Project: ${cfg.projectId}`,
        `Agent: ${cfg.agent}`,
        `Role: ${cfg.role}`,
        `Instance: ${cfg.instanceId}`,
      ]);
      ctx.ui.notify(`Den binding active (${Array.isArray(bindings) ? bindings.length : 0} matching bindings).`, "info");
    },
  });

  pi.registerCommand("den-inbox", {
    description: "Show pending Den work for this Pi orchestrator.",
    handler: async (_args, ctx) => {
      const cfg = await requireConfig(ctx);
      lastInboxLines = await buildInboxLines(cfg);
      ctx.ui.setWidget("den-inbox", lastInboxLines);
      ctx.ui.notify(lastInboxLines.join("\n"), "info");
    },
  });

  pi.registerCommand("den-next", {
    description: "Show the next unblocked Den task for this project.",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const assignedTo = args?.trim() || undefined;
      const next = await getNextTask(cfg, assignedTo);
      const lines = formatNextTask(next);
      ctx.ui.setWidget("den-next", lines);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("den-claim-next", {
    description: "Claim the next unblocked Den task and mark it in progress.",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const assignedTo = args?.trim() || undefined;
      const result = await claimNextTask(cfg, assignedTo);
      const lines = formatClaimResult(result);
      ctx.ui.setWidget("den-task", lines);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("den-task", {
    description: "Show a Den task detail and make it the current task for note/done commands.",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const taskId = parseRequiredId(args, "task id");
      const detail = await getTask(cfg, taskId);
      currentTaskId = taskId;
      const lines = formatTaskDetail(detail);
      ctx.ui.setWidget("den-task", lines);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("den-note", {
    description: "Post a note to the current Den task, or /den-note <task_id> <text>.",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const scoped = parseTaskScopedText(args, currentTaskId, "note text");
      const message = await sendTaskMessage(cfg, {
        taskId: scoped.taskId,
        content: scoped.text,
        intent: "note",
        metadata: { type: "note" },
      });
      currentTaskId = scoped.taskId;
      ctx.ui.notify(`Posted note #${message.id} on task #${scoped.taskId}.`, "info");
    },
  });

  pi.registerCommand("den-done", {
    description: "Mark the current Den task done, or /den-done <task_id> [note].",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const scoped = parseOptionalTaskScopedText(args, currentTaskId);
      if (scoped.text) {
        await sendTaskMessage(cfg, {
          taskId: scoped.taskId,
          content: scoped.text,
          intent: "status_update",
          metadata: { type: "status_update" },
        });
      }
      const updated = await updateTask(cfg, scoped.taskId, { status: "done" });
      currentTaskId = scoped.taskId;
      ctx.ui.notify(`Marked task #${updated.id} done.`, "info");
    },
  });

  pi.registerCommand("den-blocked", {
    description: "Mark the current Den task blocked, or /den-blocked <task_id> <reason>.",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const scoped = parseTaskScopedText(args, currentTaskId, "block reason");
      await sendTaskMessage(cfg, {
        taskId: scoped.taskId,
        content: scoped.text,
        intent: "task_blocked",
        metadata: { type: "task_blocked" },
      });
      const updated = await updateTask(cfg, scoped.taskId, { status: "blocked" });
      currentTaskId = scoped.taskId;
      ctx.ui.notify(`Marked task #${updated.id} blocked.`, "info");
    },
  });

  pi.registerCommand("den-mark-read", {
    description: "Mark Den messages read. Usage: /den-mark-read <id> [id...]",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const messageIds = parseIds(args);
      const result = await markMessagesRead(cfg, messageIds);
      ctx.ui.notify(`Marked ${result.marked ?? messageIds.length} message(s) read.`, "info");
    },
  });

  pi.registerCommand("den-complete-dispatch", {
    description: "Mark a Den dispatch complete. Usage: /den-complete-dispatch <dispatch_id>",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const dispatchId = parseRequiredId(args, "dispatch id");
      const result = await completeDispatch(cfg, dispatchId);
      ctx.ui.notify(`Completed dispatch #${result.id ?? dispatchId}.`, "info");
    },
  });

  pi.registerCommand("den-agent-guidance", {
    description: "Load and display the resolved Den-native agent guidance packet.",
    handler: async (_args, ctx) => {
      const cfg = await requireConfig(ctx);
      resolvedAgentGuidance = await getAgentGuidance(cfg);
      const sources = Array.isArray(resolvedAgentGuidance.sources) ? resolvedAgentGuidance.sources : [];
      ctx.ui.setWidget("den-agent-guidance", [
        `Resolved guidance for ${resolvedAgentGuidance.project_id ?? cfg.projectId}`,
        `Sources: ${sources.length}`,
        ...String(resolvedAgentGuidance.content ?? "").split("\n").slice(0, 38),
      ]);
      ctx.ui.notify(`Loaded ${sources.length} Den agent guidance source(s).`, "info");
    },
  });

  pi.registerCommand("den-orchestrator-guidance", {
    description: "Load the Den-managed Pi orchestrator guidance.",
    handler: async (_args, ctx) => {
      const cfg = await ensureConfig(ctx);
      const guidance = cfg
        ? await getOrchestratorGuidance(cfg)
        : await getGlobalOrchestratorGuidance(baseUrlFromEnv());
      ctx.ui.setWidget("den-orchestrator-guidance", guidance.content.split("\n").slice(0, 40));
      ctx.ui.notify(`Loaded orchestrator guidance from ${guidance.project_id}/${guidance.slug}.`, "info");
    },
  });

  const showContextStatus = async (_args: string | undefined, ctx: any) => {
    const status = captureDenContextStatus(ctx);
    const lines = formatDenContextStatusLines(status);
    ctx.ui.setWidget("den-context-status", lines);
    ctx.ui.notify(lines.join("\n"), status.recommendation.status === "compact_after_current_task" ? "warning" : "info");
  };

  pi.registerCommand("den-context-status", {
    description: "Show the current Pi orchestrator context budget estimate and compaction recommendation.",
    handler: showContextStatus,
  });

  pi.registerCommand("den-compaction-status", {
    description: "Alias for /den-context-status.",
    handler: showContextStatus,
  });

  pi.registerCommand("den-compact-context", {
    description: "Request Pi context compaction; invoking this command asserts durable Den state is already recorded. After compaction, a follow-up prompt resumes the orchestrator automatically. Usage: /den-compact-context [custom instructions]",
    handler: async (args, ctx) => {
      const result = requestDenContextCompaction(ctx, {
        durableContextPosted: true,
        customInstructions: normalizeString(args),
        safePointNotes: "Manual /den-compact-context command invoked; command invocation asserts durable Den state is already recorded.",
        resumeAfterCompaction: true,
      }, {
        sendResumeMessage: (message) => sendPostCompactionResumeMessage(pi, ctx, message),
      });
      ctx.ui.setWidget("den-context-compaction", formatDenContextCompactionResult(result).split("\n"));
      ctx.ui.notify(
        result.requested ? "Requested Den orchestrator context compaction." : result.reason,
        result.requested ? "info" : "warning",
      );
    },
  });

  pi.registerTool({
    name: "den_context_status",
    label: "Den Context Status",
    description: "Inspect the parent Pi orchestrator session context budget. Returns an estimate, confidence/limitations, and a recommendation for whether to compact between tasks.",
    parameters: EMPTY_TOOL_PARAMETERS,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return buildDenContextStatusToolResult(captureDenContextStatus(ctx));
    },
  });

  pi.registerTool({
    name: "den_compact_context",
    label: "Den Compact Context",
    description:
      "Request Pi parent-session context compaction when the orchestrator is at a safe boundary. " +
      "This tool is fire-and-forget: it returns immediately and compaction runs asynchronously after the current turn. " +
      "When resume_after_compaction is true (default), a follow-up prompt is sent automatically after compaction to resume the orchestrator. " +
      "Confirm durable_context_posted=true only after Den task/thread status is recorded or already up to date; otherwise this tool refuses to compact.",
    parameters: DEN_COMPACT_CONTEXT_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = requestDenContextCompaction(ctx, {
        durableContextPosted: params?.durable_context_posted === true,
        customInstructions: normalizeString(params?.custom_instructions),
        safePointNotes: normalizeString(params?.safe_point_notes),
        resumeAfterCompaction: params?.resume_after_compaction !== false,
      }, {
        sendResumeMessage: (message) => sendPostCompactionResumeMessage(pi, ctx, message),
      });
      return buildDenContextCompactionToolResult(result);
    },
  });

  // -----------------------------------------------------------------------
  // Tmp cleanup command and tool
  // -----------------------------------------------------------------------

  pi.registerCommand("den-tmp-cleanup", {
    description: "Preview or clean project tmp artifacts under /tmp/<project-id>/. " +
      "Dry-run by default; pass --destructive to delete after active-agent check, or --force to delete without that check. " +
      "Usage: /den-tmp-cleanup [--destructive] [--force] [--project <id>]",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const argsStr = (args ?? "").trim();
      const force = argsStr.includes("--force");
      const destructive = force || argsStr.includes("--destructive");
      const projectId = normalizeString(argsStr.match(/--project\s+(\S+)/)?.[1]) ?? cfg.projectId;

      const { planTmpCleanup, executeTmpCleanup, formatCleanupResult } = await import("../lib/den-tmp-cleanup.ts");

      const plan = await planTmpCleanup({ projectId });

      // Check active agents on the project
      let activeAgents: { agent: string; role?: string }[] | undefined;
      if (destructive && !force) {
        try {
          const agents = await denFetch(cfg, `/api/agents/active?${query({ projectId })}`);
          activeAgents = Array.isArray(agents) ? agents : undefined;
        } catch (error) {
          const message = `Tmp cleanup refused: could not check active agents (${errorMessage(error)}). Re-run with --force to override.`;
          ctx.ui.notify(message, "error");
          ctx.ui.setWidget("den-tmp-cleanup", [message]);
          return;
        }
      }

      const result = await executeTmpCleanup(plan, {
        destructive,
        force,
        currentAgent: cfg.agent,
        activeAgents,
      });

      const lines = formatCleanupResult(result);
      ctx.ui.setWidget("den-tmp-cleanup", lines);
      ctx.ui.notify(lines.join("\n"), result.blockedByActiveAgents ? "warning" : result.dryRun ? "info" : "success");
    },
  });

  pi.registerTool({
    name: "den_tmp_cleanup",
    label: "Den Tmp Cleanup",
    description: "Preview or clean project tmp artifacts under /tmp/<project-id>/. " +
      "Dry-run by default (preview). Pass destructive=true and optionally force=true to actually delete. " +
      "Checks Den active agents before destructive deletion unless force=true.",
    parameters: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project ID for root tmp dir resolution. Default: current bound project.",
        },
        root_dir: {
          type: "string",
          description: "Explicit root directory override, e.g. /tmp/other-project.",
        },
        include_legacy_patterns: {
          type: "boolean",
          description: "Include known safe legacy patterns like /tmp/den-mcp-test-*. Default: true.",
        },
        destructive: {
          type: "boolean",
          description: "Actually delete files. Default: false (dry-run preview).",
        },
        recursive: {
          type: "boolean",
          description: "Scan and clean nested files/directories under the project tmp root. Default: true.",
        },
        force: {
          type: "boolean",
          description: "Skip active-agent check. Default: false.",
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await requireConfig(ctx);
      const { planTmpCleanup, executeTmpCleanup, buildTmpCleanupToolResult } = await import("../lib/den-tmp-cleanup.ts");

      const projectId = normalizeString(params?.project_id) ?? cfg.projectId;
      const destructive = params?.destructive === true;
      const force = params?.force === true;

      const plan = await planTmpCleanup({
        projectId,
        rootDir: normalizeString(params?.root_dir),
        includeLegacyPatterns: params?.include_legacy_patterns !== false,
        recursive: params?.recursive !== false,
      });

      let activeAgents: { agent: string; role?: string }[] | undefined;
      if (destructive && !force) {
        try {
          const agents = await denFetch(cfg, `/api/agents/active?${query({ projectId })}`);
          activeAgents = Array.isArray(agents) ? agents : undefined;
        } catch (error) {
          throw new Error(`Tmp cleanup refused: could not check active agents (${errorMessage(error)}). Re-run with force=true to override.`);
        }
      }

      const result = await executeTmpCleanup(plan, {
        destructive,
        force,
        currentAgent: cfg.agent,
        activeAgents,
      });

      return buildTmpCleanupToolResult(result);
    },
  });

  // -----------------------------------------------------------------------
  // Collaboration session tools and commands
  // -----------------------------------------------------------------------

  pi.registerCommand("den-collab-create", {
    description: "Create a collaboration session. Usage: /den-collab-create [--task <id>] [--title <text>] <markdown or - for last assistant>",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const result = await handleCollabCreate(cfg, args, ctx);
      ctx.ui.setWidget("den-collab", result.lines);
      ctx.ui.notify(result.lines.join("\n"), "info");
    },
  });

  pi.registerCommand("den-collab-list", {
    description: "List collaboration sessions. Usage: /den-collab-list [--task <id>] [--status active|resolved|archived]",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const result = await handleCollabList(cfg, args);
      ctx.ui.setWidget("den-collab", result.lines);
      ctx.ui.notify(result.lines.join("\n"), result.lines.length > 0 ? "info" : "warning");
    },
  });

  pi.registerCommand("den-collab-open", {
    description: "Open a collaboration session detail. Usage: /den-collab-open <session_id>",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const sessionId = parseRequiredId(args, "session id");
      const result = await handleCollabOpen(cfg, sessionId);
      ctx.ui.setWidget("den-collab", result.lines);
      ctx.ui.notify(result.summary, "info");
    },
  });

  pi.registerCommand("den-collab-annotate", {
    description: "Add an annotation to a session segment. Usage: /den-collab-annotate <session_id> <segment_id> <note|skip|done|flag> [body]",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const result = await handleCollabAnnotate(cfg, args);
      ctx.ui.notify(result.summary, "info");
    },
  });

  pi.registerCommand("den-collab-delete-annotation", {
    description: "Delete an annotation with optimistic concurrency. Usage: /den-collab-delete-annotation <session_id> <annotation_id> <expected_revision>",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const result = await handleCollabDeleteAnnotation(cfg, args);
      ctx.ui.notify(result.summary, "info");
    },
  });

  pi.registerCommand("den-collab-compile", {
    description: "Compile a response draft from session annotations. Usage: /den-collab-compile <session_id> [turn_id]",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const result = await handleCollabCompile(cfg, args);
      ctx.ui.setWidget("den-collab", result.lines);
      ctx.ui.notify(result.summary, "info");
    },
  });

  pi.registerCommand("den-collab-add-turn", {
    description: "Add a new agent turn to a session. Usage: /den-collab-add-turn <session_id> <markdown>",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const result = await handleCollabAddTurn(cfg, args, ctx);
      ctx.ui.notify(result.summary, "info");
    },
  });

  pi.registerCommand("den-collab-status", {
    description: "Update session status. Usage: /den-collab-status <session_id> <expected_status> <new_status>",
    handler: async (args, ctx) => {
      const cfg = await requireConfig(ctx);
      const result = await handleCollabStatus(cfg, args);
      ctx.ui.notify(result.summary, "info");
    },
  });

  // Collaboration tools available to LLM
  pi.registerTool({
    name: "den_collab_create_session",
    label: "Den Create Collaboration Session",
    description: "Create a Den collaboration session from markdown content with source context. Posts a session to Den so human or tooling can annotate segments.",
    parameters: {
      type: "object",
      properties: {
        raw_markdown: { type: "string", description: "Raw markdown content to annotate (e.g. agent response)." },
        project_id: { type: "string", description: "Project ID. Defaults to current bound project." },
        task_id: { type: "number", description: "Optional Den task ID to link." },
        title: { type: "string", description: "Optional session title." },
        role: { type: "string", description: "Source role, e.g. assistant or user. Default: assistant." },
        source_kind: { type: "string", description: "Source kind, e.g. den_message, pi_response, cli." },
        source_ref: { type: "string", description: "Source reference ID." },
        source_uri: { type: "string", description: "Source URI." },
        pi_run_id: { type: "string", description: "Optional Pi run ID." },
        pi_session_id: { type: "string", description: "Optional Pi session ID." },
        created_by: { type: "string", description: "Who created the session. Defaults to bound agent." },
      },
      required: ["raw_markdown"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await requireConfig(ctx);
      const result = await collabCreateSession(cfg, {
        raw_markdown: params.raw_markdown,
        project_id: normalizeString(params.project_id) ?? cfg.projectId,
        task_id: optionalNumber(params.task_id),
        title: normalizeString(params.title),
        role: normalizeString(params.role) ?? "assistant",
        source_kind: normalizeString(params.source_kind) ?? "pi_response",
        source_ref: normalizeString(params.source_ref),
        source_uri: normalizeString(params.source_uri),
        pi_run_id: normalizeString(params.pi_run_id),
        pi_session_id: normalizeString(params.pi_session_id) ?? getPiRuntimeSessionId(ctx) ?? cfg.sessionId,
        created_by: normalizeString(params.created_by) ?? cfg.agent,
        source_context: buildPiSourceContext(cfg, ctx, {
          project_id: normalizeString(params.project_id) ?? cfg.projectId,
          task_id: optionalNumber(params.task_id) ?? currentTaskId,
          source_kind: normalizeString(params.source_kind) ?? "pi_response",
          source_ref: normalizeString(params.source_ref),
          source_uri: normalizeString(params.source_uri),
        }),
      });
      return { content: [{ type: "text", text: result.text }], details: { session_id: result.session?.id ?? null } };
    },
  });

  pi.registerTool({
    name: "den_collab_list_sessions",
    label: "Den List Collaboration Sessions",
    description: "List collaboration sessions for the current project, optionally filtered by task or status.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID. Defaults to current bound project." },
        task_id: { type: "number", description: "Optional task ID filter." },
        status: { type: "string", enum: COLLAB_SESSION_STATUSES, description: "Optional status filter: active, resolved, or archived." },
        limit: { type: "number", description: "Max results. Default 50." },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await requireConfig(ctx);
      const projectId = normalizeString(params.project_id) ?? cfg.projectId;
      const sessions = await collabListSessions(cfg, {
        projectId,
        taskId: optionalNumber(params.task_id),
        status: normalizeString(params.status) as any,
        limit: typeof params.limit === "number" ? params.limit : 50,
      });
      if (!Array.isArray(sessions) || sessions.length === 0) {
        return { content: [{ type: "text", text: "No collaboration sessions found." }], details: { count: 0 } };
      }
      const lines = [`${sessions.length} collaboration session(s) for ${projectId}:`];
      for (const session of sessions) {
        lines.push(...formatSessionSummary(session, "  "));
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: { count: sessions.length } };
    },
  });

  pi.registerTool({
    name: "den_collab_get_session",
    label: "Den Get Collaboration Session",
    description: "Get full collaboration session details including turns, segments, annotations, and drafts.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "number", description: "Collaboration session ID." },
        project_id: { type: "string", description: "Project ID. Defaults to current bound project." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await requireConfig(ctx);
      const projectId = normalizeString(params.project_id) ?? cfg.projectId;
      const session = await collabGetSession(cfg, projectId, params.session_id);
      const lines = formatSessionDetail(session);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { session_id: session.id, status: session.status ?? session.Status } };
    },
  });

  pi.registerTool({
    name: "den_collab_add_annotation",
    label: "Den Add Collaboration Annotation",
    description: "Add an annotation to a collaboration session segment. Types: note (comment), skip (no response needed), done (already handled), flag (needs discussion).",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "number", description: "Collaboration session ID." },
        turn_id: { type: "number", description: "Turn ID containing the segment." },
        segment_id: { type: "number", description: "Segment ID to annotate." },
        annotation_type: { type: "string", enum: COLLAB_ANNOTATION_TYPES, description: "Annotation type: note, skip, done, or flag." },
        body: { type: "string", description: "Optional annotation body text." },
        created_by: { type: "string", description: "Who created the annotation. Defaults to bound agent." },
        project_id: { type: "string", description: "Project ID. Defaults to current bound project." },
      },
      required: ["session_id", "turn_id", "segment_id", "annotation_type"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await requireConfig(ctx);
      const projectId = normalizeString(params.project_id) ?? cfg.projectId;
      const annotation = await collabCreateAnnotation(cfg, projectId, params.session_id, {
        turn_id: params.turn_id,
        segment_id: params.segment_id,
        annotation_type: normalizeString(params.annotation_type) ?? "note",
        body: normalizeString(params.body),
        created_by: normalizeString(params.created_by) ?? cfg.agent,
      });
      return {
        content: [{ type: "text", text: `Annotation #${annotation.id} created on segment #${params.segment_id} (${params.annotation_type}).` }],
        details: { annotation_id: annotation.id, annotation_type: params.annotation_type },
      };
    },
  });

  pi.registerTool({
    name: "den_collab_update_annotation",
    label: "Den Update Collaboration Annotation",
    description: "Update an existing annotation's type, body, or revision (optimistic concurrency).",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "number", description: "Collaboration session ID." },
        annotation_id: { type: "number", description: "Annotation ID to update." },
        expected_revision: { type: "number", description: "Expected current revision for optimistic concurrency." },
        annotation_type: { type: "string", enum: COLLAB_ANNOTATION_TYPES, description: "New annotation type." },
        body: { type: "string", description: "New annotation body." },
        updated_by: { type: "string", description: "Who updated the annotation. Defaults to bound agent." },
        project_id: { type: "string", description: "Project ID. Defaults to current bound project." },
      },
      required: ["session_id", "annotation_id", "expected_revision"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await requireConfig(ctx);
      const projectId = normalizeString(params.project_id) ?? cfg.projectId;
      const updated = await collabUpdateAnnotation(cfg, projectId, params.session_id, {
        annotation_id: params.annotation_id,
        expected_revision: params.expected_revision,
        annotation_type: normalizeString(params.annotation_type) ?? "note",
        body: normalizeString(params.body),
        updated_by: normalizeString(params.updated_by) ?? cfg.agent,
      });
      return {
        content: [{ type: "text", text: `Annotation #${params.annotation_id} updated to revision ${updated.revision ?? updated.Revision}.` }],
        details: { annotation_id: updated.id, revision: updated.revision ?? updated.Revision },
      };
    },
  });

  pi.registerTool({
    name: "den_collab_delete_annotation",
    label: "Den Delete Collaboration Annotation",
    description: "Delete an existing collaboration annotation with optimistic concurrency.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "number", description: "Collaboration session ID." },
        annotation_id: { type: "number", description: "Annotation ID to delete." },
        expected_revision: { type: "number", description: "Expected current revision for optimistic concurrency." },
        project_id: { type: "string", description: "Project ID. Defaults to current bound project." },
      },
      required: ["session_id", "annotation_id", "expected_revision"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await requireConfig(ctx);
      const projectId = normalizeString(params.project_id) ?? cfg.projectId;
      const deleted = await collabDeleteAnnotation(cfg, projectId, params.session_id, {
        annotation_id: params.annotation_id,
        expected_revision: params.expected_revision,
      });
      return {
        content: [{ type: "text", text: `Annotation #${params.annotation_id} deleted from session #${params.session_id}.` }],
        details: { annotation_id: deleted.id ?? params.annotation_id, deleted: true },
      };
    },
  });

  pi.registerTool({
    name: "den_collab_compile_response",
    label: "Den Compile Collaboration Response",
    description: "Compile session annotations into a structured response draft and optionally save it as a Den draft. Produces the same format as the server-side CollaborationResponseCompiler.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "number", description: "Collaboration session ID." },
        turn_id: { type: "number", description: "Optional turn ID to scope compilation. Uses latest turn when omitted." },
        save_draft: { type: "boolean", description: "Save the compiled response as a draft. Default: true." },
        project_id: { type: "string", description: "Project ID. Defaults to current bound project." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await requireConfig(ctx);
      const projectId = normalizeString(params.project_id) ?? cfg.projectId;
      const result = await collabCompileResponse(cfg, projectId, params.session_id, {
        turnId: optionalNumber(params.turn_id),
        saveDraft: params.save_draft !== false,
      });
      const lines = [
        `Compiled response for session #${params.session_id}`,
        `Segments: ${result.segmentCount}, Annotations: ${result.annotationCount}`,
        `Draft saved: ${result.draftSaved}`,
        "",
        ...result.compiled.split("\n"),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: { segment_count: result.segmentCount, annotation_count: result.annotationCount, draft_saved: result.draftSaved } };
    },
  });

  pi.registerTool({
    name: "den_collab_add_turn",
    label: "Den Add Collaboration Turn",
    description: "Add a new annotatable turn to an existing collaboration session.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "number", description: "Collaboration session ID." },
        raw_markdown: { type: "string", description: "Raw markdown content for the new turn." },
        role: { type: "string", description: "Source role. Default: assistant." },
        source_kind: { type: "string", description: "Source kind." },
        source_ref: { type: "string", description: "Source reference." },
        source_label: { type: "string", description: "Source label." },
        source_uri: { type: "string", description: "Source URI." },
        project_id: { type: "string", description: "Project ID. Defaults to current bound project." },
      },
      required: ["session_id", "raw_markdown"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await requireConfig(ctx);
      const projectId = normalizeString(params.project_id) ?? cfg.projectId;
      const sourceKind = normalizeString(params.source_kind);
      const sourceContext = buildPiSourceContext(cfg, ctx, {
        project_id: projectId,
        task_id: currentTaskId,
        source_kind: sourceKind,
        source_ref: normalizeString(params.source_ref),
        source_uri: normalizeString(params.source_uri),
      });

      const turn = await collabAddTurn(cfg, projectId, params.session_id, {
        raw_markdown: params.raw_markdown,
        role: normalizeString(params.role) ?? "assistant",
        source_kind: sourceKind,
        source_ref: normalizeString(params.source_ref),
        source_label: normalizeString(params.source_label),
        source_uri: normalizeString(params.source_uri),
        source_context: Object.keys(sourceContext).length > 0 ? sourceContext : undefined,
      });
      const segments = Array.isArray(turn.segments ?? turn.Segments) ? (turn.segments ?? turn.Segments) : [];
      return {
        content: [{ type: "text", text: `Turn #${turn.id} added with ${segments.length} segment(s).` }],
        details: { turn_id: turn.id, segment_count: segments.length },
      };
    },
  });

  pi.registerTool({
    name: "den_collab_update_session_status",
    label: "Den Update Session Status",
    description: "Update a collaboration session's status (active, resolved, archived) with optimistic concurrency check.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "number", description: "Collaboration session ID." },
        expected_status: { type: "string", enum: COLLAB_SESSION_STATUSES, description: "Expected current status for optimistic concurrency." },
        status: { type: "string", enum: COLLAB_SESSION_STATUSES, description: "New status: active, resolved, or archived." },
        project_id: { type: "string", description: "Project ID. Defaults to current bound project." },
      },
      required: ["session_id", "expected_status", "status"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await requireConfig(ctx);
      const projectId = normalizeString(params.project_id) ?? cfg.projectId;
      const updated = await collabUpdateSessionStatus(cfg, projectId, params.session_id, {
        expected_status: params.expected_status as any,
        status: params.status as any,
      });
      return {
        content: [{ type: "text", text: `Session #${params.session_id} status changed to ${updated.status ?? updated.Status}.` }],
        details: { session_id: updated.id, status: updated.status ?? updated.Status },
      };
    },
  });

  // General Den data access is intentionally provided by the configured Den MCP server.
  // This extension keeps Pi-native session binding, TUI commands, and orchestrator UX only.
}

function sendPostCompactionResumeMessage(pi: ExtensionAPI, ctx: any, message: string) {
  if (typeof ctx?.isIdle === "function" && ctx.isIdle()) {
    pi.sendUserMessage(message);
    return;
  }

  pi.sendUserMessage(message, { deliverAs: "followUp" });
}

async function resolveConfig(ctx: any): Promise<DenConfig> {
  const baseUrl = baseUrlFromEnv();
  const projectId = await resolveProjectId(baseUrl, ctx.cwd);
  const agent = process.env.DEN_PI_AGENT ?? "pi";
  const role = process.env.DEN_PI_ROLE ?? "orchestrator";
  const cwdHash = createHash("sha256").update(`${projectId}:${ctx.cwd}`).digest("hex").slice(0, 12);
  const instanceId = process.env.DEN_PI_INSTANCE_ID ?? `pi-${projectId}-${cwdHash}`;
  const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? "ephemeral";
  const sessionId = `pi:${projectId}:${instanceId}:${sessionFile}`;
  return { baseUrl, projectId, agent, role, instanceId, sessionId };
}

async function ensureConfig(ctx: any): Promise<DenConfig | undefined> {
  if (config) return config;
  if (bindingState === "unbound" || bindingState === "offline") return undefined;
  try {
    config = await resolveConfig(ctx);
    bindingState = "bound";
    bindingMessage = undefined;
    return config;
  } catch (error) {
    config = undefined;
    bindingState = error instanceof UnboundProjectError ? "unbound" : "offline";
    bindingMessage = error instanceof UnboundProjectError
      ? error.message
      : `Den check-in failed: ${errorMessage(error)}`;
    return undefined;
  }
}

async function requireConfig(ctx: any): Promise<DenConfig> {
  const cfg = await ensureConfig(ctx);
  if (!cfg) {
    throw new Error(bindingMessage ?? "Den is not bound to a project. Start Pi inside a registered Den project root or set DEN_PI_PROJECT_ID.");
  }
  return cfg;
}

async function resolveProjectId(baseUrl: string, cwd: string): Promise<string> {
  const explicitProjectId = normalizeString(process.env.DEN_PI_PROJECT_ID);
  if (explicitProjectId) return explicitProjectId;

  const projects = await denFetchBase(baseUrl, "/api/projects/");
  const cwdPath = path.resolve(cwd);
  const matches = take(projects, Number.MAX_SAFE_INTEGER)
    .map((project) => ({ project, rootPath: normalizeString(project.root_path ?? project.rootPath) }))
    .filter((entry) => entry.rootPath && isPathInside(cwdPath, entry.rootPath))
    .sort((a, b) => b.rootPath!.length - a.rootPath!.length);

  const projectId = normalizeString(matches[0]?.project?.id);
  if (projectId) return projectId;

  throw new UnboundProjectError(`Den is not bound to a project for cwd '${cwdPath}'. Start Pi inside a registered Den project root or set DEN_PI_PROJECT_ID explicitly.`);
}

function clearHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

function startHeartbeat(cfg: DenConfig, ctx: any) {
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    denFetch(cfg, "/api/agents/heartbeat", {
      method: "POST",
      body: {
        agent: cfg.agent,
        project_id: cfg.projectId,
        instance_id: cfg.instanceId,
      },
    }).catch((error) => {
      ctx.ui.setStatus("den", `Den heartbeat failed: ${errorMessage(error)}`);
    });
  }, HEARTBEAT_SECONDS * 1000);
}

async function checkInQuietly(cfg: DenConfig, ctx: any, state: string) {
  try {
    await checkIn(cfg, ctx, state);
  } catch {
    // State updates should not interrupt an active agent turn.
  }
}

async function checkIn(cfg: DenConfig, ctx: any, state: string) {
  await denFetch(cfg, "/api/agents/checkin", {
    method: "POST",
    body: {
      agent: cfg.agent,
      project_id: cfg.projectId,
      session_id: cfg.sessionId,
      instance_id: cfg.instanceId,
      agent_family: "pi",
      role: cfg.role,
      transport_kind: "pi_extension",
      binding_status: "active",
      metadata: JSON.stringify({
        cwd: ctx.cwd,
        state,
        current_task_id: currentTaskId ?? null,
        session_file: ctx.sessionManager?.getSessionFile?.() ?? null,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
        context_status: safeDenContextStatusMetadata(ctx),
      }),
    },
  });
}

function safeDenContextStatusMetadata(ctx: any): JsonObject | null {
  try {
    return summarizeDenContextStatusForMetadata(captureDenContextStatus(ctx));
  } catch {
    return null;
  }
}

function scheduleParentAgentWorkMirror(sourceEvent: any, ctx: any) {
  const cfg = config;
  if (!cfg) return;

  void mirrorParentAgentWork(cfg, sourceEvent, ctx).catch(() => {
    // Parent-agent observability should never interrupt the active Pi turn.
  });
}

async function mirrorParentAgentWork(cfg: DenConfig, sourceEvent: any, ctx: any) {
  const workEvent = normalizeParentAgentWorkEvent(sourceEvent, await buildParentWorkIdentity(cfg, ctx));
  if (!workEvent || !shouldMirrorParentAgentWorkEvent(workEvent)) return;
  await appendParentAgentWorkOps(cfg, workEvent);
}

async function buildParentWorkIdentity(cfg: DenConfig, ctx: any): Promise<ParentAgentWorkIdentity> {
  return {
    projectId: cfg.projectId,
    agent: cfg.agent,
    role: cfg.role,
    instanceId: cfg.instanceId,
    sessionId: cfg.sessionId,
    taskId: currentTaskId,
    cwd: ctx.cwd,
    sessionFile: ctx.sessionManager?.getSessionFile?.() ?? undefined,
    piSessionId: ctx.sessionManager?.getSessionId?.() ?? undefined,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    reasoningCapture: await loadParentReasoningCapture(ctx.cwd),
  };
}

async function loadParentReasoningCapture(cwd: string): Promise<ReasoningCaptureOptions | undefined> {
  const now = Date.now();
  if (parentReasoningCaptureCache?.cwd === cwd && now - parentReasoningCaptureCache.loadedAt < PARENT_REASONING_CONFIG_CACHE_MS) {
    return parentReasoningCaptureCache.options;
  }
  try {
    const denConfig = await loadMergedDenExtensionConfig(cwd);
    const options = reasoningCaptureOptionsFromConfig(denConfig);
    parentReasoningCaptureCache = { cwd, loadedAt: now, options };
    return options;
  } catch {
    parentReasoningCaptureCache = { cwd, loadedAt: now, options: undefined };
    return undefined;
  }
}

export function normalizeParentAgentWorkEvent(sourceEvent: any, identity: ParentAgentWorkIdentity, now = Date.now()): JsonObject | undefined {
  if (normalizeString(sourceEvent?.message?.role) === "user") return undefined;

  const normalized = normalizePiWorkEvent(sourceEvent, now, {
    taskId: identity.taskId,
    subagentRole: identity.role,
    backend: "pi-extension",
    requestedModel: identity.model,
    reasoningCapture: identity.reasoningCapture,
  });
  if (!normalized || typeof normalized.type !== "string") return undefined;

  const piSessionId = normalizeString(normalized.session_id) ?? identity.piSessionId;
  const payload: JsonObject = {
    ...normalized,
    type: normalized.type.replace(/^subagent\.work_/, "agent.work_"),
    project_id: identity.projectId,
    agent: identity.agent,
    agent_role: identity.role,
    instance_id: identity.instanceId,
    session_id: identity.sessionId,
    pi_session_id: piSessionId ?? null,
    session_file: identity.sessionFile ?? null,
    cwd: identity.cwd ?? null,
  };
  delete payload.subagent_role;
  delete payload.run_id;
  return omitUndefined(payload);
}

function shouldMirrorParentAgentWorkEvent(workEvent: JsonObject, now = Date.now()): boolean {
  const type = typeof workEvent.type === "string" ? workEvent.type : "";
  if (!type.startsWith("agent.work_")) return false;
  if (type === "agent.work_tool_update") return false;
  if (type === "agent.work_message_update" || type === "agent.work_reasoning_update") {
    const key = `${type}:${workEvent.instance_id ?? "unknown"}:${workEvent.update_kind ?? workEvent.reasoning_kind ?? "update"}`;
    const intervalMs = type === "agent.work_reasoning_update" ? 5_000 : 10_000;
    const previous = parentWorkMirrorLastAt.get(key) ?? 0;
    if (previous > 0 && now - previous < intervalMs) return false;
    parentWorkMirrorLastAt.set(key, now);
  }
  return true;
}

export function parentAgentOpsEventTypeForWorkEvent(workEvent: JsonObject): string | undefined {
  const type = typeof workEvent.type === "string" ? workEvent.type : undefined;
  return type?.startsWith("agent.work_") ? type.replace(/[.]/g, "_") : undefined;
}

async function appendParentAgentWorkOps(cfg: DenConfig, workEvent: JsonObject) {
  const eventType = parentAgentOpsEventTypeForWorkEvent(workEvent);
  if (!eventType) return;
  const taskId = typeof workEvent.task_id === "number" ? workEvent.task_id : currentTaskId;

  await denFetch(cfg, `/api/projects/${esc(cfg.projectId)}/agent-stream/ops`, {
    method: "POST",
    body: {
      sender: cfg.agent,
      sender_instance_id: cfg.instanceId,
      event_type: eventType,
      task_id: taskId,
      delivery_mode: "record_only",
      body: formatParentAgentWorkBody(cfg.role, workEvent),
      metadata: JSON.stringify({
        schema: "den_parent_agent_work",
        schema_version: 1,
        agent: cfg.agent,
        role: cfg.role,
        instance_id: cfg.instanceId,
        session_id: cfg.sessionId,
        task_id: taskId ?? null,
        event: workEvent,
      }),
    },
  });
}

function formatParentAgentWorkBody(role: string, workEvent: JsonObject): string {
  switch (workEvent.type) {
    case "agent.work_agent_start":
      return `${role} agent started responding.`;
    case "agent.work_turn_start":
      return `${role} agent started a turn.`;
    case "agent.work_turn_end":
      return `${role} agent finished a turn${typeof workEvent.text_preview === "string" ? `: ${oneLine(workEvent.text_preview)}` : ""}.`;
    case "agent.work_message_update":
      return `${role} agent assistant update${typeof workEvent.text_preview === "string" ? `: ${oneLine(workEvent.text_preview)}` : ""}.`;
    case "agent.work_message_end":
      return `${role} agent assistant message${typeof workEvent.text_preview === "string" ? `: ${oneLine(workEvent.text_preview)}` : ""}.`;
    case "agent.work_reasoning_start":
    case "agent.work_reasoning_update":
    case "agent.work_reasoning_end":
      if (typeof workEvent.reasoning_summary_preview === "string") {
        return `${role} agent reasoning summary: ${oneLine(workEvent.reasoning_summary_preview)}.`;
      }
      return `${role} agent reasoning activity${typeof workEvent.reasoning_chars === "number" ? ` (${workEvent.reasoning_chars} chars${workEvent.reasoning_redacted === false ? " visible" : ", redacted"})` : ""}.`;
    case "agent.work_tool_start":
      return `${role} agent started tool ${formatWorkToolName(workEvent)}${typeof workEvent.args_preview === "string" ? `: ${oneLine(workEvent.args_preview)}` : ""}.`;
    case "agent.work_tool_end":
      return `${role} agent finished tool ${formatWorkToolName(workEvent)}${workEvent.is_error === true ? " with error" : ""}${typeof workEvent.result_preview === "string" ? `: ${oneLine(workEvent.result_preview)}` : ""}.`;
    default:
      return `${role} agent activity.`;
  }
}

function formatWorkToolName(workEvent: JsonObject): string {
  return typeof workEvent.tool_name === "string" && workEvent.tool_name.trim() ? workEvent.tool_name : "(unknown)";
}

async function buildInboxLines(cfg: DenConfig): Promise<string[]> {
  const [dispatches, unread, stream, next] = await Promise.all([
    denFetch(cfg, `/api/dispatch?${query({ projectId: cfg.projectId, targetAgent: cfg.agent, status: "approved" })}`),
    denFetch(cfg, `/api/projects/${esc(cfg.projectId)}/messages?${query({ unreadFor: cfg.agent, limit: 10 })}`),
    denFetch(cfg, `/api/agent-stream?${query({ projectId: cfg.projectId, streamKind: "message", limit: 50 })}`),
    getNextTask(cfg),
  ]);

  const wakeable = Array.isArray(stream) ? stream.filter((entry) => isForThisBinding(entry, cfg)) : [];
  const lines = [
    `Den inbox for ${cfg.projectId}/${cfg.agent}/${cfg.role}`,
    `Approved dispatches: ${Array.isArray(dispatches) ? dispatches.length : 0}`,
    `Unread messages: ${Array.isArray(unread) ? unread.length : 0}`,
    `Targeted stream messages: ${wakeable.length}`,
    ...formatNextTask(next),
  ];

  for (const dispatch of take(dispatches, 3)) {
    lines.push(`Dispatch #${dispatch.id}: ${oneLine(dispatch.summary ?? dispatch.trigger_type ?? "pending dispatch")}`);
  }
  for (const message of take(unread, 3)) {
    lines.push(`Message #${message.id}: ${oneLine(message.content ?? "")}`);
  }
  for (const entry of take(wakeable, 3)) {
    lines.push(`Stream #${entry.id} ${entry.event_type}: ${oneLine(entry.body ?? "")}`);
  }
  return lines;
}

function isForThisBinding(entry: any, cfg: DenConfig): boolean {
  if (!entry || entry.delivery_mode === "record_only") return false;
  if (entry.recipient_instance_id) return entry.recipient_instance_id === cfg.instanceId;
  if (entry.recipient_agent && entry.recipient_agent !== cfg.agent) return false;
  if (entry.recipient_role && entry.recipient_role !== cfg.role) return false;
  return Boolean(entry.recipient_agent || entry.recipient_role);
}

async function getNextTask(cfg: DenConfig, assignedTo?: string) {
  return denFetch(cfg, `/api/projects/${esc(cfg.projectId)}/tasks/next?${query({ assignedTo })}`);
}

async function getTask(cfg: DenConfig, taskId: number) {
  return denFetch(cfg, `/api/projects/${esc(cfg.projectId)}/tasks/${taskId}`);
}

async function claimNextTask(cfg: DenConfig, assignedTo?: string) {
  const next = await getNextTask(cfg, assignedTo);
  if (next?.message || !next?.id) return { claimed: false, next };
  const task = await updateTask(cfg, next.id, {
    status: "in_progress",
    assigned_to: cfg.agent,
  });
  currentTaskId = task.id;
  const detail = await getTask(cfg, task.id);
  return { claimed: true, task, detail };
}

async function updateTask(cfg: DenConfig, taskId: number, changes: JsonObject) {
  return denFetch(cfg, `/api/projects/${esc(cfg.projectId)}/tasks/${taskId}`, {
    method: "PUT",
    body: {
      agent: cfg.agent,
      ...changes,
    },
  });
}

async function sendTaskMessage(
  cfg: DenConfig,
  options: { taskId: number; content: string; intent?: string; metadata?: JsonObject },
) {
  return sendMessage(cfg, {
    taskId: options.taskId,
    content: options.content,
    intent: options.intent,
    metadataJson: options.metadata ? JSON.stringify(options.metadata) : undefined,
  });
}

async function sendMessage(
  cfg: DenConfig,
  options: {
    content: string;
    taskId?: number;
    threadId?: number;
    intent?: string;
    metadataJson?: string;
    sender?: string;
  },
) {
  return denFetch(cfg, `/api/projects/${esc(cfg.projectId)}/messages`, {
    method: "POST",
    body: {
      sender: options.sender ?? cfg.agent,
      content: options.content,
      task_id: options.taskId,
      thread_id: options.threadId,
      intent: options.intent,
      metadata: options.metadataJson,
    },
  });
}

async function markMessagesRead(cfg: DenConfig, messageIds: number[], agent?: string) {
  return denFetch(cfg, "/api/messages/mark-read", {
    method: "POST",
    body: {
      agent: agent ?? cfg.agent,
      message_ids: messageIds,
    },
  });
}

async function completeDispatch(cfg: DenConfig, dispatchId: number, completedBy?: string) {
  return denFetch(cfg, `/api/dispatch/${dispatchId}/complete`, {
    method: "POST",
    body: {
      completed_by: completedBy ?? cfg.agent,
    },
  });
}

async function getAgentGuidanceQuietly(cfg: DenConfig, ctx: any) {
  try {
    const guidance = await getAgentGuidance(cfg);
    const count = Array.isArray(guidance.sources) ? guidance.sources.length : 0;
    if (count > 0) {
      ctx.ui.setStatus("den-guidance", `Guidance ${count}`);
    } else {
      ctx.ui.setStatus("den-guidance", undefined);
    }
    return guidance;
  } catch (error) {
    // Guidance resolution is additive. Keep Pi usable against older Den servers
    // or projects without guidance entries configured yet.
    ctx.ui.setStatus("den-guidance", undefined);
    ctx.ui.notify(`Den guidance not loaded: ${errorMessage(error)}`, "warning");
    return undefined;
  }
}

async function getAgentGuidance(cfg: DenConfig) {
  return denFetch(cfg, `/api/projects/${esc(cfg.projectId)}/agent-guidance`);
}

async function getOrchestratorGuidance(cfg: DenConfig) {
  const projectDoc = await tryGetDocument(cfg, cfg.projectId, ORCHESTRATOR_GUIDANCE_SLUG);
  if (projectDoc) return projectDoc;
  return getGlobalOrchestratorGuidance(cfg.baseUrl, cfg.projectId);
}

async function getGlobalOrchestratorGuidance(baseUrl: string, projectId = "unbound") {
  const globalDoc = await tryGetDocumentBase(baseUrl, "_global", GLOBAL_ORCHESTRATOR_GUIDANCE_SLUG);
  if (globalDoc) return globalDoc;
  return {
    project_id: projectId,
    slug: ORCHESTRATOR_GUIDANCE_SLUG,
    title: "Built-in Pi Orchestrator Guidance",
    content: [
      "# Built-in Pi Orchestrator Guidance",
      "",
      "You are the user-facing Pi orchestrator for this Den project.",
      "Use Den as the durable record for tasks, messages, documents, and sub-agent results.",
      "Delegate bounded implementation to coder sub-agents and independent review to reviewer sub-agents.",
      "Use den_drift_check, den_drift_sentinel, or equivalent Den drift tooling for scope/intent drift analysis instead of doing it inline.",
      "Do not re-review every line yourself; compare coder/reviewer/drift-tool communication against task intent and ask the user when ambiguity or drift needs judgment.",
    ].join("\n"),
  };
}

async function tryGetDocument(cfg: DenConfig, projectId: string, slug: string) {
  try {
    return await denFetch(cfg, `/api/projects/${esc(projectId)}/documents/${esc(slug)}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("failed with 404")) return undefined;
    throw error;
  }
}

async function tryGetDocumentBase(baseUrl: string, projectId: string, slug: string) {
  try {
    return await denFetchBase(baseUrl, `/api/projects/${esc(projectId)}/documents/${esc(slug)}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("failed with 404")) return undefined;
    throw error;
  }
}

function formatNextTask(next: any): string[] {
  if (next?.message) return [`Next task: ${next.message}`];
  if (next?.id) return [`Next task: #${next.id} [P${next.priority}] ${next.title}`];
  return ["Next task: unavailable"];
}

function formatClaimResult(result: any): string[] {
  if (!result?.claimed) return ["No task claimed.", ...formatNextTask(result?.next)];
  return formatTaskDetail(result.detail ?? { task: result.task });
}

function formatTaskDetail(detail: any): string[] {
  const task = detail?.task ?? detail;
  if (!task?.id) return ["Task detail unavailable."];
  const lines = [
    `Task #${task.id} [${task.status ?? "unknown"}] P${task.priority ?? "?"}: ${task.title}`,
  ];
  if (task.assigned_to) lines.push(`Assigned: ${task.assigned_to}`);
  if (task.description) lines.push(oneLine(task.description));
  const messages = Array.isArray(detail?.messages) ? detail.messages : [];
  if (messages.length > 0) lines.push(`Recent messages: ${messages.length}`);
  return lines;
}

function parseRequiredId(args: string | undefined, label: string): number {
  const first = args?.trim().split(/\s+/, 1)[0];
  const value = Number(first);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Expected ${label}.`);
  return value;
}

function parseIds(args: string | undefined): number[] {
  const values = (args ?? "")
    .split(/[,\s]+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (values.length === 0) throw new Error("Expected at least one message id.");
  return values;
}

function parseTaskScopedText(args: string | undefined, fallbackTaskId: number | undefined, label: string) {
  const scoped = parseOptionalTaskScopedText(args, fallbackTaskId);
  if (!scoped.text) throw new Error(`Expected ${label}.`);
  return scoped;
}

function parseOptionalTaskScopedText(args: string | undefined, fallbackTaskId: number | undefined) {
  const trimmed = args?.trim() ?? "";
  const match = trimmed.match(/^(\d+)(?:\s+([\s\S]*))?$/);
  if (match) {
    const taskId = Number(match[1]);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new Error("Expected task id.");
    return { taskId, text: (match[2] ?? "").trim() };
  }
  if (!fallbackTaskId) throw new Error("No current Den task. Run /den-task <id> or pass a task id.");
  return { taskId: fallbackTaskId, text: trimmed };
}

async function denFetch(cfg: DenConfig, pathAndQuery: string, options: { method?: string; body?: JsonObject } = {}) {
  return denFetchBase(cfg.baseUrl, pathAndQuery, options);
}

async function denFetchBase(baseUrl: string, pathAndQuery: string, options: { method?: string; body?: JsonObject } = {}) {
  const response = await fetch(`${baseUrl}${pathAndQuery}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = payload?.error ? `: ${payload.error}` : "";
    throw new Error(`${options.method ?? "GET"} ${pathAndQuery} failed with ${response.status}${detail}`);
  }
  return payload;
}

function formatUnboundStatus(ctx: any): string[] {
  if (bindingState === "offline") {
    return [bindingMessage ?? "Den offline", `Base URL: ${baseUrlFromEnv()}`];
  }

  return [
    "Den: no project bound",
    bindingMessage ?? `No registered Den project root matched ${path.resolve(ctx.cwd)}.`,
    "Start Pi inside a registered project root or set DEN_PI_PROJECT_ID explicitly.",
    `Base URL: ${baseUrlFromEnv()}`,
  ];
}

// ---------------------------------------------------------------------------
// Collaboration creation helper (shared by command and tool)
// ---------------------------------------------------------------------------

async function collabCreateSession(
  cfg: DenConfig,
  options: {
    raw_markdown: string;
    project_id: string;
    task_id?: number;
    title?: string;
    role: string;
    source_kind: string;
    source_ref?: string;
    source_uri?: string;
    pi_run_id?: string;
    pi_session_id?: string;
    created_by: string;
    source_context?: Record<string, unknown>;
  },
): Promise<{ session: any; text: string }> {
  const sourceContext = compactJsonObject({
    task_id: options.task_id,
    pi_run_id: options.pi_run_id,
    pi_session_id: options.pi_session_id,
    source_kind: options.source_kind,
    ...options.source_context,
  });

  const initialTurn: Record<string, unknown> = {
    role: options.role,
    source_kind: options.source_kind,
    raw_markdown: options.raw_markdown,
  };
  // Only add optional turn fields if non-null
  if (options.source_ref != null) initialTurn.source_ref = options.source_ref;
  if (options.source_uri != null) initialTurn.source_uri = options.source_uri;
  if (Object.keys(sourceContext).length > 0) initialTurn.source_context = sourceContext;

  const body: Record<string, unknown> = {
    title: options.title,
    pi_run_id: options.pi_run_id,
    pi_session_id: options.pi_session_id,
    created_by: options.created_by,
    initial_turn: initialTurn,
  };
  if (options.task_id != null) body.task_id = options.task_id;
  // Remove undefined values only (keep null as explicit signal where allowed)
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  if (body.initial_turn && typeof body.initial_turn === "object") {
    const turn = body.initial_turn as Record<string, unknown>;
    for (const key of Object.keys(turn)) {
      if (turn[key] === undefined) delete turn[key];
    }
  }

  const session = await denFetch(cfg, `/api/projects/${esc(options.project_id)}/collaboration/sessions`, {
    method: "POST",
    body,
  });

  const summary = formatSessionSummary(session);
  const text = [`Collaboration session #${session.id} created.`, ...summary].join("\n");
  return { session, text };
}

async function collabListSessions(
  cfg: DenConfig,
  options: { projectId: string; taskId?: number; status?: string; limit: number },
): Promise<any[]> {
  const params: Record<string, string | number | undefined> = { limit: options.limit };
  if (options.taskId) params.taskId = options.taskId;
  if (options.status) params.status = options.status;
  const sessions = await denFetch(cfg, `/api/projects/${esc(options.projectId)}/collaboration/sessions?${query(params)}`);
  return Array.isArray(sessions) ? sessions : [];
}

async function collabGetSession(cfg: DenConfig, projectId: string, sessionId: number): Promise<any> {
  return denFetch(cfg, `/api/projects/${esc(projectId)}/collaboration/sessions/${sessionId}`);
}

async function collabCreateAnnotation(
  cfg: DenConfig,
  projectId: string,
  sessionId: number,
  options: {
    turn_id: number;
    segment_id: number;
    annotation_type: string;
    body?: string;
    created_by: string;
  },
): Promise<any> {
  return denFetch(cfg, `/api/projects/${esc(projectId)}/collaboration/sessions/${sessionId}/turns/${options.turn_id}/annotations`, {
    method: "POST",
    body: {
      segment_id: options.segment_id,
      annotation_type: options.annotation_type,
      body: options.body,
      created_by: options.created_by,
    },
  });
}

async function collabUpdateAnnotation(
  cfg: DenConfig,
  projectId: string,
  sessionId: number,
  options: {
    annotation_id: number;
    expected_revision: number;
    annotation_type: string;
    body?: string;
    updated_by: string;
  },
): Promise<any> {
  return denFetch(cfg, `/api/projects/${esc(projectId)}/collaboration/sessions/${sessionId}/annotations/${options.annotation_id}`, {
    method: "PUT",
    body: {
      expected_revision: options.expected_revision,
      annotation_type: options.annotation_type,
      body: options.body,
      updated_by: options.updated_by,
    },
  });
}

async function collabDeleteAnnotation(
  cfg: DenConfig,
  projectId: string,
  sessionId: number,
  options: { annotation_id: number; expected_revision: number },
): Promise<any> {
  return denFetch(cfg, `/api/projects/${esc(projectId)}/collaboration/sessions/${sessionId}/annotations/${options.annotation_id}?${query({ expectedRevision: options.expected_revision })}`, {
    method: "DELETE",
  });
}

async function collabAddTurn(
  cfg: DenConfig,
  projectId: string,
  sessionId: number,
  options: {
    raw_markdown: string;
    role: string;
    source_kind?: string;
    source_ref?: string;
    source_label?: string;
    source_uri?: string;
    source_context?: Record<string, unknown>;
  },
): Promise<any> {
  const body: Record<string, unknown> = {
    role: options.role,
    raw_markdown: options.raw_markdown,
  };
  if (options.source_kind !== undefined) body.source_kind = options.source_kind;
  if (options.source_ref !== undefined) body.source_ref = options.source_ref;
  if (options.source_label !== undefined) body.source_label = options.source_label;
  if (options.source_uri !== undefined) body.source_uri = options.source_uri;
  if (options.source_context !== undefined && Object.keys(options.source_context).length > 0) {
    body.source_context = options.source_context;
  }
  return denFetch(cfg, `/api/projects/${esc(projectId)}/collaboration/sessions/${sessionId}/turns`, {
    method: "POST",
    body,
  });
}

async function collabSaveDraft(
  cfg: DenConfig,
  projectId: string,
  sessionId: number,
  options: { turn_id?: number; content: string; created_by: string },
): Promise<any> {
  const body: any = {
    turn_id: options.turn_id,
    content: options.content,
    created_by: options.created_by,
  };
  if (body.turn_id === undefined) delete body.turn_id;
  return denFetch(cfg, `/api/projects/${esc(projectId)}/collaboration/sessions/${sessionId}/drafts`, {
    method: "POST",
    body,
  });
}

async function collabUpdateSessionStatus(
  cfg: DenConfig,
  projectId: string,
  sessionId: number,
  options: { expected_status: string; status: string },
): Promise<any> {
  return denFetch(cfg, `/api/projects/${esc(projectId)}/collaboration/sessions/${sessionId}/status`, {
    method: "PATCH",
    body: {
      expected_status: options.expected_status,
      status: options.status,
    },
  });
}

async function collabCompileResponse(
  cfg: DenConfig,
  projectId: string,
  sessionId: number,
  options: { turnId?: number; saveDraft: boolean },
): Promise<{ compiled: string; segmentCount: number; annotationCount: number; draftSaved: boolean }> {
  const session = await collabGetSession(cfg, projectId, sessionId);

  const turns = Array.isArray(session.turns ?? session.Turns) ? (session.turns ?? session.Turns) : [];
  const annotations = Array.isArray(session.annotations ?? session.Annotations) ? (session.annotations ?? session.Annotations) : [];

  // Find target turn
  const targetTurn = options.turnId
    ? turns.find((t: any) => (t.id ?? t.Id) === options.turnId)
    : turns[turns.length - 1];

  if (!targetTurn) {
    throw new Error(`Turn ${options.turnId ?? "latest"} not found in session #${sessionId}.`);
  }

  const segments = Array.isArray(targetTurn.segments ?? targetTurn.Segments) ? (targetTurn.segments ?? targetTurn.Segments) : [];
  const turnId = targetTurn.id ?? targetTurn.Id;

  // Filter annotations to this turn
  const turnAnnotations = annotations.filter((a: any) => (a.turn_id ?? a.TurnId ?? a.turnId) === turnId);

  if (segments.length === 0) {
    throw new Error(`Turn #${turnId} has no segments. Cannot compile response.`);
  }

  const compiled = compileResponse(segments, turnAnnotations);

  let draftSaved = false;
  if (options.saveDraft) {
    await collabSaveDraft(cfg, projectId, sessionId, {
      turn_id: turnId,
      content: compiled,
      created_by: cfg.agent,
    });
    draftSaved = true;
  }

  return { compiled, segmentCount: segments.length, annotationCount: turnAnnotations.length, draftSaved };
}

// ---------------------------------------------------------------------------
// Collaboration command handlers
// ---------------------------------------------------------------------------

export function buildPiSourceContext(cfg: DenConfig, ctx: any, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return compactJsonObject({
    project_id: cfg.projectId,
    current_task_id: currentTaskId,
    agent: cfg.agent,
    role: cfg.role,
    instance_id: cfg.instanceId,
    den_binding_session_id: cfg.sessionId,
    pi_session_id: getPiRuntimeSessionId(ctx),
    pi_session_file: getPiRuntimeSessionFile(ctx),
    model: getPiRuntimeModel(ctx),
    ...extra,
  });
}

function getPiRuntimeSessionId(ctx: any): string | undefined {
  return normalizeString(ctx?.sessionManager?.getSessionId?.());
}

function getPiRuntimeSessionFile(ctx: any): string | undefined {
  return normalizeString(ctx?.sessionManager?.getSessionFile?.());
}

function getPiRuntimeModel(ctx: any): string | undefined {
  const provider = normalizeString(ctx?.model?.provider);
  const id = normalizeString(ctx?.model?.id ?? ctx?.model?.model);
  if (provider && id) return `${provider}/${id}`;
  return id ?? normalizeString(ctx?.model);
}

function compactJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""),
  );
}

async function handleCollabCreate(
  cfg: DenConfig,
  args: string | undefined,
  ctx: any,
): Promise<{ lines: string[] }> {
  const trimmed = (args ?? "").trim();
  let taskId: number | undefined;
  let title: string | undefined;
  let markdown = trimmed;

  // Parse --task <id> and --title <text> flags
  const taskMatch = trimmed.match(/^--task\s+(\d+)\s*/);
  if (taskMatch) {
    taskId = Number(taskMatch[1]);
    markdown = trimmed.slice(taskMatch[0].length).trim();
  }
  // Parse --title with optional quotes
  const titleMatch = markdown.match(/^--title\s+(["'])([^"']+)\1\s+|^--title\s+(\S+)\s*/);
  if (titleMatch) {
    title = titleMatch[2] ?? titleMatch[3];
    markdown = markdown.slice(titleMatch[0].length).trim();
  }

  // If markdown is "-", try to get the last assistant message from Pi context
  if (markdown === "-" || !markdown) {
    const lastAssistant = await getLastAssistantResponse(ctx);
    if (lastAssistant) {
      markdown = lastAssistant;
    } else {
      throw new Error("No assistant response available. Provide markdown content or type '-' to use the last assistant response.");
    }
  }

  const result = await collabCreateSession(cfg, {
    raw_markdown: markdown,
    project_id: cfg.projectId,
    task_id: taskId ?? currentTaskId,
    title: title ?? undefined,
    role: "assistant",
    source_kind: "pi_response",
    created_by: cfg.agent,
    pi_run_id: cfg.instanceId,
    pi_session_id: getPiRuntimeSessionId(ctx) ?? cfg.sessionId,
    source_context: buildPiSourceContext(cfg, ctx, {
      task_id: taskId ?? currentTaskId,
      source_kind: "pi_response",
    }),
  });

  return { lines: result.text.split("\n") };
}

export async function getLastAssistantResponse(ctx: any): Promise<string | undefined> {
  try {
    if (typeof ctx?.getLastAssistantResponse === "function") {
      const direct = normalizeString(await ctx.getLastAssistantResponse());
      if (direct) return direct;
    }

    const fromBranch = extractLastAssistantResponseFromEntries(ctx?.sessionManager?.getBranch?.());
    if (fromBranch) return fromBranch;

    const fromMessages = extractLastAssistantResponseFromEntries(ctx?.getMessages?.());
    if (fromMessages) return fromMessages;
  } catch {
    // Best-effort.
  }
  return undefined;
}

export function extractLastAssistantResponseFromEntries(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) return undefined;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as any;
    const message = entry?.message ?? entry;
    const text = extractAssistantMessageText(message);
    if (text) return text;
  }

  return undefined;
}

export function extractAssistantMessageText(message: any): string | undefined {
  if (!message || message.role !== "assistant") return undefined;
  if (message.stopReason === "toolUse" || message.stopReason === "tool_use" || message.stopReason === "error" || message.stopReason === "aborted") {
    return undefined;
  }

  const content = message.content;
  if (typeof content === "string") return normalizeString(content);
  if (!Array.isArray(content)) return normalizeString(message.text);
  if (content.some((block: any) => block?.type === "toolCall" || block?.type === "tool_call")) return undefined;

  const texts = content
    .map((block: any) => {
      if (typeof block === "string") return block;
      if (block?.type === "text" || block?.type === "output_text") return block.text;
      return undefined;
    })
    .map((text: unknown) => normalizeString(text))
    .filter((text: string | undefined): text is string => Boolean(text));

  return texts.length > 0 ? texts.join("\n") : undefined;
}

async function handleCollabList(
  cfg: DenConfig,
  args: string | undefined,
): Promise<{ lines: string[] }> {
  const trimmed = (args ?? "").trim();
  let taskId: number | undefined;
  let status: string | undefined;

  const taskMatch = trimmed.match(/--task\s+(\d+)/);
  if (taskMatch) taskId = Number(taskMatch[1]);
  const statusMatch = trimmed.match(/--status\s+(\S+)/);
  if (statusMatch) status = statusMatch[1];

  const sessions = await collabListSessions(cfg, {
    projectId: cfg.projectId,
    taskId: taskId ?? currentTaskId,
    status,
    limit: 50,
  });

  if (!Array.isArray(sessions) || sessions.length === 0) {
    return { lines: ["No collaboration sessions found."] };
  }

  const lines = [`${sessions.length} collaboration session(s):`, ""];
  for (const session of sessions) {
    lines.push(...formatSessionSummary(session));
    lines.push("");
  }
  return { lines };
}

async function handleCollabOpen(
  cfg: DenConfig,
  sessionId: number,
): Promise<{ lines: string[]; summary: string }> {
  const session = await collabGetSession(cfg, cfg.projectId, sessionId);
  const lines = formatSessionDetail(session);
  const title = session.title ?? `Session #${sessionId}`;
  return { lines, summary: `Opened ${title}` };
}

async function handleCollabAnnotate(
  cfg: DenConfig,
  args: string | undefined,
): Promise<{ summary: string }> {
  // Parse: <session_id> <segment_id> <note|skip|done|flag> [body...]
  const parts = (args ?? "").trim().split(/\s+/);
  if (parts.length < 3) throw new Error("Usage: /den-collab-annotate <session_id> <segment_id> <note|skip|done|flag> [body]");

  const sessionId = Number(parts[0]);
  if (!Number.isInteger(sessionId) || sessionId <= 0) throw new Error("Expected valid session_id.");
  const segmentId = Number(parts[1]);
  if (!Number.isInteger(segmentId) || segmentId <= 0) throw new Error("Expected valid segment_id.");
  const annotationType = parts[2];
  if (!["note", "skip", "done", "flag"].includes(annotationType)) throw new Error("Annotation type must be note, skip, done, or flag.");
  const body = parts.slice(3).join(" ").trim() || undefined;

  // Resolve turn_id from session
  const session = await collabGetSession(cfg, cfg.projectId, sessionId);
  const turns = Array.isArray(session.turns ?? session.Turns) ? (session.turns ?? session.Turns) : [];
  if (turns.length === 0) throw new Error(`Session #${sessionId} has no turns.`);

  // Find the turn that contains this segment
  let turnId: number | undefined;
  for (const turn of turns) {
    const segments = Array.isArray(turn.segments ?? turn.Segments) ? (turn.segments ?? turn.Segments) : [];
    if (segments.some((s: any) => (s.id ?? s.Id) === segmentId)) {
      turnId = turn.id ?? turn.Id;
      break;
    }
  }
  if (!turnId) throw new Error(`Segment #${segmentId} not found in session #${sessionId}. Use /den-collab-open ${sessionId} to list available segments.`);

  const annotation = await collabCreateAnnotation(cfg, cfg.projectId, sessionId, {
    turn_id: turnId,
    segment_id: segmentId,
    annotation_type: annotationType,
    body,
    created_by: cfg.agent,
  });

  return { summary: `Annotation #${annotation.id} (${annotationType}) created on segment #${segmentId}.` };
}

async function handleCollabDeleteAnnotation(
  cfg: DenConfig,
  args: string | undefined,
): Promise<{ summary: string }> {
  const parts = (args ?? "").trim().split(/\s+/);
  if (parts.length < 3) throw new Error("Usage: /den-collab-delete-annotation <session_id> <annotation_id> <expected_revision>");

  const sessionId = Number(parts[0]);
  if (!Number.isInteger(sessionId) || sessionId <= 0) throw new Error("Expected valid session_id.");
  const annotationId = Number(parts[1]);
  if (!Number.isInteger(annotationId) || annotationId <= 0) throw new Error("Expected valid annotation_id.");
  const expectedRevision = Number(parts[2]);
  if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) throw new Error("Expected valid expected_revision.");

  await collabDeleteAnnotation(cfg, cfg.projectId, sessionId, {
    annotation_id: annotationId,
    expected_revision: expectedRevision,
  });

  return { summary: `Annotation #${annotationId} deleted from session #${sessionId}.` };
}

async function handleCollabCompile(
  cfg: DenConfig,
  args: string | undefined,
): Promise<{ lines: string[]; summary: string }> {
  const parts = (args ?? "").trim().split(/\s+/);
  if (parts.length < 1) throw new Error("Usage: /den-collab-compile <session_id> [turn_id]");

  const sessionId = Number(parts[0]);
  if (!Number.isInteger(sessionId) || sessionId <= 0) throw new Error("Expected valid session_id.");
  const turnId = parts.length > 1 ? Number(parts[1]) : undefined;

  const result = await collabCompileResponse(cfg, cfg.projectId, sessionId, {
    turnId: turnId && Number.isInteger(turnId) && turnId > 0 ? turnId : undefined,
    saveDraft: true,
  });

  const lines = [
    `Compiled response for session #${sessionId} (turn ${result.segmentCount} segments, ${result.annotationCount} annotations):`,
    `Draft saved: ${result.draftSaved}`,
    "",
    ...result.compiled.split("\n"),
  ];
  return { lines, summary: `Compiled response draft for session #${sessionId}.` };
}

async function handleCollabAddTurn(
  cfg: DenConfig,
  args: string | undefined,
  ctx: any,
): Promise<{ summary: string }> {
  // Parse: <session_id> <markdown or ->
  const trimmed = (args ?? "").trim();
  const parts = trimmed.match(/^(\d+)\s+([\s\S]*)$/);
  if (!parts) throw new Error("Usage: /den-collab-add-turn <session_id> <markdown>");

  const sessionId = Number(parts[1]);
  if (!Number.isInteger(sessionId) || sessionId <= 0) throw new Error("Expected valid session_id.");
  let markdown = parts[2].trim();

  if (markdown === "-" || !markdown) {
    const lastAssistant = await getLastAssistantResponse(ctx);
    if (lastAssistant) {
      markdown = lastAssistant;
    } else {
      throw new Error("No assistant response available.");
    }
  }

  const sourceContext = buildPiSourceContext(cfg, ctx, {
    task_id: currentTaskId,
    source_kind: "pi_response",
  });

  const turn = await collabAddTurn(cfg, cfg.projectId, sessionId, {
    raw_markdown: markdown,
    role: "assistant",
    source_kind: "pi_response",
    source_context: Object.keys(sourceContext).length > 0 ? sourceContext : undefined,
  });

  const segments = Array.isArray(turn.segments ?? turn.Segments) ? (turn.segments ?? turn.Segments) : [];
  return { summary: `Turn added to session #${sessionId} with ${segments.length} segment(s).` };
}

async function handleCollabStatus(
  cfg: DenConfig,
  args: string | undefined,
): Promise<{ summary: string }> {
  const parts = (args ?? "").trim().split(/\s+/);
  if (parts.length < 3) throw new Error("Usage: /den-collab-status <session_id> <expected_status> <new_status>");

  const sessionId = Number(parts[0]);
  if (!Number.isInteger(sessionId) || sessionId <= 0) throw new Error("Expected valid session_id.");
  const expectedStatus = parts[1];
  const newStatus = parts[2];

  if (!COLLAB_SESSION_STATUSES.includes(expectedStatus as any)) throw new Error(`Expected status must be one of: ${COLLAB_SESSION_STATUSES.join(", ")}`);
  if (!COLLAB_SESSION_STATUSES.includes(newStatus as any)) throw new Error(`New status must be one of: ${COLLAB_SESSION_STATUSES.join(", ")}`);

  const updated = await collabUpdateSessionStatus(cfg, cfg.projectId, sessionId, {
    expected_status: expectedStatus,
    status: newStatus,
  });

  return { summary: `Session #${sessionId} status changed from ${expectedStatus} to ${newStatus}.` };
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return params.toString();
}

function take(value: unknown, count: number): any[] {
  return Array.isArray(value) ? value.slice(0, count) : [];
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 140);
}

function omitUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function baseUrlFromEnv(): string {
  return normalizeBaseUrl(process.env.DEN_MCP_URL ?? process.env.DEN_MCP_BASE_URL ?? DEFAULT_BASE_URL);
}

function isPathInside(cwd: string, rootPath: string): boolean {
  const normalizedRoot = path.resolve(rootPath);
  return cwd === normalizedRoot || cwd.startsWith(`${normalizedRoot}${path.sep}`);
}

class UnboundProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnboundProjectError";
  }
}

function esc(value: string): string {
  return encodeURIComponent(value);
}
