import * as React from "react";

import { subscribeControlResults } from "@/features/agents/observerRelayStore";
import { useAgentConfigSurface } from "@/features/agents/hooks";
import { setSessionConfigOption } from "@/shared/api/agentControl";

export function SessionConfigControls({
  agentPubkey,
  sessionId,
}: {
  agentPubkey: string;
  sessionId: string | null | undefined;
}) {
  const { data: surface } = useAgentConfigSurface(agentPubkey);
  const [pending, setPending] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  async function apply(category: "mode" | "thought_level", value: string) {
    if (!sessionId || pending) return;
    const requestId = crypto.randomUUID();
    setPending(category);
    setMessage(null);
    let unsubscribe = () => {};
    let timeout: number | undefined;
    try {
      const result = await new Promise<string>((resolve, reject) => {
        unsubscribe = subscribeControlResults(agentPubkey, (frame) => {
          if (
            frame.type !== "set_session_config" ||
            frame.requestId !== requestId ||
            frame.sessionId !== sessionId ||
            frame.category !== category
          ) {
            return;
          }
          if (frame.status === "applied") resolve("Updated");
          else reject(new Error(frame.error ?? frame.status.replaceAll("_", " ")));
        });
        timeout = window.setTimeout(
          () => reject(new Error("No confirmation received")),
          8_000,
        );
        void setSessionConfigOption(
          agentPubkey,
          sessionId,
          category,
          value,
          requestId,
        ).catch(reject);
      });
      setMessage(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      unsubscribe();
      if (timeout !== undefined) window.clearTimeout(timeout);
      setPending(null);
    }
  }

  const mode = surface?.modeOptions ?? [];
  const thinking = surface?.effortOptions ?? [];
  if (!sessionId || (mode.length === 0 && thinking.length === 0)) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      {mode.length > 0 ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Mode
          <select
            aria-label="Session mode"
            className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
            value={surface?.currentMode ?? ""}
            disabled={pending !== null}
            onChange={(event) => void apply("mode", event.currentTarget.value)}
          >
            {mode.map((option) => (
              <option key={option.value} value={option.value}>
                {option.displayName ?? option.value}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {thinking.length > 0 ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Thinking
          <select
            aria-label="Session thinking level"
            className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
            value={surface?.normalized.thinkingEffort?.value ?? ""}
            disabled={pending !== null}
            onChange={(event) =>
              void apply("thought_level", event.currentTarget.value)
            }
          >
            {thinking.map((option) => (
              <option key={option.value} value={option.value}>
                {option.displayName ?? option.value}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {message ? (
        <span role="status" className="text-xs text-muted-foreground">
          {message}
        </span>
      ) : null}
    </div>
  );
}
