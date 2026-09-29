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
 * path the per-conversation picker may use.
 */
export function useComposerSessionModelPicker({
  agentPubkey,
  channelId,
  profiles,
  sessionId,
}: {
  agentPubkey: string | null;
  channelId: string | null;
  profiles?: UserProfileLookup;
  sessionId: string | null;
}) {
  const pubkey = sessionId ? agentPubkey : null;
  const { data: surface } = useAgentConfigSurface(pubkey, sessionId);
  // Keyed to the exact agent session, so switching conversations closes it.
  const sessionKey = pubkey && sessionId ? `${pubkey}:${sessionId}` : null;
  const [openKey, setOpenKey] = React.useState<string | null>(null);

  const isAvailable = Boolean(
    pubkey &&
      channelId &&
      surface?.modelConfigId &&
      surface.modelOptions?.length,
  );
  const element =
    isAvailable &&
    sessionKey !== null &&
    openKey === sessionKey &&
    surface &&
    pubkey &&
    channelId &&
    sessionId ? (
      <div
        className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
        data-testid="composer-model-picker"
      >
        <span>Model for this conversation</span>
        <ModelPicker
          agent={{ pubkey, name: profiles?.[pubkey]?.displayName ?? "agent" }}
          channelId={channelId}
          configSurface={surface}
          isBusy={false}
          isRunning
          onModelChanged={() => setOpenKey(null)}
          sessionId={sessionId}
        />
        <button
          className="ml-auto underline"
          onClick={() => setOpenKey(null)}
          type="button"
        >
          Close
        </button>
      </div>
    ) : null;

  return { isAvailable, open: () => setOpenKey(sessionKey), element };
}
