import { invokeTauri } from "@/shared/api/tauri";

// ── Private agentmemory task board (M1) ─────────────────────────────────────
//
// Reads and managed-intent writes against the central agentmemory service. The URL
// and bearer live only in Rust (read from the machine's ~/.env); nothing here sees or
// forwards the secret.
//
// The error kinds are deliberately distinct. "No tasks" and "the store is unreachable"
// are different screens — collapsing them hides a broken store behind an empty board.

/** How the Rust side classified a failure. Each kind gets its own UI treatment. */
export type TaskErrorKind =
  | "not_configured"
  | "insecure_url"
  | "unauthorized"
  | "network"
  | "protocol"
  | "contract_missing"
  | "contract_incompatible";

export type TaskError = {
  kind: TaskErrorKind;
  message: string;
  /** The configured store host, so the pane can show what it is talking to. */
  host: string | null;
  /** The advertised contract, when one was seen. */
  contract: string | null;
};

export type DispatchInfo = {
  requestId: string;
  sessionId: string;
  at: string;
};

export type AttemptInfo = {
  leaseId: string;
  requestId: string;
  sessionId: string;
  outcome: string | null;
  result: string | null;
  at: string;
};

/**
 * The store's own readiness verdict for one action.
 *
 * `ready` is NOT frontier membership: terminal actions, an invalid target, unresolved
 * dependencies, a live conflict or an inconsistent persisted status all prevent Run.
 * `needs_review` is the historical blocked-with-no-blockers shape, surfaced rather than
 * auto-healed.
 */
export type TaskReadiness =
  | "ready"
  | "running"
  | "blocked"
  | "terminal"
  | "needs_review"
  | "unassigned"
  | "unknown";

export type TaskRow = {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  project: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Active execution owner. Not queued intent. */
  assignedTo: string | null;
  /** Queued intent. Survives a lease cycle; a null target after unassign is intentional. */
  assignmentTarget: string | null;
  assignmentRevision: number;
  dispatch: DispatchInfo | null;
  leaseLive: boolean;
  leaseId: string | null;
  leaseAgent: string | null;
  leaseExpiresAt: string | null;
  lastAttempt: AttemptInfo | null;
  blockers: string[];
  readiness: TaskReadiness;
  reasons: string[];
  result: string | null;
};

export type TaskBoard = {
  host: string | null;
  contract: string | null;
  managedAvailable: boolean;
  managedUnavailableReason: string | null;
  tasks: TaskRow[];
};

export type StoreStatus = {
  configured: boolean;
  host: string | null;
  contract: string | null;
  serviceVersion: string | null;
  managedAvailable: boolean;
  managedUnavailableReason: string | null;
  error: TaskError | null;
};

/** Which store the pane is talking to, and whether managed work is possible. */
export async function getAgentTasksStatus(): Promise<StoreStatus> {
  return invokeTauri<StoreStatus>("agent_tasks_status", {});
}

/**
 * List the `oh-my-buzz` project's actions with their assignment, lease and readiness
 * projection. Throws `TaskError` for every non-empty failure — an empty `tasks` array
 * means the board is genuinely empty.
 */
export async function listAgentTasks(): Promise<TaskBoard> {
  return invokeTauri<TaskBoard>("agent_tasks_list", {});
}

/** One action's authoritative state. Used to reconcile an uncertain dispatch. */
export async function getAgentTask(actionId: string): Promise<unknown> {
  return invokeTauri<unknown>("agent_tasks_get", { actionId });
}

/** Set or clear assignment INTENT, or cancel. Dispatches nothing. */
export async function assignAgentTask(input: {
  actionId: string;
  targetAgentId?: string | null;
  expectedRevision?: number;
  cancel?: boolean;
}): Promise<unknown> {
  return invokeTauri<unknown>("agent_tasks_assign", {
    actionId: input.actionId,
    targetAgentId: input.targetAgentId ?? null,
    expectedRevision: input.expectedRevision,
    cancel: input.cancel ?? false,
  });
}

/**
 * Register the dispatch BEFORE anything reaches the worker.
 *
 * Register-before-send is what makes an uncertain delivery reconcilable: the store holds
 * the request identity, so a lost response can be read back instead of guessed at.
 */
export async function registerAgentTaskDispatch(input: {
  actionId: string;
  requestId: string;
  sessionId: string;
  expectedRevision: number;
}): Promise<unknown> {
  return invokeTauri<unknown>("agent_tasks_register_dispatch", {
    actionId: input.actionId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    expectedRevision: input.expectedRevision,
  });
}

/** True when a thrown value is the structured TaskError the Rust side returns. */
export function isTaskError(value: unknown): value is TaskError {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["kind"] === "string" &&
    typeof candidate["message"] === "string"
  );
}

/** Normalize anything thrown by the bridge into a TaskError for display. */
export function toTaskError(value: unknown): TaskError {
  if (isTaskError(value)) return value;
  return {
    kind: "protocol",
    message: typeof value === "string" ? value : JSON.stringify(value),
    host: null,
    contract: null,
  };
}
