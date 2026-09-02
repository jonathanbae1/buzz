import { useMutation, useQueryClient } from "@tanstack/react-query";

import { agentConfigSurfaceQueryKey } from "@/features/agents/hooks";
import { persistAgentSessionMode } from "@/shared/api/tauriManagedAgents";
import type { ManagedAgent, RuntimeConfigSurface } from "@/shared/api/types";
import { PERSONA_LABEL_OPTIONAL_CLASS } from "./agentConfigOptions";
import { modePickerState, modeSelectionToPersistedValue } from "./modePicker";
import { PersonaDropdownField } from "./PersonaDropdownField";

/**
 * Session-mode write control for the edit dialog. Mode is local-only and
 * spawn-scoped: each selection persists immediately for the next session, and
 * the running session is not switched in place.
 */
export function ModePickerField({
  agent,
  config,
}: {
  agent: ManagedAgent;
  config: RuntimeConfigSurface | undefined;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (mode: string | null) =>
      persistAgentSessionMode(agent.pubkey, mode),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: agentConfigSurfaceQueryKey(agent.pubkey),
      }),
  });
  const { visible, options, selectValue, runningNotice } = modePickerState({
    backend: agent.backend,
    modeConfigId: config?.modeConfigId,
    modeOptions: config?.modeOptions,
    configuredMode: config?.normalized.mode?.value ?? null,
    runningMode: config?.currentMode ?? null,
  });

  if (!visible) {
    return null;
  }

  return (
    <div className="space-y-1.5">
      <label
        className="text-sm font-medium text-foreground"
        htmlFor="edit-agent-session-mode"
      >
        Session mode
        <span className={PERSONA_LABEL_OPTIONAL_CLASS}>Optional</span>
      </label>
      <PersonaDropdownField
        disabled={mutation.isPending}
        id="edit-agent-session-mode"
        onValueChange={(value) =>
          mutation.mutate(modeSelectionToPersistedValue(value))
        }
        options={options}
        placeholder="Adapter default"
        value={selectValue}
      />
      <p className="text-xs text-muted-foreground">
        {runningNotice
          ? `Applied at the next session start — this session is running ${runningNotice}.`
          : "Applied at the next session start."}
      </p>
      {mutation.error instanceof Error ? (
        <p className="text-xs text-destructive">{mutation.error.message}</p>
      ) : null}
    </div>
  );
}
