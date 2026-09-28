import { sendAgentObserverControl } from "@/shared/api/observerRelay";
import type { ConfigSelectorCategory } from "@/shared/api/types";

/** Send a stop request; the harness acknowledges it via control_result. */
export async function cancelManagedAgentTurn(
  pubkey: string,
  channelId: string,
  requestId: string,
): Promise<void> {
  await sendAgentObserverControl(pubkey, {
    type: "cancel_turn",
    channelId,
    requestId,
  });
}

/**
 * Send a live model-switch control frame to a running agent. The switch rides
 * the harness's cancel-switch-requeue path (busy turn) or invalidate-and-reapply
 * (idle); the outcome arrives asynchronously as a `control_result` observer
 * frame, not as the return value here. This is fire-and-forget on the send side.
 *
 * `requestId` is an opaque per-pick correlator the harness echoes back on both
 * the immediate ack and the late terminal frame, so a reconnect replay of an
 * earlier pick's result cannot settle this one.
 */
export async function switchManagedAgentModel(
  pubkey: string,
  channelId: string,
  modelId: string,
  requestId: string,
): Promise<void> {
  await sendAgentObserverControl(pubkey, {
    type: "switch_model",
    channelId,
    modelId,
    requestId,
  });
}

/**
 * Send an exact-session selector change to a running agent.
 *
 * This is the control frame the per-conversation mode/model/thinking selectors
 * all use. It is deliberately NOT `switchManagedAgentModel`: that frame is
 * channel-addressed and destroys the session (cancel+requeue when busy,
 * invalidate when idle), so mounting it for a one-off picker would interrupt
 * in-flight work and carry the override into recreated sessions. This frame
 * mutates one live session in place through ACP `session/set_config_option`:
 * siblings are untouched, no prompt is cancelled, and a fresh session returns to
 * the lane. The outcome arrives asynchronously as a `control_result` frame with
 * `type: "set_session_config"`, never as this call's return value.
 *
 * `category` is the selector category rather than a config id: the adapter
 * defines the id, so resolving by category is what keeps one path working across
 * adapters.
 */
export async function setSessionConfigOption(
  pubkey: string,
  sessionId: string,
  category: ConfigSelectorCategory,
  value: string,
  requestId: string,
): Promise<void> {
  await sendAgentObserverControl(pubkey, {
    type: "set_session_config",
    sessionId,
    category,
    value,
    requestId,
  });
}
