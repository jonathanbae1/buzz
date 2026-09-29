import * as React from "react";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { subscribeControlResults } from "@/features/agents/observerRelayStore";
import { controlManagedAgentSession } from "@/shared/api/agentControl";
import type {
  AgentSessionLifecycleEntry,
  ControlResultFrame,
} from "@/shared/api/types";
import { Button } from "@/shared/ui/button";

const RESULT_TIMEOUT_MS = 15_000;

type LifecycleOperation = "list" | "load" | "resume" | "fork" | "close";

export function SessionLifecycleControls({
  agentPubkey,
  enabled,
  sessionId,
}: {
  agentPubkey: string;
  enabled: boolean;
  sessionId: string;
}) {
  const { data: agents } = useManagedAgentsQuery({ enabled });
  const agent = agents?.find((item) => item.pubkey === agentPubkey);
  const [sessions, setSessions] = React.useState<AgentSessionLifecycleEntry[]>(
    [],
  );
  const [selectedId, setSelectedId] = React.useState("");
  const [pending, setPending] = React.useState<LifecycleOperation | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  const run = React.useCallback(
    async (operation: LifecycleOperation) => {
      if (!enabled || pending) return;
      const targetSessionId = operation === "list" ? undefined : selectedId;
      if (operation !== "list" && !targetSessionId) return;
      const requestId = crypto.randomUUID();
      setPending(operation);
      setMessage(null);
      let unsubscribe: (() => void) | undefined;
      let timeout: number | undefined;
      try {
        const framePromise = new Promise<ControlResultFrame>(
          (resolve, reject) => {
            unsubscribe = subscribeControlResults(agentPubkey, (frame) => {
              if (
                frame.type === "session_lifecycle" &&
                frame.requestId === requestId &&
                frame.operation === operation
              ) {
                resolve(frame);
              }
            });
            timeout = window.setTimeout(
              () => reject(new Error("Session operation timed out")),
              RESULT_TIMEOUT_MS,
            );
          },
        );
        await controlManagedAgentSession(
          agentPubkey,
          sessionId,
          operation,
          requestId,
          targetSessionId,
        );
        const frame = await framePromise;
        if (frame.status !== "completed") {
          throw new Error(frame.error ?? frame.status.replaceAll("_", " "));
        }
        if (operation === "list") {
          const nextSessions = frame.sessions ?? [];
          setSessions(nextSessions);
          setSelectedId((current) =>
            nextSessions.some((item) => item.sessionId === current)
              ? current
              : (nextSessions[0]?.sessionId ?? ""),
          );
        } else if (operation === "close") {
          setSessions((current) =>
            current.filter((item) => item.sessionId !== targetSessionId),
          );
          setSelectedId("");
          setMessage("Session closed");
        } else if (operation === "fork" && frame.sessionId) {
          const parent = sessions.find(
            (item) => item.sessionId === targetSessionId,
          );
          const fork: AgentSessionLifecycleEntry = {
            sessionId: frame.sessionId,
            title: parent?.title ? `Fork of ${parent.title}` : "Forked session",
            updatedAt: new Date().toISOString(),
          };
          setSessions((current) => [fork, ...current]);
          setSelectedId(fork.sessionId);
          setMessage("Fork opened in this direct conversation");
        } else {
          setMessage(
            operation === "load" ? "Session loaded" : "Session resumed",
          );
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        unsubscribe?.();
        if (timeout !== undefined) window.clearTimeout(timeout);
        setPending(null);
      }
    },
    [agentPubkey, enabled, pending, selectedId, sessionId, sessions],
  );

  if (!enabled || !sessionId) return null;

  const profile = agent?.envVars?.OMP_PROFILE?.trim() || "default";
  const workspace =
    agent?.spawnedWithWorkspacePath ??
    agent?.workspacePath ??
    "runtime default";

  return (
    <section
      aria-label="ACP session lifecycle"
      className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
      data-testid="agent-session-lifecycle"
    >
      <span className="mr-1 text-xs font-medium text-muted-foreground">
        Sessions
      </span>
      <span className="basis-full text-xs text-muted-foreground">
        Owner: profile <span className="font-mono">{profile}</span> · workspace{" "}
        <span className="font-mono">{workspace}</span>
      </span>
      <Button
        disabled={pending !== null}
        onClick={() => void run("list")}
        size="sm"
        type="button"
        variant="outline"
      >
        {pending === "list" ? "Loading…" : "List sessions"}
      </Button>
      {sessions.length > 0 ? (
        <>
          <select
            aria-label="ACP session"
            className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-xs"
            disabled={pending !== null}
            onChange={(event) => setSelectedId(event.target.value)}
            value={selectedId}
          >
            {sessions.map((item) => (
              <option key={item.sessionId} value={item.sessionId}>
                {item.title || item.sessionId} ·{" "}
                {item.updatedAt || "unknown date"}
              </option>
            ))}
          </select>
          {(["load", "resume", "fork", "close"] as const).map((operation) => (
            <Button
              key={operation}
              disabled={pending !== null || !selectedId}
              onClick={() => void run(operation)}
              size="sm"
              type="button"
              variant={operation === "close" ? "destructive" : "outline"}
            >
              {pending === operation
                ? `${operation[0].toUpperCase()}${operation.slice(1)}…`
                : operation[0].toUpperCase() + operation.slice(1)}
            </Button>
          ))}
        </>
      ) : null}
      {message ? (
        <span
          className="basis-full text-xs text-muted-foreground"
          role="status"
        >
          {message}
        </span>
      ) : null}
    </section>
  );
}
