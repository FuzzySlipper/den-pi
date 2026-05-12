import { errorMessage, normalizeString } from "./den-string-utils.ts";

export const DEN_CONTEXT_COMPACTION_SCHEMA = "den_context_compaction_request";
export const DEN_CONTEXT_COMPACTION_SCHEMA_VERSION = 1;

export type DenContextCompactionRequest = {
  durableContextPosted?: boolean;
  customInstructions?: string | null;
  safePointNotes?: string | null;
  resumeAfterCompaction?: boolean;
};

export type DenContextCompactionOptions = {
  sendResumeMessage?: (message: string) => void | Promise<void>;
};

export const DEFAULT_RESUME_PROMPT =
  "Orchestrator context compaction completed. Re-read your current Den task/thread state (use den_get_task, den_get_messages) and continue with the next step.";

export type DenContextCompactionResult = {
  schema: typeof DEN_CONTEXT_COMPACTION_SCHEMA;
  schema_version: typeof DEN_CONTEXT_COMPACTION_SCHEMA_VERSION;
  requested: boolean;
  status: "requested" | "blocked" | "unavailable" | "failed";
  reason: string;
  custom_instructions: string | null;
  safe_point_notes: string | null;
  resume_configured: boolean;
  resume_note: string | null;
  guardrails: string[];
};

export function defaultOrchestratorCompactionInstructions(): string {
  return [
    "Preserve durable Den workflow state: current task(s), branch/head commits, review status, tests run, decisions, open findings, blockers, and next steps.",
    "Preserve user preferences and architectural/product decisions that affect upcoming work.",
    "Omit low-level tool-call minutiae unless needed to understand unresolved risk or dirty state.",
  ].join(" ");
}

export function requestDenContextCompaction(
  ctx: any,
  request: DenContextCompactionRequest,
  options?: DenContextCompactionOptions,
): DenContextCompactionResult {
  const customInstructions = normalizeString(request.customInstructions) ?? defaultOrchestratorCompactionInstructions();
  const safePointNotes = normalizeString(request.safePointNotes) ?? null;
  const guardrails = compactionGuardrails();
  const resumeAfterCompaction = request.resumeAfterCompaction !== false;
  const sendResume = resumeAfterCompaction && typeof options?.sendResumeMessage === "function";
  const resumeNote = sendResume
    ? `A follow-up prompt will be sent automatically after compaction to resume the orchestrator session.`
    : resumeAfterCompaction
      ? `Resume requested but no sendResumeMessage callback available. The orchestrator session will be suspended after compaction until the operator manually sends a prompt.`
      : `Resume not requested. The orchestrator session will be suspended after compaction until the operator manually sends a prompt.`;

  if (request.durableContextPosted !== true) {
    return {
      schema: DEN_CONTEXT_COMPACTION_SCHEMA,
      schema_version: DEN_CONTEXT_COMPACTION_SCHEMA_VERSION,
      requested: false,
      status: "blocked",
      reason: "Refusing to compact until the orchestrator confirms durable Den context has been posted or is already up to date.",
      custom_instructions: customInstructions,
      safe_point_notes: safePointNotes,
      resume_configured: false,
      resume_note: "Compaction was not requested; resume does not apply.",
      guardrails,
    };
  }

  if (typeof ctx?.compact !== "function") {
    return {
      schema: DEN_CONTEXT_COMPACTION_SCHEMA,
      schema_version: DEN_CONTEXT_COMPACTION_SCHEMA_VERSION,
      requested: false,
      status: "unavailable",
      reason: "This Pi runtime context does not expose ctx.compact(). Ask the user to run /compact or use a Pi RPC/session entrypoint that supports compaction.",
      custom_instructions: customInstructions,
      safe_point_notes: safePointNotes,
      resume_configured: false,
      resume_note: "Compaction was not requested; resume does not apply.",
      guardrails,
    };
  }

  try {
    ctx.compact({
      customInstructions,
      onComplete: () => {
        ctx?.ui?.notify?.("Den orchestrator context compaction completed.", "info");
        if (sendResume) {
          try {
            Promise.resolve(options!.sendResumeMessage!(DEFAULT_RESUME_PROMPT)).catch((resumeError) => {
              ctx?.ui?.notify?.(`Post-compaction resume failed: ${errorMessage(resumeError)}`, "error");
            });
          } catch (resumeError) {
            ctx?.ui?.notify?.(`Post-compaction resume failed: ${errorMessage(resumeError)}`, "error");
          }
        }
      },
      onError: (error: unknown) => {
        ctx?.ui?.notify?.(`Den orchestrator context compaction failed: ${errorMessage(error)}`, "error");
      },
    });
    return {
      schema: DEN_CONTEXT_COMPACTION_SCHEMA,
      schema_version: DEN_CONTEXT_COMPACTION_SCHEMA_VERSION,
      requested: true,
      status: "requested",
      reason: "Compaction was requested for the current Pi session. Pi runs compaction asynchronously. The tool/command returns immediately; compaction and optional resume happen after the current turn ends.",
      custom_instructions: customInstructions,
      safe_point_notes: safePointNotes,
      resume_configured: sendResume,
      resume_note: resumeNote,
      guardrails,
    };
  } catch (error) {
    return {
      schema: DEN_CONTEXT_COMPACTION_SCHEMA,
      schema_version: DEN_CONTEXT_COMPACTION_SCHEMA_VERSION,
      requested: false,
      status: "failed",
      reason: `Compaction request failed before it could start: ${errorMessage(error)}`,
      custom_instructions: customInstructions,
      safe_point_notes: safePointNotes,
      resume_configured: false,
      resume_note: "Compaction failed to start; resume does not apply.",
      guardrails,
    };
  }
}

export function formatDenContextCompactionResult(result: DenContextCompactionResult): string {
  const lines = [
    `Context compaction: ${result.status}`,
    `Requested: ${result.requested ? "yes" : "no"}`,
    `Reason: ${result.reason}`,
    `Instructions: ${result.custom_instructions ?? "(none)"}`,
  ];
  if (result.safe_point_notes) lines.push(`Safe point notes: ${result.safe_point_notes}`);
  lines.push(`Resume after compaction: ${result.resume_configured ? "yes" : "no"}`);
  if (result.resume_note) lines.push(`Resume note: ${result.resume_note}`);
  lines.push("Guardrails:");
  for (const guardrail of result.guardrails) lines.push(`- ${guardrail}`);
  return lines.join("\n");
}

export function buildDenContextCompactionToolResult(result: DenContextCompactionResult) {
  return {
    content: [{ type: "text", text: formatDenContextCompactionResult(result) }],
    details: result,
    isError: !result.requested,
  };
}

export function compactionGuardrails(): string[] {
  return [
    "Post or verify durable Den handoff/status context before compacting.",
    "Prefer task boundaries or just after a merge/review handoff; avoid mid-critical merge, review, or unresolved user-decision points.",
    "Compaction via ctx.compact() is fire-and-forget: the tool/command returns immediately and compaction runs asynchronously after the current turn ends.",
    "After compaction, the orchestrator session will be suspended until a follow-up prompt resumes it. When resume_after_compaction is enabled, the extension sends a resume prompt automatically.",
    "If the extension/session reloads between compaction start and completion, the captured resume callback may be stale; the resume failure is reported and the operator can manually resume.",
    "After compaction (manual or auto-resume), re-check Den task/messages before starting the next substantial task.",
  ];
}
