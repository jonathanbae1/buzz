import * as React from "react";

import { useAgentConfigSurface } from "@/features/agents/hooks";
import { ModelPicker } from "@/features/agents/ui/ModelPicker";
import type { UserProfileLookup } from "@/features/profile/lib/identity";

import { parseLeadingCommand } from "./useComposerCommandPicker";

/** True for a bare `/model`; `/model <id>` still dispatches to the agent. */
export function isBareModelCommand(content: string, implicitPrefix: string) {
  const command = parseLeadingCommand(content, implicitPrefix);
  return command?.name.toLowerCase() === "model" && command.arguments === "";
}

/**
 * `/model` without arguments opens the exact-session model picker instead of
 * dispatching omp's text command, which only prints the current model. The
 * change goes through `ModelPicker`'s `session/set_config_option` path, the one
 * path the per-conversation picker may use. When the picker cannot open, the
 * strip states which input is missing instead of falling back to the text
 * command, so a failure is visible rather than looking like "it printed again".
 */
export function useComposerSessionModelPicker({
  agentPubkey,
  channelId,
  profiles,
  sessionId,
  unresolvedScopeReason,
}: {
  agentPubkey: string | null;
  channelId: string | null;
  profiles?: UserProfileLookup;
  sessionId: string | null;
  unresolvedScopeReason?: string | null;
}) {
  const pubkey = sessionId ? agentPubkey : null;
  const surfaceQuery = useAgentConfigSurface(pubkey, sessionId);
  const surface = surfaceQuery.data;
  // Keyed to the exact agent session, so switching conversations closes it.
  const sessionKey = `${agentPubkey ?? ""}:${sessionId ?? ""}:${channelId ?? ""}`;
  const [openKey, setOpenKey] = React.useState<string | null>(null);

  let unavailableReason: string | null = null;
  if (unresolvedScopeReason) {
    unavailableReason = unresolvedScopeReason;
  } else if (!agentPubkey) {
    unavailableReason = "Address one managed agent to choose its model.";
  } else if (!channelId || !sessionId) {
    unavailableReason =
      "This conversation has no live session for the agent yet. Send it a message first.";
  } else if (surfaceQuery.isPending) {
    unavailableReason = "Loading this session's settings…";
  } else if (surfaceQuery.isError) {
    unavailableReason = `This session's settings could not be read: ${String(surfaceQuery.error)}`;
  } else if (!surface?.modelConfigId || !surface.modelOptions?.length) {
    unavailableReason = `Buzz has not received the model options for session ${sessionId.slice(0, 8)}, so it cannot switch this conversation's model.`;
  }

  const element =
    openKey === sessionKey ? (
      <div
        className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
        data-testid="composer-model-picker"
      >
        {unavailableReason === null &&
        surface &&
        pubkey &&
        channelId &&
        sessionId ? (
          <>
            <span>Model for this conversation</span>
            <ModelPicker
              agent={{
                pubkey,
                name: profiles?.[pubkey]?.displayName ?? "agent",
              }}
              channelId={channelId}
              configSurface={surface}
              isBusy={false}
              isRunning
              onModelChanged={() => setOpenKey(null)}
              sessionId={sessionId}
            />
          </>
        ) : (
          <span role="status">{unavailableReason}</span>
        )}
        <button
          className="ml-auto underline"
          onClick={() => setOpenKey(null)}
          type="button"
        >
          Close
        </button>
      </div>
    ) : null;

  const open = React.useCallback(() => setOpenKey(sessionKey), [sessionKey]);
  return { open, element };
}
