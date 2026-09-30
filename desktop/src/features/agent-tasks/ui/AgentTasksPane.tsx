import * as React from "react";

import { useActiveAgentTurns } from "@/features/agents/activeAgentTurnsStore";
import { useManagedAgentsQuery } from "@/features/agents/hooks";
import {
  deriveLatestSessionId,
  mergeObserverEventWindows,
  scopeByChannel,
} from "@/features/agents/ui/agentSessionPanelLayout";
import {
  useArchivedChannelEvents,
  useLoadArchivedObserverEvents,
  useObserverEvents,
} from "@/features/agents/ui/useObserverEvents";
import { useChannelsQuery } from "@/features/channels/hooks";
import { useSendMessageMutation } from "@/features/messages/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import {
  assignAgentTask,
  getAgentTasksStatus,
  listAgentTasks,
  registerAgentTaskDispatch,
  toTaskError,
  type StoreStatus,
  type TaskBoard,
  type TaskError,
  type TaskReadiness,
  type TaskRow,
} from "@/shared/api/tauriAgentTasks";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const M1_CONTRACT = "agentmemory-m1.1";

/**
 * Private Tasks pane (M1).
 *
 * Reads the `oh-my-buzz` project's actions from the central agentmemory store and shows
 * authoritative ownership: status, dependency reasons, who holds the lease until when, and
 * the last attempt's outcome. It reuses incumbent list/detail patterns and introduces no new
 * visual theme or design system.
 *
 * Two deliberate non-features:
 * - **No drag-and-drop state changes.** Assignment is an explicit intent write, and starting
 *   work is a separate explicit action; neither is a gesture.
 * - **No cached selection as truth.** A detail refresh is authoritative, so the detail pane
 *   re-reads on filter change rather than trusting the row it was opened from.
 */

const READINESS_LABEL: Record<TaskReadiness, string> = {
  ready: "Ready",
  running: "Running",
  blocked: "Blocked",
  terminal: "Done",
  needs_review: "Needs review",
  unassigned: "Unassigned",
  unknown: "Unknown",
};

const READINESS_TONE: Record<TaskReadiness, string> = {
  ready: "text-emerald-400",
  running: "text-sky-400",
  blocked: "text-amber-400",
  terminal: "text-muted-foreground",
  needs_review: "text-rose-400",
  unassigned: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

type Filter = "all" | "ready" | "running" | "blocked" | "terminal";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready" },
  { id: "running", label: "Running" },
  { id: "blocked", label: "Blocked" },
  { id: "terminal", label: "Done" },
];

function matches(row: TaskRow, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "blocked")
    return row.readiness === "blocked" || row.readiness === "needs_review";
  if (filter === "ready") return row.readiness === "ready";
  if (filter === "running") return row.readiness === "running";
  return row.readiness === "terminal";
}

/** One store failure, rendered so a broken store never looks like an empty board. */
function StoreErrorPanel({ error }: { error: TaskError }) {
  const title =
    error.kind === "not_configured"
      ? "The task store is not configured"
      : error.kind === "insecure_url"
        ? "The task store URL is not secure"
        : error.kind === "unauthorized"
          ? "The task store rejected the credential"
          : error.kind === "network"
            ? "The task store is unreachable"
            : error.kind === "contract_missing"
              ? "Managed work is not deployed"
              : error.kind === "contract_incompatible"
                ? "The task store speaks a different contract"
                : "The task store returned an unusable response";
  return (
    <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm">
      <p className="font-medium text-rose-300">{title}</p>
      <p className="mt-1 text-muted-foreground">{error.message}</p>
      {error.host ? (
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          store: {error.host}
        </p>
      ) : null}
      {error.contract ? (
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          contract: {error.contract}
        </p>
      ) : null}
    </div>
  );
}

export function AgentTasksPane() {
  const [board, setBoard] = React.useState<TaskBoard | null>(null);
  const [status, setStatus] = React.useState<StoreStatus | null>(null);
  const [error, setError] = React.useState<TaskError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      // Status first: it distinguishes "no managed contract" from "no tasks", and it is
      // what tells the operator which store the pane is talking to.
      const nextStatus = await getAgentTasksStatus();
      setStatus(nextStatus);
      const nextBoard = await listAgentTasks();
      setBoard(nextBoard);
      setError(null);
    } catch (thrown) {
      setError(toTaskError(thrown));
      setBoard(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = React.useMemo(
    () => (board?.tasks ?? []).filter((row) => matches(row, filter)),
    [board, filter],
  );
  // A detail refresh is authoritative: the selected row is re-derived from the current list
  // rather than held as its own copy.
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;

  const identityQuery = useIdentityQuery();
  const channelsQuery = useChannelsQuery();
  const sendMessage = useSendMessageMutation(null, identityQuery.data);
  const managedAgentsQuery = useManagedAgentsQuery();
  // Assignment targets use the identity buzz-acp exports to a managed worker.
  const assignableAgents = React.useMemo(
    () =>
      (managedAgentsQuery.data ?? [])
        .map((agent) => ({
          id: `buzz:${agent.pubkey.toLowerCase()}`,
          name: agent.name,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [managedAgentsQuery.data],
  );
  const agentNameByTarget = React.useMemo<Record<string, string>>(
    () =>
      Object.fromEntries(
        assignableAgents.map((agent) => [agent.id, agent.name]),
      ),
    [assignableAgents],
  );
  const targetPubkey = selected?.assignmentTarget?.startsWith("buzz:")
    ? selected.assignmentTarget.slice("buzz:".length).toLowerCase()
    : null;
  const { events: liveEvents } = useObserverEvents(
    Boolean(targetPubkey),
    targetPubkey,
  );
  const activeTurns = useActiveAgentTurns(targetPubkey);
  const ownPubkey = identityQuery.data?.pubkey?.toLowerCase() ?? null;
  const directChannel =
    channelsQuery.data?.find(
      (channel) =>
        channel.channelType === "dm" &&
        channel.participantPubkeys.length === 2 &&
        channel.participantPubkeys.some(
          (pubkey) => pubkey.toLowerCase() === targetPubkey,
        ) &&
        (!ownPubkey ||
          channel.participantPubkeys.some(
            (pubkey) => pubkey.toLowerCase() === ownPubkey,
          )),
    ) ?? null;
  const directChannelId = directChannel?.id ?? null;
  useLoadArchivedObserverEvents(Boolean(directChannelId), directChannelId);
  const archivedEvents = useArchivedChannelEvents(
    targetPubkey,
    directChannelId,
  );
  const sessionId = React.useMemo(() => {
    if (!directChannelId) return null;
    return deriveLatestSessionId(
      mergeObserverEventWindows(
        scopeByChannel(liveEvents, directChannelId),
        archivedEvents,
      ),
    );
  }, [archivedEvents, directChannelId, liveEvents]);
  const handleAssign = React.useCallback(
    async (row: TaskRow, targetAgentId: string | null) => {
      setBusy(true);
      setNotice(null);
      try {
        await assignAgentTask({
          actionId: row.id,
          targetAgentId,
          expectedRevision: row.assignmentRevision,
        });
        setNotice(
          targetAgentId === null
            ? `Cleared the assignment intent for ${row.title}.`
            : `Assigned ${row.title} to ${agentNameByTarget[targetAgentId] ?? targetAgentId}. This writes intent only; nothing was dispatched.`,
        );
        await refresh();
      } catch (thrown) {
        const taskError = toTaskError(thrown);
        setNotice(`Assignment refused: ${taskError.message}`);
      } finally {
        setBusy(false);
      }
    },
    [agentNameByTarget, refresh],
  );

  const handleRun = React.useCallback(
    async (row: TaskRow) => {
      setNotice(null);
      const target = row.assignmentTarget;
      const match = target?.match(/^buzz:([0-9a-f]{64})$/i);
      if (!match) {
        setNotice("Run refused: assign this action to a managed agent first.");
        return;
      }
      if (
        !board?.managedAvailable ||
        board.contract !== M1_CONTRACT ||
        !status?.managedAvailable ||
        status.contract !== M1_CONTRACT
      ) {
        setNotice(
          `Run refused: the compatible ${M1_CONTRACT} task contract is unavailable.`,
        );
        return;
      }
      if (row.readiness !== "ready") {
        setNotice(
          `Run refused: this action is ${READINESS_LABEL[row.readiness].toLowerCase()}.`,
        );
        return;
      }
      const pubkey = match[1].toLowerCase();
      const agent = managedAgentsQuery.data?.find(
        (item) => item.pubkey.toLowerCase() === pubkey,
      );
      if (
        !agent ||
        (agent.status !== "running" && agent.status !== "deployed")
      ) {
        setNotice("Run refused: the assigned managed agent is unavailable.");
        return;
      }
      if (activeTurns.length > 0) {
        setNotice(
          "Run refused: the assigned agent already has an active turn.",
        );
        return;
      }
      if (!identityQuery.data || !directChannel || !sessionId) {
        setNotice(
          "Run refused: the assigned agent has no initialized direct conversation session.",
        );
        return;
      }
      const requestId = crypto.randomUUID();
      setBusy(true);
      try {
        const registration = await registerAgentTaskDispatch({
          actionId: row.id,
          requestId,
          sessionId,
          expectedRevision: row.assignmentRevision,
        });
        if (
          registration === null ||
          typeof registration !== "object" ||
          (registration as Record<string, unknown>)["success"] !== true
        ) {
          throw new Error(
            "The task store did not confirm dispatch registration.",
          );
        }
        const prompt = [
          `M1W ${row.id} ${requestId}`,
          `Task: ${row.title}`,
          row.description,
          "Complete the requested work, then call work_complete with outcome succeeded or failed and the full result.",
        ]
          .filter(Boolean)
          .join("\n");
        await sendMessage.mutateAsync({
          targetChannel: directChannel,
          content: prompt,
          mentionPubkeys: [pubkey],
          transport: "http",
        });
        setNotice(
          `Run sent to ${agent.name}. Request ${requestId}. Refreshing the attempt projection.`,
        );
        await refresh();
      } catch (thrown) {
        const message =
          thrown instanceof Error
            ? thrown.message
            : toTaskError(thrown).message;
        setNotice(`Run delivery unknown for request ${requestId}: ${message}`);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [
      activeTurns.length,
      board,
      directChannel,
      identityQuery.data,
      managedAgentsQuery.data,
      refresh,
      sendMessage,
      sessionId,
      status,
    ],
  );
  const managedUnavailable = board !== null && !board.managedAvailable;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Tasks</h1>
          <p className="text-xs text-muted-foreground">
            Private task board for <span className="font-mono">oh-my-buzz</span>
            {board?.host ? (
              <>
                {" · "}
                <span className="font-mono">{board.host}</span>
              </>
            ) : null}
            {status?.serviceVersion ? (
              <>
                {" · "}
                <span className="font-mono">{status.serviceVersion}</span>
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading || busy}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {managedUnavailable ? (
        <div className="border-b border-amber-500/30 bg-amber-500/5 px-6 py-3 text-xs text-amber-200">
          Assignment and Run are unavailable: {board?.managedUnavailableReason}
        </div>
      ) : null}

      <div className="flex items-center gap-1 border-b border-border/60 px-6 py-2">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setFilter(item.id)}
            className={
              item.id === filter
                ? "rounded-md bg-accent px-2.5 py-1 text-xs font-medium"
                : "rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent/50"
            }
          >
            {item.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {rows.length} of {board?.tasks.length ?? 0}
        </span>
      </div>

      {notice ? (
        <div className="border-b border-border/60 px-6 py-2 text-xs text-muted-foreground">
          {notice}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <ul className="min-h-0 w-1/2 overflow-y-auto border-r border-border/60">
          {error ? (
            <li className="p-4">
              <StoreErrorPanel error={error} />
            </li>
          ) : null}
          {!error && !loading && rows.length === 0 ? (
            <li className="p-6 text-sm text-muted-foreground">
              No actions in this view. The store answered and returned none,
              which is different from an unreachable store.
            </li>
          ) : null}
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => setSelectedId(row.id)}
                className={
                  row.id === selected?.id
                    ? "w-full border-b border-border/40 bg-accent/60 px-4 py-3 text-left"
                    : "w-full border-b border-border/40 px-4 py-3 text-left hover:bg-accent/30"
                }
              >
                <span className="flex items-center gap-2">
                  <span className={READINESS_TONE[row.readiness]}>●</span>
                  <span className="truncate text-sm font-medium">
                    {row.title}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    P{row.priority}
                  </span>
                </span>
                <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={READINESS_TONE[row.readiness]}>
                    {READINESS_LABEL[row.readiness]}
                  </span>
                  {row.assignmentTarget ? (
                    <span className="truncate">
                      {agentNameByTarget[row.assignmentTarget.toLowerCase()] ??
                        row.assignmentTarget}
                    </span>
                  ) : (
                    <span>unassigned</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <section className="min-h-0 w-1/2 overflow-y-auto p-6">
          {loading && !board ? (
            <ViewLoadingFallback kind="tasks" />
          ) : selected ? (
            <TaskDetail
              key={selected.id}
              agents={assignableAgents}
              agentNameByTarget={agentNameByTarget}
              row={selected}
              busy={busy}
              onAssign={handleAssign}
              onRun={handleRun}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Select an action to see its detail.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function TaskDetail({
  agents,
  agentNameByTarget,
  row,
  busy,
  onAssign,
  onRun,
}: {
  agents: readonly { id: string; name: string }[];
  agentNameByTarget: Record<string, string>;
  row: TaskRow;
  busy: boolean;
  onAssign: (row: TaskRow, targetAgentId: string | null) => Promise<void>;
  onRun: (row: TaskRow) => Promise<void>;
}) {
  const currentTarget = row.assignmentTarget?.toLowerCase() ?? null;
  const [choice, setChoice] = React.useState(
    currentTarget && agentNameByTarget[currentTarget]
      ? currentTarget
      : (agents[0]?.id ?? ""),
  );
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">{row.title}</h2>
        {row.description ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {row.description}
          </p>
        ) : null}
      </div>

      <dl className="rounded-lg border border-border/60 p-3">
        <Field label="Readiness">
          <span className={READINESS_TONE[row.readiness]}>
            {READINESS_LABEL[row.readiness]}
          </span>
        </Field>
        <Field label="Status">
          <span className="font-mono">{row.status}</span>
        </Field>
        {row.assignmentTarget ? (
          <Field label="Assigned to">
            <span>
              {agentNameByTarget[row.assignmentTarget.toLowerCase()] ?? (
                <span className="font-mono">{row.assignmentTarget}</span>
              )}
            </span>
            <span className="ml-2 text-xs text-muted-foreground">
              revision {row.assignmentRevision}
            </span>
          </Field>
        ) : (
          <Field label="Assigned to">
            <span className="text-muted-foreground">
              no intent (revision {row.assignmentRevision})
            </span>
          </Field>
        )}
        {row.dispatch ? (
          <Field label="Dispatch">
            <span className="font-mono text-xs">
              {row.dispatch.requestId}
              <br />
              session {row.dispatch.sessionId}
            </span>
          </Field>
        ) : null}
        {row.leaseLive ? (
          <Field label="Lease">
            <span className="font-mono text-xs">
              {row.leaseAgent} until {row.leaseExpiresAt}
            </span>
          </Field>
        ) : (
          <Field label="Lease">
            <span className="text-muted-foreground">none live</span>
          </Field>
        )}
        {row.blockers.length > 0 ? (
          <Field label="Blocked by">
            <ul className="space-y-0.5">
              {row.blockers.map((blocker) => (
                <li key={blocker} className="font-mono text-xs">
                  {blocker}
                </li>
              ))}
            </ul>
          </Field>
        ) : null}
        {row.reasons.length > 0 ? (
          <Field label="Why">
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {row.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </Field>
        ) : null}
        {row.lastAttempt ? (
          <Field label="Last attempt">
            <span className="text-xs">
              {row.lastAttempt.outcome ?? "no outcome recorded"} · lease{" "}
              <span className="font-mono">{row.lastAttempt.leaseId}</span>
            </span>
          </Field>
        ) : null}
        {row.result ? (
          <Field label="Result">
            {/* The authoritative stored result, not truncated chat output. */}
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">
              {row.result}
            </pre>
          </Field>
        ) : null}
      </dl>

      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Assignee"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          disabled={busy || row.readiness === "terminal" || agents.length === 0}
          onChange={(event) => setChoice(event.currentTarget.value)}
          value={choice}
        >
          {agents.length === 0 ? (
            <option value="">No managed agents</option>
          ) : null}
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={
            busy ||
            row.readiness === "terminal" ||
            !choice ||
            choice === currentTarget
          }
          onClick={() => void onAssign(row, choice)}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
        >
          Assign
        </button>
        <button
          type="button"
          disabled={busy || !row.assignmentTarget}
          onClick={() => void onAssign(row, null)}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
        >
          Clear assignment
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRun(row)}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Starting…" : "Run"}
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        Run requires a ready action, the assigned managed agent's initialized
        idle direct session, and the compatible task contract. Dispatch is
        registered before the ordinary direct-message prompt is sent; refresh
        shows the authoritative request and lease projection.
      </p>
    </div>
  );
}
