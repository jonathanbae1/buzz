import type { ControlResultFrame } from "@/shared/api/types";

export type AgentSessionCommandTerminalStatus = "completed" | "runtime_error";

/**
 * Terminal command frames are correlated by both request and ACP session.
 * `sent` is only relay acceptance and must never settle a command as complete.
 */
export function isAgentSessionCommandTerminalFrame(
  frame: ControlResultFrame,
  requestId: string,
  sessionId?: string | null,
): boolean {
  if (
    frame.type !== "dispatch_command" ||
    frame.requestId !== requestId ||
    (sessionId && frame.sessionId !== sessionId)
  ) {
    return false;
  }
  return frame.status === "completed" || frame.status === "runtime_error";
}

export function getAgentSessionCommandTerminalStatus(
  frame: ControlResultFrame,
): AgentSessionCommandTerminalStatus | null {
  if (frame.status === "completed") return "completed";
  if (frame.status === "runtime_error") return "runtime_error";
  return null;
}

export function formatAgentSessionCommandTerminalNotice(
  frame: ControlResultFrame,
): string {
  if (frame.status === "runtime_error") {
    return frame.error
      ? `Command failed at runtime: ${frame.error}`
      : "Command failed at runtime.";
  }
  switch (frame.outputDisposition) {
    case "published":
      return "Command completed. The agent reply is in this conversation.";
    case "tool_handled":
      return "Command used tools; automatic reply posting was skipped.";
    case "empty":
      return "Command completed without chat output.";
    default:
      return "Command completed.";
  }
}
