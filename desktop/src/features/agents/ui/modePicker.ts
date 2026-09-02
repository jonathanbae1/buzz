import type {
  AcpConfigOptionValue,
  ManagedAgentBackend,
} from "@/shared/api/types";
import type { PersonaDropdownOption } from "./agentConfigOptions";

/**
 * Sentinel dropdown value for "no explicit session mode" — lets the adapter
 * choose its default mode at the next spawn. Distinct from any adapter option.
 */
export const MODE_DEFAULT_DROPDOWN_VALUE = "__mode_default__";

/**
 * Pure gating + option compute for the session-mode write control in the edit
 * dialog. The picker is local-only and appears only after the adapter has
 * advertised a mode config option from a running session.
 *
 * Two facts, never conflated. `configuredMode` is the canonical normalized
 * value — the mode the next session will start in, which the reader resolves
 * with the Buzz-persisted record above the live ACP reading — and it is what
 * the control selects. `runningMode` is what the live session is using right
 * now; it only produces a notice, because mode is spawn-scoped and selecting a
 * value does not switch a session already in progress.
 */
export function modePickerState({
  backend,
  modeConfigId,
  modeOptions,
  configuredMode,
  runningMode,
}: {
  backend: ManagedAgentBackend;
  modeConfigId: string | undefined;
  modeOptions: readonly AcpConfigOptionValue[] | undefined;
  configuredMode: string | null;
  runningMode: string | null;
}): {
  visible: boolean;
  options: PersonaDropdownOption[];
  selectValue: string;
  runningNotice: string | null;
} {
  const visible = backend.type === "local" && modeConfigId !== undefined;
  const advertised = modeOptions ?? [];

  const options: PersonaDropdownOption[] = [
    { label: "Adapter default", value: MODE_DEFAULT_DROPDOWN_VALUE },
    ...advertised.map((option) => ({
      label: option.displayName ?? option.value,
      value: option.value,
    })),
  ];

  const configured = configuredMode?.trim() ?? "";
  const selectValue =
    configured.length > 0 &&
    advertised.some((option) => option.value === configured)
      ? configured
      : MODE_DEFAULT_DROPDOWN_VALUE;

  // Only worth saying when the running session disagrees with the selection.
  // With no explicit selection there is nothing to disagree with: the adapter
  // default is whatever the session is already running.
  const running = runningMode?.trim() ?? "";
  const runningNotice =
    running.length > 0 &&
    selectValue !== MODE_DEFAULT_DROPDOWN_VALUE &&
    running !== selectValue
      ? (advertised.find((option) => option.value === running)?.displayName ??
        running)
      : null;

  return { visible, options, selectValue, runningNotice };
}

/** Map a dropdown selection to the persisted startup mode value. */
export function modeSelectionToPersistedValue(value: string): string | null {
  return value === MODE_DEFAULT_DROPDOWN_VALUE ? null : value;
}
