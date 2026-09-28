import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import React from "react";
import { useNavigate } from "@tanstack/react-router";

import type {
  AcpConfigOptionValue,
  ManagedAgent,
  RuntimeConfigSurface,
} from "@/shared/api/types";
import { setSessionConfigOption } from "@/shared/api/agentControl";
import { subscribeControlResults } from "@/features/agents/observerRelayStore";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

export function ModelPicker({
  agent,
  channelId,
  sessionId,
  configSurface,
  isRunning,
  isBusy,
  onModelChanged,
}: {
  agent: Pick<ManagedAgent, "pubkey" | "name">;
  channelId: string;
  sessionId: string;
  configSurface: RuntimeConfigSurface;
  isRunning: boolean;
  isBusy: boolean;
  onModelChanged?: () => void;
}) {
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const navigate = useNavigate();
  const options = configSurface.modelOptions ?? [];
  const selectedModel = configSurface.normalized.model?.value ?? "";
  const laneKey = configSurface.ompProfile?.modelLane;
  const profile = configSurface.ompProfile?.selectedName;

  const applyModel = React.useCallback(
    (modelId: string) => {
      const requestId = crypto.randomUUID();
      return new Promise<"applied" | "rejected" | "failed" | "pending">((resolve) => {
        let unsubscribe = () => {};
        const timeout = window.setTimeout(() => {
          unsubscribe();
          resolve("pending");
        }, 8_000);
        unsubscribe = subscribeControlResults(agent.pubkey, (frame) => {
          if (
            frame.type !== "set_session_config" ||
            frame.category !== "model" ||
            frame.requestId !== requestId ||
            frame.sessionId !== sessionId
          ) {
            return;
          }
          if (frame.status !== "applied" && frame.status !== "rejected") return;
          window.clearTimeout(timeout);
          unsubscribe();
          resolve(frame.status);
        });
        void setSessionConfigOption(
          agent.pubkey,
          sessionId,
          "model",
          modelId,
          requestId,
        ).catch(() => {
          window.clearTimeout(timeout);
          unsubscribe();
          resolve("failed");
        });
      });
    },
    [agent.pubkey, sessionId],
  );

  const handleModelChange = async (modelId: string) => {
    setSaving(true);
    setMessage(null);
    try {
      const outcome = await applyModel(modelId);
      if (outcome === "failed" || outcome === "rejected") {
        setMessage(outcome === "rejected" ? "The session rejected this model change." : "The model change could not be sent.");
      } else if (outcome === "pending") {
        setMessage("Waiting for the session to confirm the model change.");
      } else {
        toast.success("Model changed for this session.");
        onModelChanged?.();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const navigateToLaneEditor = () => {
    if (!laneKey || !selectedModel) return;
    void navigate({
      to: "/settings",
      search: {
        section: "agents",
        lane: laneKey,
        model: selectedModel,
        profile: profile ?? undefined,
      },
    });
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            className="h-7 max-w-full justify-start gap-1.5 rounded-full border border-border/50 bg-muted/45 px-2.5 text-xs font-medium text-foreground shadow-none hover:bg-muted/70"
            disabled={saving || options.length === 0 || !channelId || !isRunning || isBusy}
            size="sm"
            type="button"
            variant="ghost"
          >
            <span className="truncate">
              {options.find((option) => option.value === selectedModel)?.displayName ?? selectedModel ?? "Model"}
            </span>
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-64 min-w-48 overflow-y-auto">
          <DropdownMenuRadioGroup onValueChange={handleModelChange} value={selectedModel}>
            {options.map((option: AcpConfigOptionValue) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.displayName ?? option.value}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {laneKey && selectedModel ? (
        <>
          <Button disabled={saving || !isRunning || isBusy} onClick={navigateToLaneEditor} size="sm" type="button" variant="ghost">
            Make this the lane
          </Button>
          <span className="text-xs text-muted-foreground">This session only.</span>
        </>
      ) : null}
      {!isRunning ? (
        <span className="text-xs text-muted-foreground" role="status">
          Start the agent to switch models for this session.
        </span>
      ) : isBusy ? (
        <span className="text-xs text-muted-foreground" role="status">
          Wait for the current turn to finish before changing this session.
        </span>
      ) : null}
      {message ? (
        <span className="text-xs text-muted-foreground" role="status">
          {message}
        </span>
      ) : null}
    </span>
  );
}
