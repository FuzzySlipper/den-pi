// rusty-debug-attach.ts — PROTOTYPE diagnostic extension
//
// Attaches a pi session to a live rusty-crew service session as a READ-ONLY
// diagnostic viewer. On attach it pulls the service's direct-debug context
// (`GET /v1/debug/sessions/{id}/context`) and "recreates" it as custom messages
// in pi's own history, plus a live status footer + widget.
//
// No rusty-crew code is imported at runtime. This extension talks only to the
// documented, stable, read-only HTTP debug boundary. See:
//   /home/dev/rusty-crew/docs/direct-debug-session-service.md
//   /home/dev/rusty-crew/docs/read-only-admin-diagnostics-api.md
//   /home/dev/rusty-crew/docs/admin-http-host-auth-api-boundary.md
//
// Turn injection (`/rusty-turn`) is gated: it is only attempted when the
// service reports controls.directTurnInjection === "available" AND the user
// opts in via the `--rusty-debug-turn` flag. Default posture is read-only.
//
// Load (does not auto-load; not registered in package.json):
//   pi -e extensions/rusty-debug-attach.ts
//
// Env:
//   RUSTY_DEBUG_BASE_URL  default http://127.0.0.1:9347
//   RUSTY_DEBUG_TOKEN     optional bearer token (admin auth mode != none)
//   RUSTY_DEBUG_REFRESH_MS  optional auto-refresh interval (default 15000; 0 disables)

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateHead, formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";

// --- Loosely-typed shapes mirroring the documented DirectDebugSessionView ----
// Kept loose on purpose so this extension never depends on rusty-crew internals.
interface DirectDebugView {
  generatedAt?: string;
  source?: "direct_debug";
  session?: {
    sessionId: string;
    agentId: string;
    profileId: string;
    kind: string;
    status: string;
    brainTurnCount: number;
    createdAt?: string;
    lastActiveAt?: string;
    toolCount?: number;
    workdir?: string | null;
  };
  diagnostics?: {
    stale?: boolean;
    health?: string;
    degraded?: boolean;
    reasonCodes?: string[];
    issueMessages?: string[];
  };
  selectedTools?: { name: string; description?: string }[];
  context?: {
    rawPromptIncluded?: boolean;
    rawPromptDeniedReason?: string;
    systemPrompt?: { present?: boolean; chars?: number; lines?: number; sha256?: string };
    instructions?: { present?: boolean; chars?: number; lines?: number; sha256?: string };
    sections?: string[];
    initialMessages?: { count?: number; totalChars?: number };
    skills?: { slug: string; title?: string; summary?: string; tags?: string[] }[];
  };
  pendingMessages?: unknown[];
  recentEvents?: {
    id?: string | number;
    createdAt?: string;
    source?: string;
    eventType?: string;
    severity?: string;
    summary?: string;
  }[];
  controls?: { directTurnInjection?: string; reason?: string };
}

interface SessionListItem {
  sessionId: string;
  agentId: string;
  profileId: string;
  kind: string;
  status: string;
  toolCount?: number;
  brainTurnCount?: number;
  lastActiveAt?: string;
  stale?: boolean;
}

// --- Projection shapes for the admin diagnostics snapshot (loose, documented) ---
interface OverviewProjection {
  generatedAt?: string;
  health?: string;
  degraded?: boolean;
  reasonCodes?: string[];
  summary?: {
    sessions?: number;
    activeSessions?: number;
    idleSessions?: number;
    archivedSessions?: number;
    delegatedSessions?: number;
    blockedDelegations?: number;
    pendingQueueItems?: number;
    expiredQueueItems?: number;
    toolErrors?: number;
    recentErrors?: number;
  };
  queues?: { pending?: number; expired?: number; discarded?: number; oldestPendingAgeMs?: number };
  persistence?: { schemaVersion?: number; databaseBytes?: number; pressure?: boolean; searchHealthy?: boolean };
  issues?: { code?: string; severity?: string; message?: string }[];
}

interface ToolCatalogItem {
  catalogId: string;
  registeredTools?: number;
  selectedTools?: number;
  validationErrors?: number;
  validationWarnings?: number;
  invalid?: boolean;
}

interface McpSurfaceItem {
  bindingId: string;
  adapterId?: string;
  agentId?: string;
  sessionId?: string;
  profileId?: string;
  status?: string;
  transport?: string;
  serverNames?: string[];
  toolProfileKey?: string;
  reconnectAttempts?: number;
  collisionCount?: number;
  discoveryIssueCount?: number;
  optionalServerFailures?: string[];
  lastError?: string;
}

interface ChannelItem {
  bindingId: string;
  adapterId?: string;
  agentId?: string;
  sessionId?: string;
  profileId?: string;
  provider?: string;
  status?: string;
  membershipStatus?: string;
  presenceStatus?: string;
  subscriptionStatus?: string;
  stalePresence?: boolean;
  droppedProjections?: number;
  lastError?: string;
}

interface AgentItem {
  agentId: string;
  profileId?: string;
  sessions?: number;
  activeSessions?: number;
  idleSessions?: number;
  archivedSessions?: number;
  staleSessions?: number;
}

interface PersistenceProjection {
  tableCounts?: Record<string, number>;
  searchHealthy?: boolean;
  databaseBytes?: number;
  pressure?: boolean;
}

interface ObservationProjection {
  enabled?: boolean;
  writerAvailable?: boolean;
  degraded?: boolean;
  lastError?: string;
}

interface MetricItem {
  name: string;
  value: number;
  labels?: Record<string, string>;
}

interface RecentEventItem {
  id?: string | number;
  createdAt?: string;
  source?: string;
  eventType?: string;
  severity?: string;
  summary?: string;
}

interface AdminPage<T> {
  items: T[];
  total: number;
  limit?: number;
  offset?: number;
  nextOffset?: number;
}

type SafeResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface RuntimeSnapshot {
  overview: SafeResult<OverviewProjection | undefined>;
  sessions: SafeResult<AdminPage<SessionListItem>>;
  agents: SafeResult<AdminPage<AgentItem>>;
  delegations: SafeResult<AdminPage<Record<string, unknown>>>;
  tools: SafeResult<AdminPage<ToolCatalogItem>>;
  mcp: SafeResult<AdminPage<McpSurfaceItem>>;
  channels: SafeResult<AdminPage<ChannelItem>>;
  persistence: SafeResult<PersistenceProjection | null>;
  observation: SafeResult<ObservationProjection | null>;
  background: SafeResult<unknown | null>;
  metrics: SafeResult<AdminPage<MetricItem>>;
}

interface EnvelopeError {
  ok: false;
  error: { code: string; reason_code?: string; message: string; retryable?: boolean };
}

// --- Minimal self-contained read client over the documented stable routes ---
async function adminGet<T>(path: string, timeoutMs = 4000): Promise<T> {
  const base = process.env.RUSTY_DEBUG_BASE_URL ?? "http://127.0.0.1:9347";
  const token = process.env.RUSTY_DEBUG_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(path, base).toString(), {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    const body = (await res.json()) as { ok: true; data: T } | EnvelopeError;
    if (!res.ok || body.ok !== true) {
      const err = body.ok === false ? body.error : undefined;
      throw new Error(
        `${path} -> HTTP ${res.status}${err ? ` ${err.code}: ${err.message}` : ""}`,
      );
    }
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

async function debugPost<T>(path: string, body: unknown, timeoutMs = 8000): Promise<T> {
  const base = process.env.RUSTY_DEBUG_BASE_URL ?? "http://127.0.0.1:9347";
  const token = process.env.RUSTY_DEBUG_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(path, base).toString(), {
      method: "POST",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: true; data: T } | EnvelopeError;
    if (!res.ok || json.ok !== true) {
      const err = json.ok === false ? json.error : undefined;
      throw new Error(
        `${path} -> HTTP ${res.status}${err ? ` ${err.code}: ${err.message}` : ""}`,
      );
    }
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

function shortId(id: string | undefined, n = 12): string {
  return id ? (id.length <= n ? id : `${id.slice(0, n)}…`) : "—";
}

function joinList(items: string[] | undefined, fallback = "—"): string {
  return items && items.length ? items.join(", ") : fallback;
}

// Render a fetched view into styled lines for the custom message renderer.
function viewToLines(view: DirectDebugView): string[] {
  const s = view.session;
  const d = view.diagnostics;
  const lines: string[] = [];
  if (s) {
    lines.push(
      `session ${s.sessionId}  agent=${s.agentId}  profile=${s.profileId}`,
    );
    lines.push(
      `kind=${s.kind}  status=${s.status}  turns=${s.brainTurnCount}  tools=${s.toolCount ?? 0}` +
        (s.workdir ? `  workdir=${s.workdir}` : ""),
    );
    if (s.createdAt) lines.push(`created=${s.createdAt}  lastActive=${s.lastActiveAt ?? "?"}`);
  }
  if (d) {
    lines.push(
      `runtime health=${d.health ?? "?"}  stale=${d.stale ?? "?"}  degraded=${d.degraded ?? "?"}` +
        `  reasons=[${joinList(d.reasonCodes, "")}]`,
    );
    for (const m of (d.issueMessages ?? []).slice(0, 4)) lines.push(`  • ${m}`);
  }
  const sel = view.selectedTools ?? [];
  if (sel.length) {
    lines.push(`tools(${sel.length}): ${sel.map((t) => t.name).join(", ")}`);
  }
  const c = view.context;
  if (c) {
    lines.push(
      `prompt raw=${c.rawPromptIncluded ? "yes" : "no"}` +
        `  system=${c.systemPrompt?.chars ?? 0}c/${c.systemPrompt?.lines ?? 0}L` +
        `  instr=${c.instructions?.chars ?? 0}c/${c.instructions?.lines ?? 0}L`,
    );
    if (c.sections?.length) lines.push(`sections: ${c.sections.join(" | ")}`);
    if (c.initialMessages) lines.push(`initialMsgs=${c.initialMessages.count}`);
    if (c.skills?.length) lines.push(`skills: ${c.skills.map((k) => k.slug).join(", ")}`);
  }
  if (view.pendingMessages?.length) {
    lines.push(`pending messages: ${view.pendingMessages.length}`);
  }
  if (view.controls) {
    lines.push(`direct-turn: ${view.controls.directTurnInjection} (${view.controls.reason ?? ""})`);
  }
  return lines;
}

// --- Snapshot aggregation + rendering (mirrors adapter-tui/debug-tui.ts) ---

async function safeGet<T>(path: string, timeoutMs = 4000): Promise<SafeResult<T>> {
  try {
    const data = await adminGet<T>(path, timeoutMs);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function fetchSnapshot(limit = 50): Promise<RuntimeSnapshot> {
  const [overview, sessions, agents, delegations, tools, mcp, channels, persistence, observation, background, metrics] =
    await Promise.all([
      safeGet<OverviewProjection | undefined>("/v1/admin/diagnostics/overview"),
      safeGet<AdminPage<SessionListItem>>(`/v1/admin/diagnostics/sessions?limit=${limit}`),
      safeGet<AdminPage<AgentItem>>(`/v1/admin/diagnostics/agents?limit=${limit}`),
      safeGet<AdminPage<Record<string, unknown>>>(`/v1/admin/diagnostics/delegations?limit=${limit}`),
      safeGet<AdminPage<ToolCatalogItem>>(`/v1/admin/diagnostics/tools?limit=${limit}`),
      safeGet<AdminPage<McpSurfaceItem>>(`/v1/admin/diagnostics/mcp?limit=${limit}`),
      safeGet<AdminPage<ChannelItem>>(`/v1/admin/diagnostics/channels?limit=${limit}`),
      safeGet<PersistenceProjection | null>("/v1/admin/diagnostics/persistence"),
      safeGet<ObservationProjection | null>("/v1/admin/diagnostics/observation"),
      safeGet<unknown | null>("/v1/admin/diagnostics/background"),
      safeGet<AdminPage<MetricItem>>(`/v1/admin/diagnostics/metrics?limit=30`),
    ]);
  return { overview, sessions, agents, delegations, tools, mcp, channels, persistence, observation, background, metrics };
}

function cell(v: unknown, max = 24): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function tableLines(headers: string[], rows: string[][]): string[] {
  const out = [headers.join(" | "), headers.map(() => "---").join(" | ")];
  for (const r of rows) out.push(r.join(" | "));
  return out;
}

function kvLines(obj: Record<string, unknown>, max = 50): string[] {
  return Object.entries(obj).map(([k, v]) => `${k}: ${cell(v, max)}`);
}

function renderOverviewLines(o: OverviewProjection | undefined): string[] {
  if (!o) return ["(no overview)"];
  const s = o.summary ?? {};
  const q = o.queues ?? {};
  const out: string[] = [];
  out.push(
    `health=${o.health ?? "?"} degraded=${o.degraded ?? "?"} reasons=[${(o.reasonCodes ?? []).join(", ") || "ok"}]`,
  );
  out.push(
    `sessions total=${s.sessions ?? 0} active=${s.activeSessions ?? 0} idle=${s.idleSessions ?? 0} archived=${s.archivedSessions ?? 0}`,
  );
  out.push(`delegations total=${s.delegatedSessions ?? 0} blocked=${s.blockedDelegations ?? 0}`);
  out.push(
    `queues pending=${q.pending ?? s.pendingQueueItems ?? 0} expired=${q.expired ?? s.expiredQueueItems ?? 0} toolErrors=${s.toolErrors ?? 0} recentErrors=${s.recentErrors ?? 0}`,
  );
  if (o.issues?.length) {
    out.push("issues:");
    for (const i of o.issues.slice(0, 8))
      out.push(`  • ${i.severity ?? "?"} ${i.code ?? ""}: ${cell(i.message, 90)}`);
  }
  return out;
}

function renderSessionsLines(items: SessionListItem[]): string[] {
  if (!items.length) return ["(no sessions)"];
  return tableLines(
    ["session", "agent", "profile", "kind", "status", "turns", "tools", "stale"],
    items.map((s) => [
      cell(s.sessionId, 22),
      cell(s.agentId, 12),
      cell(s.profileId, 12),
      cell(s.kind, 8),
      cell(s.status, 10),
      String(s.brainTurnCount ?? 0),
      String(s.toolCount ?? 0),
      s.stale ? "yes" : "no",
    ]),
  );
}

function renderAgentsLines(items: AgentItem[]): string[] {
  if (!items.length) return ["(no agents)"];
  return tableLines(
    ["agent", "profile", "sessions", "active", "idle", "archived", "stale"],
    items.map((a) => [
      cell(a.agentId, 14),
      cell(a.profileId, 12),
      String(a.sessions ?? 0),
      String(a.activeSessions ?? 0),
      String(a.idleSessions ?? 0),
      String(a.archivedSessions ?? 0),
      String(a.staleSessions ?? 0),
    ]),
  );
}

function renderToolsLines(items: ToolCatalogItem[]): string[] {
  if (!items.length) return ["(no tool catalogs)"];
  return tableLines(
    ["catalog", "registered", "selected", "errors", "warnings", "invalid"],
    items.map((t) => [
      cell(t.catalogId, 22),
      String(t.registeredTools ?? 0),
      String(t.selectedTools ?? 0),
      String(t.validationErrors ?? 0),
      String(t.validationWarnings ?? 0),
      t.invalid ? "yes" : "no",
    ]),
  );
}

function renderMcpLines(items: McpSurfaceItem[]): string[] {
  if (!items.length) return ["(no mcp surfaces)"];
  return tableLines(
    ["binding", "adapter", "agent", "status", "transport", "servers", "collisions", "issues"],
    items.map((m) => [
      cell(m.bindingId, 18),
      cell(m.adapterId, 14),
      cell(m.agentId, 12),
      cell(m.status, 10),
      cell(m.transport, 8),
      cell((m.serverNames ?? []).join(",") || "-", 16),
      String(m.collisionCount ?? 0),
      String((m.discoveryIssueCount ?? 0) + (m.optionalServerFailures?.length ?? 0)),
    ]),
  );
}

function renderChannelsLines(items: ChannelItem[]): string[] {
  if (!items.length) return ["(no channel bindings)"];
  return tableLines(
    ["binding", "adapter", "agent", "provider", "status", "presence", "dropped"],
    items.map((c) => [
      cell(c.bindingId, 18),
      cell(c.adapterId, 14),
      cell(c.agentId, 12),
      cell(c.provider, 14),
      cell(c.status, 10),
      cell(c.presenceStatus, 10),
      String(c.droppedProjections ?? 0),
    ]),
  );
}

function renderPersistenceLines(p: PersistenceProjection | null | undefined): string[] {
  if (!p) return ["(persistence diagnostics not configured)"];
  const counts = p.tableCounts ?? {};
  const out: string[] = [];
  out.push(`databaseBytes=${cell(p.databaseBytes, 14)} pressure=${p.pressure ?? "?"} searchHealthy=${p.searchHealthy ?? "?"}`);
  const entries = Object.entries(counts);
  if (entries.length) {
    out.push("table counts:");
    for (const [k, v] of entries.slice(0, 16)) out.push(`  ${k}: ${v}`);
  }
  return out;
}

function renderObservationLines(o: ObservationProjection | null | undefined): string[] {
  if (!o) return ["(observation not configured)"];
  return kvLines({
    enabled: o.enabled,
    writerAvailable: o.writerAvailable,
    degraded: o.degraded,
    lastError: o.lastError ?? "none",
  });
}

function renderBackgroundLines(b: unknown): string[] {
  if (!b) return ["(no background diagnostics)"];
  if (typeof b === "object" && b) {
    const entries = Object.entries(b as Record<string, unknown>).slice(0, 12);
    if (entries.length) return ["background:", ...entries.map(([k, v]) => `  ${k}: ${cell(v, 60)}`)];
  }
  return [`(background diagnostics: ${cell(b, 60)})`];
}

function renderMetricsLines(items: MetricItem[]): string[] {
  if (!items.length) return ["(no metrics)"];
  return tableLines(
    ["metric", "value", "labels"],
    items.map((m) => [
      cell(m.name, 42),
      String(m.value),
      m.labels ? cell(JSON.stringify(m.labels), 30) : "-",
    ]),
  );
}

function renderDelegationsLines(items: Record<string, unknown>[]): string[] {
  if (!items.length) return ["(no active delegations)"];
  const out = [`count: ${items.length}`];
  const first = items[0]!;
  out.push("first item:");
  for (const [k, v] of Object.entries(first).slice(0, 10)) out.push(`  ${k}: ${cell(v, 50)}`);
  return out;
}

// Compose every section into one block. Errors per-section are shown inline
// rather than aborting the whole snapshot.
function renderSnapshotLines(snap: RuntimeSnapshot): { lines: string[]; generatedAt?: string } {
  const out: string[] = [];
  const push = (title: string, res: SafeResult<unknown>, fn: (data: any) => string[]) => {
    out.push(`» ${title}`);
    if (!res.ok) {
      out.push(`! ${title.toLowerCase()}: ${res.error}`);
    } else {
      out.push(...fn(res.data));
    }
    out.push("");
  };
  push("Overview", snap.overview, (o) => renderOverviewLines(o));
  push("Agents", snap.agents, (p) => renderAgentsLines(p?.items ?? []));
  push("Sessions", snap.sessions, (p) => renderSessionsLines(p?.items ?? []));
  push("Delegations", snap.delegations, (p) => renderDelegationsLines(p?.items ?? []));
  push("Tool catalogs", snap.tools, (p) => renderToolsLines(p?.items ?? []));
  push("MCP surfaces", snap.mcp, (p) => renderMcpLines(p?.items ?? []));
  push("Channel bindings", snap.channels, (p) => renderChannelsLines(p?.items ?? []));
  push("Persistence", snap.persistence, (p) => renderPersistenceLines(p));
  push("Observation", snap.observation, (o) => renderObservationLines(o));
  push("Background", snap.background, (b) => renderBackgroundLines(b));
  push("Metrics", snap.metrics, (p) => renderMetricsLines(p?.items ?? []));
  const generatedAt = snap.overview.ok ? snap.overview.data?.generatedAt : undefined;
  return { lines: out, generatedAt };
}

function snapshotSummary(snap: RuntimeSnapshot): string {
  const health = snap.overview.ok ? snap.overview.data?.health ?? "?" : "err";
  const sessions = snap.sessions.ok ? snap.sessions.data.total : "?";
  const tools = snap.tools.ok ? snap.tools.data.total : "?";
  const mcp = snap.mcp.ok ? snap.mcp.data.total : "?";
  const channels = snap.channels.ok ? snap.channels.data.total : "?";
  return `rusty snapshot: health=${health} sessions=${sessions} tools=${tools} mcp=${mcp} channels=${channels}`;
}

// --- LLM-facing section gatherer (option B: rusty_inspect tool) ---
// Pulls only the requested section (no full fanout) and returns a SafeResult so
// the tool can present failures as readable text instead of throwing.
type RustySection =
  | "snapshot"
  | "context"
  | "overview"
  | "sessions"
  | "agents"
  | "tools"
  | "mcp"
  | "channels"
  | "persistence"
  | "observation"
  | "background"
  | "metrics"
  | "events";

function renderEventsLines(items: RecentEventItem[]): string[] {
  if (!items.length) return ["(no recent events)"];
  return tableLines(
    ["created", "source", "type", "severity", "summary"],
    items.map((e) => [cell(e.createdAt, 24), cell(e.source, 16), cell(e.eventType, 22), cell(e.severity ?? "info", 8), cell(e.summary, 60)]),
  );
}

async function gatherSection(
  section: RustySection,
  sid: string | undefined,
  limit: number,
): Promise<SafeResult<{ title: string; lines: string[]; generatedAt?: string }>> {
  try {
    switch (section) {
      case "snapshot": {
        const snap = await fetchSnapshot(limit);
        const r = renderSnapshotLines(snap);
        return { ok: true, data: { title: "rusty-crew runtime snapshot", lines: r.lines, generatedAt: r.generatedAt } };
      }
      case "context": {
        const view = await adminGet<DirectDebugView>(`/v1/debug/sessions/${encodeURIComponent(sid!)}/context`);
        return { ok: true, data: { title: `session ${sid} context`, lines: viewToLines(view), generatedAt: view.generatedAt } };
      }
      case "overview": {
        const o = await adminGet<OverviewProjection | undefined>("/v1/admin/diagnostics/overview");
        return { ok: true, data: { title: "overview", lines: renderOverviewLines(o), generatedAt: o?.generatedAt } };
      }
      case "sessions": {
        const p = await adminGet<AdminPage<SessionListItem>>(`/v1/admin/diagnostics/sessions?limit=${limit}`);
        const lines = [...renderSessionsLines(p.items), `total=${p.total}${p.nextOffset ? ` (showing first ${p.items.length})` : ""}`];
        return { ok: true, data: { title: "sessions", lines } };
      }
      case "agents": {
        const p = await adminGet<AdminPage<AgentItem>>(`/v1/admin/diagnostics/agents?limit=${limit}`);
        return { ok: true, data: { title: "agents", lines: renderAgentsLines(p.items) } };
      }
      case "tools": {
        const p = await adminGet<AdminPage<ToolCatalogItem>>(`/v1/admin/diagnostics/tools?limit=${limit}`);
        return { ok: true, data: { title: "tool catalogs", lines: renderToolsLines(p.items) } };
      }
      case "mcp": {
        const p = await adminGet<AdminPage<McpSurfaceItem>>(`/v1/admin/diagnostics/mcp?limit=${limit}`);
        return { ok: true, data: { title: "mcp surfaces", lines: renderMcpLines(p.items) } };
      }
      case "channels": {
        const p = await adminGet<AdminPage<ChannelItem>>(`/v1/admin/diagnostics/channels?limit=${limit}`);
        return { ok: true, data: { title: "channel bindings", lines: renderChannelsLines(p.items) } };
      }
      case "persistence": {
        const p = await adminGet<PersistenceProjection | null>("/v1/admin/diagnostics/persistence");
        return { ok: true, data: { title: "persistence", lines: renderPersistenceLines(p) } };
      }
      case "observation": {
        const o = await adminGet<ObservationProjection | null>("/v1/admin/diagnostics/observation");
        return { ok: true, data: { title: "observation", lines: renderObservationLines(o) } };
      }
      case "background": {
        const b = await adminGet<unknown | null>("/v1/admin/diagnostics/background");
        return { ok: true, data: { title: "background", lines: renderBackgroundLines(b) } };
      }
      case "metrics": {
        const m = await adminGet<AdminPage<MetricItem>>(`/v1/admin/diagnostics/metrics?limit=${Math.min(limit, 60)}`);
        const lines = [
          ...renderMetricsLines(m.items),
          m.nextOffset ? `(...${m.total - m.items.length} more, total=${m.total})` : `total=${m.total}`,
        ];
        return { ok: true, data: { title: "metrics", lines } };
      }
      case "events": {
        if (sid) {
          // Session-scoped events come from the direct-debug context route.
          const view = await adminGet<DirectDebugView>(
            `/v1/debug/sessions/${encodeURIComponent(sid)}/context?max_recent_events=${limit}`,
          );
          return { ok: true, data: { title: `events for ${sid}`, lines: renderEventsLines((view.recentEvents ?? []) as RecentEventItem[]) } };
        }
        const p = await adminGet<AdminPage<RecentEventItem>>(`/v1/admin/events/recent?limit=${limit}`);
        const lines = [...renderEventsLines(p.items), `total=${p.total}${p.nextOffset ? ` (showing first ${p.items.length})` : ""}`];
        return { ok: true, data: { title: "recent events", lines } };
      }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export default function rustyDebugAttach(pi: ExtensionAPI) {
  let attachedId: string | undefined;
  let lastView: DirectDebugView | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  function clearTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  }

  function setWidgetFromView(view: DirectDebugView | undefined, ctx: { ui: any }) {
    if (!view) {
      ctx.ui.setWidget("rusty-debug", undefined);
      return;
    }
    const s = view.session;
    const d = view.diagnostics;
    const badge = d?.health === "ok" ? "OK" : d?.health === "degraded" ? "DEGRADED" : "BLOCKED";
    ctx.ui.setWidget("rusty-debug", [
      `rusty-crew ▸ ${shortId(s?.sessionId)} [${s?.status ?? "?"}] ${badge}`,
      `agent=${s?.agentId ?? "?"} profile=${s?.profileId ?? "?"} turns=${s?.brainTurnCount ?? 0} tools=${s?.selectedTools?.length ?? s?.toolCount ?? 0}`,
      `reasons=[${joinList(d?.reasonCodes, "ok")}]  generated=${view.generatedAt ?? "?"}`,
    ]);
  }

  function pushViewToHistory(view: DirectDebugView) {
    // "Recreate" the attached session context in pi's own history as custom,
    // display-only messages. triggerTurn:false => no LLM call is spent on it.
    pi.sendMessage(
      {
        customType: "rusty_debug",
        content: "attached session context",
        display: true,
        details: { kind: "context", lines: viewToLines(view), generatedAt: view.generatedAt },
      },
      { triggerTurn: false },
    );
  }

  async function refresh(
    ctx: { ui: any },
    opts: { push?: boolean; notify?: boolean } = {},
  ): Promise<void> {
    if (!attachedId) return;
    try {
      const view = await adminGet<DirectDebugView>(
        `/v1/debug/sessions/${encodeURIComponent(attachedId)}/context`,
      );
      lastView = view;
      setWidgetFromView(view, ctx);
      ctx.ui.setStatus(
        "rusty-debug",
        `${shortId(attachedId)} ${view.session?.status ?? "?"} ${view.diagnostics?.health ?? ""}`,
      );
      if (opts.push) pushViewToHistory(view);
      if (opts.notify) ctx.ui.notify("rusty-debug refreshed", "info");
    } catch (err) {
      clearTimer();
      ctx.ui.setStatus("rusty-debug", undefined);
      ctx.ui.setWidget("rusty-debug", undefined);
      ctx.ui.notify(`rusty-debug refresh failed: ${(err as Error).message}`, "error");
    }
  }

  function startTimer(ctx: { ui: any }) {
    clearTimer();
    const ms = Number(process.env.RUSTY_DEBUG_REFRESH_MS ?? 15000);
    if (ms > 0) refreshTimer = setInterval(() => void refresh(ctx), ms);
  }

  // Custom rendering for the injected history blocks.
  // Section headers are prefixed `» `, errors `! ` so they color differently.
  pi.registerMessageRenderer("rusty_debug", (message, _options, theme) => {
    const details = (message.details ?? {}) as {
      lines?: string[];
      title?: string;
      kind?: string;
      generatedAt?: string;
    };
    const head = theme.fg("accent", `◇ ${details.title ?? "rusty-crew debug"}`);
    const body = (details.lines ?? [String(message.content ?? "")])
      .map((l) => {
        const s = String(l);
        if (s.startsWith("» ")) return theme.fg("accent", theme.bold(s));
        if (s.startsWith("! ")) return theme.fg("error", s);
        return theme.fg("muted", s);
      })
      .join("\n");
    const stamp = details.generatedAt
      ? `\n${theme.fg("dim", `generated ${details.generatedAt}`)}`
      : "";
    return new Text(`${head}\n${body}${stamp}`, 0, 0);
  });

  // /rusty-sessions — pick a live session from the diagnostics list.
  pi.registerCommand("rusty-sessions", {
    description: "List rusty-crew sessions and attach to one",
    handler: async (_args, ctx) => {
      try {
        const page = await adminGet<{ items: SessionListItem[]; total: number }>(
          "/v1/admin/diagnostics/sessions?limit=100",
        );
        if (!page.items.length) {
          ctx.ui.notify("no rusty-crew sessions found", "info");
          return;
        }
        const labels = page.items.map(
          (s) =>
            `${shortId(s.sessionId, 20)} [${s.status}] agent=${s.agentId} profile=${s.profileId} turns=${s.brainTurnCount ?? 0}${s.stale ? " stale" : ""}`,
        );
        const choice = await ctx.ui.select("rusty-crew sessions:", labels);
        if (choice === undefined) return;
        const target = page.items[labels.indexOf(choice)];
        if (target) await attachTo(target.sessionId, ctx);
      } catch (err) {
        ctx.ui.notify(`rusty-sessions failed: ${(err as Error).message}`, "error");
      }
    },
  });

  // /rusty-attach [sessionId] — attach, dump context to history, start live view.
  async function attachTo(sessionId: string, ctx: any) {
    attachedId = sessionId;
    await refresh(ctx, { push: true, notify: false });
    startTimer(ctx);
    pi.setSessionName?.(`rusty-debug ▸ ${shortId(sessionId)}`);
    ctx.ui.notify(`attached to ${shortId(sessionId)} (read-only)`, "info");
  }

  pi.registerCommand("rusty-attach", {
    description: "Attach to a rusty-crew session by id (read-only diagnostic)",
    getArgumentCompletions: async (prefix: string) => {
      try {
        const page = await adminGet<{ items: SessionListItem[] }>(
          "/v1/admin/diagnostics/sessions?limit=100",
        );
        const items = page.items
          .map((s) => ({ value: s.sessionId, label: s.sessionId }))
          .filter((i) => i.value.startsWith(prefix));
        return items.length ? items : null;
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      const id = (args ?? "").trim();
      if (id) return attachTo(id, ctx);
      // No arg: open the picker.
      try {
        const page = await adminGet<{ items: SessionListItem[] }>(
          "/v1/admin/diagnostics/sessions?limit=100",
        );
        const labels = page.items.map(
          (s) => `${shortId(s.sessionId, 24)} [${s.status}] agent=${s.agentId}`,
        );
        const choice = await ctx.ui.select("attach to session:", labels);
        if (choice === undefined) return;
        const target = page.items[labels.indexOf(choice)];
        if (target) await attachTo(target.sessionId, ctx);
      } catch (err) {
        ctx.ui.notify(`rusty-attach failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("rusty-refresh", {
    description: "Re-fetch the attached rusty-crew session context",
    handler: async (_args, ctx) => {
      if (!attachedId) {
        ctx.ui.notify("not attached (use /rusty-attach)", "warning");
        return;
      }
      await refresh(ctx, { push: true, notify: true });
    },
  });

  pi.registerCommand("rusty-events", {
    description: "Dump recent runtime events for the attached session into history",
    handler: async (_args, ctx) => {
      if (!attachedId) {
        ctx.ui.notify("not attached (use /rusty-attach)", "warning");
        return;
      }
      try {
        const view = await adminGet<DirectDebugView>(
          `/v1/debug/sessions/${encodeURIComponent(attachedId)}/context?max_recent_events=20`,
        );
        const events = view.recentEvents ?? [];
        const lines = events.map(
          (e) => `${e.createdAt ?? ""} ${e.source ?? "?"}/${e.eventType ?? "?"} ${e.summary ?? ""}`,
        );
        pi.sendMessage(
          {
            customType: "rusty_debug",
            content: "recent events",
            display: true,
            details: {
              kind: "events",
              lines: lines.length ? lines : ["(no recent events)"],
              generatedAt: view.generatedAt,
            },
          },
          { triggerTurn: false },
        );
      } catch (err) {
        ctx.ui.notify(`rusty-events failed: ${(err as Error).message}`, "error");
      }
    },
  });

  // --- snapshot / section dump helpers ---
  // content stays short (what the LLM sees); the full render lives in details.lines
  // (what the TUI shows) so diagnostic dumps don't bloat LLM context.
  function dumpBlock(
    title: string,
    lines: string[],
    opts: { kind?: string; content?: string; generatedAt?: string } = {},
  ) {
    pi.sendMessage(
      {
        customType: "rusty_debug",
        content: opts.content ?? title,
        display: true,
        details: { kind: opts.kind ?? "snapshot", title, lines, generatedAt: opts.generatedAt },
      },
      { triggerTurn: false },
    );
  }

  // Aggregate the full runtime snapshot and dump it to history (option A).
  // Also refreshes the live widget with a compact overview line.
  pi.registerCommand("rusty-snapshot", {
    description: "Dump a full rusty-crew runtime snapshot (overview/sessions/agents/tools/mcp/channels/persistence/metrics) into history",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("rusty-debug", "fetching snapshot…");
      try {
        const snap = await fetchSnapshot();
        const { lines, generatedAt } = renderSnapshotLines(snap);
        dumpBlock("rusty-crew runtime snapshot", lines, {
          kind: "snapshot",
          content: snapshotSummary(snap),
          generatedAt,
        });
        const o = snap.overview.ok ? snap.overview.data : undefined;
        ctx.ui.setWidget("rusty-debug", [
          `rusty-crew ▸ snapshot ${o?.health ?? "?"} degraded=${o?.degraded ?? "?"}`,
          `reasons=[${(o?.reasonCodes ?? []).join(", ") || "ok"}] generated=${generatedAt ?? "?"}`,
        ]);
        ctx.ui.setStatus("rusty-debug", `snapshot ${o?.health ?? "?"}`);
        ctx.ui.notify("snapshot dumped to history", "info");
      } catch (err) {
        ctx.ui.setStatus("rusty-debug", undefined);
        ctx.ui.notify(`rusty-snapshot failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("rusty-tools", {
    description: "Dump rusty-crew tool catalogs into history",
    handler: async (_args, ctx) => {
      const snap = await fetchSnapshot();
      dumpBlock(
        "rusty-crew tool catalogs",
        snap.tools.ok ? renderToolsLines(snap.tools.data.items) : [`! tools: ${snap.tools.error}`],
        { kind: "section", content: `tools: ${snap.tools.ok ? snap.tools.data.total : "err"} catalogs`, generatedAt: snap.overview.ok ? snap.overview.data?.generatedAt : undefined },
      );
    },
  });

  pi.registerCommand("rusty-mcp", {
    description: "Dump rusty-crew MCP surfaces into history",
    handler: async (_args, ctx) => {
      const snap = await fetchSnapshot();
      dumpBlock(
        "rusty-crew mcp surfaces",
        snap.mcp.ok ? renderMcpLines(snap.mcp.data.items) : [`! mcp: ${snap.mcp.error}`],
        { kind: "section", content: `mcp: ${snap.mcp.ok ? snap.mcp.data.total : "err"} surfaces`, generatedAt: snap.overview.ok ? snap.overview.data?.generatedAt : undefined },
      );
    },
  });

  pi.registerCommand("rusty-channels", {
    description: "Dump rusty-crew channel bindings into history",
    handler: async (_args, ctx) => {
      const snap = await fetchSnapshot();
      dumpBlock(
        "rusty-crew channel bindings",
        snap.channels.ok ? renderChannelsLines(snap.channels.data.items) : [`! channels: ${snap.channels.error}`],
        { kind: "section", content: `channels: ${snap.channels.ok ? snap.channels.data.total : "err"} bindings`, generatedAt: snap.overview.ok ? snap.overview.data?.generatedAt : undefined },
      );
    },
  });

  // "queues" tab from debug-tui = persistence + observation + background + queue summary.
  pi.registerCommand("rusty-runtime", {
    description: "Dump rusty-crew queues/persistence/observation/background into history",
    handler: async (_args, ctx) => {
      const snap = await fetchSnapshot();
      const lines: string[] = [];
      lines.push("» Queue summary");
      lines.push(
        ...(snap.overview.ok
          ? renderOverviewLines(snap.overview.data).filter((l) => l.startsWith("queues"))
          : [`! overview: ${snap.overview.error}`]),
      );
      lines.push("");
      lines.push("» Persistence");
      lines.push(...(snap.persistence.ok ? renderPersistenceLines(snap.persistence.data) : [`! persistence: ${snap.persistence.error}`]));
      lines.push("");
      lines.push("» Observation");
      lines.push(...(snap.observation.ok ? renderObservationLines(snap.observation.data) : [`! observation: ${snap.observation.error}`]));
      lines.push("");
      lines.push("» Background");
      lines.push(...(snap.background.ok ? renderBackgroundLines(snap.background.data) : [`! background: ${snap.background.error}`]));
      dumpBlock("rusty-crew runtime internals", lines, {
        kind: "section",
        generatedAt: snap.overview.ok ? snap.overview.data?.generatedAt : undefined,
      });
    },
  });

  pi.registerCommand("rusty-metrics", {
    description: "Dump rusty-crew runtime metrics into history",
    handler: async (_args, ctx) => {
      const snap = await fetchSnapshot();
      const m = snap.metrics;
      dumpBlock(
        "rusty-crew metrics",
        m.ok
          ? [...renderMetricsLines(m.data.items), m.data.nextOffset ? `(...${m.data.total - m.data.items.length} more, total=${m.data.total})` : `total=${m.data.total}`]
          : [`! metrics: ${m.error}`],
        { kind: "section", content: `metrics: ${m.ok ? m.data.total : "err"}`, generatedAt: snap.overview.ok ? snap.overview.data?.generatedAt : undefined },
      );
    },
  });

  // --- LLM-callable inspect tool (option B) ---
  // Lets the model pull a specific section on demand without a slash command.
  // Output is returned as tool text (truncated), not injected into history.
  pi.registerTool({
    name: "rusty_inspect",
    label: "Rusty Inspect",
    description:
      "Inspect live rusty-crew service session/runtime state over its read-only debug API. " +
      "Returns rendered text. Pass 'section' to choose what to inspect. 'context' and 'events' " +
      "target a session (defaults to the attached session; list with section='sessions'). " +
      "'snapshot' returns everything. Read-only; safe even when not attached. Output is truncated " +
      `to ~${Math.round(DEFAULT_MAX_BYTES / 1024)}KB/${DEFAULT_MAX_LINES} lines.`,
    promptSnippet: "Inspect live rusty-crew service session/runtime diagnostics (read-only)",
    promptGuidelines: [
      "Use rusty_inspect when the user asks about the rusty-crew service state, a specific session's " +
        "context/tools/pending messages/events, or overall runtime health.",
      "Prefer the narrow 'section' (e.g. 'overview', 'sessions', 'context') over 'snapshot' when the " +
        "user asks about one thing; use 'snapshot' only for a full picture.",
    ],
    parameters: Type.Object({
      section: StringEnum(
        [
          "snapshot",
          "context",
          "overview",
          "sessions",
          "agents",
          "tools",
          "mcp",
          "channels",
          "persistence",
          "observation",
          "background",
          "metrics",
          "events",
        ] as const,
        { description: "What to inspect" },
      ),
      sessionId: Type.Optional(
        Type.String({
          description: "Target session id (required for 'context'; scopes 'events'). Defaults to the attached session.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max items for list sections (default 50). Metrics caps at 60.",
          minimum: 1,
          maximum: 200,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "rusty_inspect cancelled" }] };
      }
      const section = params.section as RustySection;
      const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
      const needsSession = section === "context" || section === "events";
      const sid = params.sessionId ?? attachedId;
      if (needsSession && !sid) {
        return {
          content: [
            {
              type: "text",
              text:
                `rusty_inspect: section "${section}" needs a sessionId. Either pass sessionId, or list ` +
                `available sessions with section="sessions" and retry. (Not currently attached.)`,
            },
          ],
          details: { section, missingSessionId: true },
        };
      }

      const result = await gatherSection(section, sid, limit);
      if (!result.ok) {
        return {
          content: [
            { type: "text", text: `rusty_inspect (${section}) failed: ${result.error}` },
          ],
          details: { section, sessionId: sid, error: result.error },
        };
      }

      const { title, lines, generatedAt } = result.data;
      const raw = lines.join("\n");
      const trunc = truncateHead(raw, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      let text = `== rusty-crew: ${title} ==\n${trunc.content}`;
      if (trunc.truncated) {
        text += `\n\n[output truncated: ${formatSize(trunc.outputBytes)} of ${formatSize(trunc.totalBytes)}, ` +
          `${trunc.outputLines} of ${trunc.totalLines} lines. Narrow with a specific section or limit.]`;
      }
      if (sid) text += `\n(session ${shortId(sid)})`;
      return {
        content: [{ type: "text", text }],
        details: { section, sessionId: sid, truncated: trunc.truncated, generatedAt, count: lines.length },
      };
    },
  });

  pi.registerCommand("rusty-detach", {
    description: "Detach from the rusty-crew session and stop refreshing",
    handler: async (_args, ctx) => {
      clearTimer();
      attachedId = undefined;
      lastView = undefined;
      ctx.ui.setStatus("rusty-debug", undefined);
      ctx.ui.setWidget("rusty-debug", undefined);
      ctx.ui.notify("detached", "info");
    },
  });

  // /rusty-turn <text> — submit a direct-debug turn. Gated by service
  // availability + explicit opt-in flag + confirm. No-op (and explained)
  // when the service is in read-only inspect mode.
  pi.registerFlag("rusty-debug-turn", {
    description: "Allow /rusty-turn to submit direct-debug turns to the attached session",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("rusty-turn", {
    description: "Submit a direct-debug turn to the attached session (opt-in, gated)",
    handler: async (args, ctx) => {
      if (!attachedId) {
        ctx.ui.notify("not attached (use /rusty-attach)", "warning");
        return;
      }
      const body = (args ?? "").trim();
      if (!body) {
        ctx.ui.notify("usage: /rusty-turn <message text>", "warning");
        return;
      }
      const availability = lastView?.controls?.directTurnInjection ?? "disabled";
      if (availability !== "available") {
        ctx.ui.notify(
          `direct turns are ${availability}: ${lastView?.controls?.reason ?? ""}`,
          "warning",
        );
        return;
      }
      if (!pi.getFlag("rusty-debug-turn")) {
        ctx.ui.notify(
          "turn submission is opt-in: restart with --rusty-debug-turn to enable",
          "warning",
        );
        return;
      }
      const ok = await ctx.ui.confirm(
        "Submit direct-debug turn?",
        `Send to session ${shortId(attachedId)} via source=direct_debug. This wakes the brain.`,
      );
      if (!ok) return;
      try {
        const outcome = await debugPost<{
          status: string;
          summary: string;
          wakeId?: string;
          messageId?: string;
          reasonCode?: string;
        }>(`/v1/debug/sessions/${encodeURIComponent(attachedId)}/turn`, {
          sessionId: attachedId,
          actorId: "pi-rusty-debug-attach",
          body,
          reason: "pi diagnostic attach",
        });
        pi.sendMessage(
          {
            customType: "rusty_debug",
            content: "turn submitted",
            display: true,
            details: {
              kind: "turn",
              lines: [
                `status=${outcome.status} reasonCode=${outcome.reasonCode ?? "—"}`,
                `summary=${outcome.summary}`,
                outcome.wakeId ? `wakeId=${outcome.wakeId}` : "",
                outcome.messageId ? `messageId=${outcome.messageId}` : "",
              ].filter(Boolean),
            },
          },
          { triggerTurn: false },
        );
      } catch (err) {
        ctx.ui.notify(`/rusty-turn failed: ${(err as Error).message}`, "error");
      }
    },
  });

  // Optional: when opted-in via flag AND a direct turn is available, route
  // ordinary typed input to the attached session instead of pi's own LLM.
  // Default (flag off): input passes through normally — pi stays pi.
  pi.on("input", async (event, ctx) => {
    if (!attachedId || event.source !== "interactive") return { action: "continue" };
    if (!pi.getFlag("rusty-debug-turn")) return { action: "continue" };
    const availability = lastView?.controls?.directTurnInjection ?? "disabled";
    if (availability !== "available") return { action: "continue" };
    const text = event.text?.trim();
    if (!text || text.startsWith("/")) return { action: "continue" };
    const ok = await ctx.ui.confirm(
      "Route to rusty-crew session?",
      `Send typed input to ${shortId(attachedId)} as a direct-debug turn?`,
    );
    if (!ok) return { action: "continue" };
    try {
      await debugPost(
        `/v1/debug/sessions/${encodeURIComponent(attachedId)}/turn`,
        { sessionId: attachedId, actorId: "pi-rusty-debug-attach", body: text, reason: "pi typed input" },
      );
      ctx.ui.notify(`sent to ${shortId(attachedId)}`, "info");
    } catch (err) {
      ctx.ui.notify(`turn failed: ${(err as Error).message}`, "error");
    }
    return { action: "handled" }; // do not also run pi's own agent loop
  });

  pi.on("session_shutdown", async () => {
    clearTimer();
  });
}
