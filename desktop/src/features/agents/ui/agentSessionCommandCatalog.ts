import type {
  AgentSessionCommand,
  AgentSessionCommandCatalog,
  AgentSessionCommandCatalogStatus,
  AgentSessionCommandDispatchStatus,
  AgentSessionCommandSubcommand,
  ControlResultFrame,
} from "@/shared/api/types";
import { sendAgentObserverControl } from "@/shared/api/observerRelay";
import { subscribeControlResults } from "@/features/agents/observerRelayStore";
import { isAgentSessionCommandTerminalFrame } from "@/features/agents/lib/commandOutcome";
import { normalizePubkey } from "@/shared/lib/pubkey";

type CommandCatalogListener = (
  catalog: AgentSessionCommandCatalog | null,
) => void;

const catalogs = new Map<string, AgentSessionCommandCatalog>();
const listeners = new Map<string, Set<CommandCatalogListener>>();

function catalogKey(agentPubkey: string, sessionId: string): string {
  return `${normalizePubkey(agentPubkey)}:${sessionId}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeSubcommands(value: unknown): AgentSessionCommandSubcommand[] {
  if (!Array.isArray(value)) return [];
  const subcommands: AgentSessionCommandSubcommand[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const name = readString(record.name);
    if (!name) continue;
    const normalized = name.replace(/^\/+/, "").toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    subcommands.push({
      name,
      ...(readString(record.description)
        ? { description: readString(record.description) }
        : {}),
      ...(readString(record.usage) ? { usage: readString(record.usage) } : {}),
    });
  }
  return subcommands;
}

export function normalizeAvailableCommands(
  value: unknown,
): AgentSessionCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: AgentSessionCommand[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const name = readString(record.name);
    if (!name) continue;
    const normalized = name.replace(/^\/+/, "").toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const meta =
      typeof record._meta === "object" && record._meta !== null
        ? (record._meta as Record<string, unknown>)
        : null;
    const subcommands = normalizeSubcommands(
      meta?.["dev.ohmybuzz/subcommands"],
    );
    const inputSchema =
      "input" in record ? record.input : record.inputSchema;
    commands.push({
      name,
      ...(readString(record.description)
        ? { description: readString(record.description) }
        : {}),
      ...(readString(record.usage) ? { usage: readString(record.usage) } : {}),
      ...(inputSchema !== undefined ? { inputSchema } : {}),
      ...(subcommands.length > 0 ? { subcommands } : {}),
    });
  }
  return commands;
}

export function putAgentSessionCommandCatalog(
  agentPubkey: string,
  sessionId: string,
  availableCommands: unknown,
  source: "live" | "archive" = "live",
): AgentSessionCommandCatalog | null {
  const normalizedAgent = normalizePubkey(agentPubkey);
  const normalizedSession = sessionId.trim();
  if (!normalizedAgent || !normalizedSession) return null;
  const catalog: AgentSessionCommandCatalog = {
    agentPubkey: normalizedAgent,
    sessionId: normalizedSession,
    commands: normalizeAvailableCommands(availableCommands),
    receivedAt: Date.now(),
    source,
  };
  const key = catalogKey(normalizedAgent, normalizedSession);
  catalogs.set(key, catalog);
  for (const listener of listeners.get(key) ?? []) listener(catalog);
  return catalog;
}

export function getAgentSessionCommandCatalog(
  agentPubkey: string | null | undefined,
  sessionId: string | null | undefined,
): AgentSessionCommandCatalog | null {
  if (!agentPubkey || !sessionId?.trim()) return null;
  return catalogs.get(catalogKey(agentPubkey, sessionId.trim())) ?? null;
}

export function findAgentSessionCommand(
  agentPubkey: string | null | undefined,
  commandName: string,
): { command: AgentSessionCommand; catalog: AgentSessionCommandCatalog } | null {
  if (!agentPubkey) return null;
  const normalizedAgent = normalizePubkey(agentPubkey);
  const normalizedCommand = commandName.replace(/^\/+/, "").toLowerCase();
  let result:
    | { command: AgentSessionCommand; catalog: AgentSessionCommandCatalog }
    | null = null;
  for (const catalog of catalogs.values()) {
    if (catalog.agentPubkey !== normalizedAgent) continue;
    const command = catalog.commands.find(
      (candidate) =>
        candidate.name.replace(/^\/+/, "").toLowerCase() === normalizedCommand,
    );
    if (!command) continue;
    if (!result || catalog.receivedAt > result.catalog.receivedAt) {
      result = { command, catalog };
    }
  }
  return result;
}

export function getAgentSessionCommandCatalogStatus(
  agentPubkey: string | null | undefined,
  sessionId: string | null | undefined,
): AgentSessionCommandCatalogStatus {
  if (!agentPubkey || !sessionId?.trim()) return "unsupported";
  const current = getAgentSessionCommandCatalog(agentPubkey, sessionId);
  if (current?.source === "live") return "fresh";
  const normalizedAgent = normalizePubkey(agentPubkey);
  return [...catalogs.values()].some(
    (catalog) =>
      catalog.agentPubkey === normalizedAgent && catalog.source === "stale",
  )
    ? "stale"
    : "unsupported";
}

export function subscribeAgentSessionCommandCatalog(
  agentPubkey: string,
  sessionId: string,
  listener: CommandCatalogListener,
): () => void {
  const key = catalogKey(agentPubkey, sessionId);
  const current = listeners.get(key) ?? new Set<CommandCatalogListener>();
  current.add(listener);
  listeners.set(key, current);
  return () => {
    const remaining = listeners.get(key);
    if (!remaining) return;
    remaining.delete(listener);
    if (remaining.size === 0) listeners.delete(key);
  };
}

export function clearAgentSessionCommandCatalog(
  agentPubkey: string,
  sessionId?: string,
): void {
  const prefix = `${normalizePubkey(agentPubkey)}:`;
  if (sessionId?.trim()) {
    catalogs.delete(catalogKey(agentPubkey, sessionId.trim()));
    return;
  }
  for (const key of catalogs.keys()) {
    if (key.startsWith(prefix)) catalogs.delete(key);
  }
}

export function markAgentSessionCommandCatalogsStale(agentPubkey: string) {
  const normalizedAgent = normalizePubkey(agentPubkey);
  for (const [key, catalog] of catalogs) {
    if (catalog.agentPubkey !== normalizedAgent) continue;
    const stale = { ...catalog, source: "stale" as const };
    catalogs.set(key, stale);
    for (const listener of listeners.get(key) ?? []) listener(stale);
  }
}

export async function dispatchAgentSessionCommand(input: {
  agentPubkey: string | null | undefined;
  sessionId: string | null | undefined;
  commandName: string;
  arguments?: unknown;
  enabled?: boolean;
  candidateAgentPubkeys?: readonly string[];
  onTerminal?: (frame: ControlResultFrame) => void;
}): Promise<{
  status: AgentSessionCommandDispatchStatus;
  requestId?: string;
  acknowledged?: boolean;
}> {
  if (input.enabled === false) return { status: "disabled" };
  if (
    input.candidateAgentPubkeys &&
    input.candidateAgentPubkeys.length > 1
  ) {
    return { status: "ambiguous_target" };
  }
  if (!input.agentPubkey) return { status: "no_agent" };
  const knownCommand = findAgentSessionCommand(
    input.agentPubkey,
    input.commandName,
  );
  if (!input.sessionId?.trim()) {
    return {
      status: knownCommand ? "stale_session" : "unsupported_command",
    };
  }
  const catalogStatus = getAgentSessionCommandCatalogStatus(
    input.agentPubkey,
    input.sessionId,
  );
  if (catalogStatus === "stale") return { status: "stale_cache" };
  if (catalogStatus !== "fresh") return { status: "unsupported_command" };
  const catalog = getAgentSessionCommandCatalog(
    input.agentPubkey,
    input.sessionId,
  );
  const command = catalog?.commands.find(
    (candidate) =>
      candidate.name.replace(/^\/+/, "").toLowerCase() ===
      input.commandName.replace(/^\/+/, "").toLowerCase(),
  );
  if (!command) return { status: "unsupported_command" };

  const requestId = crypto.randomUUID();
  const sendCommand = () =>
    sendAgentObserverControl(input.agentPubkey as string, {
      type: "dispatch_command",
      requestId,
      sessionId: input.sessionId,
      commandName: command.name,
      arguments: input.arguments ?? null,
    });
  let unsubscribe = () => {};
  if (input.onTerminal) {
    unsubscribe = subscribeControlResults(input.agentPubkey, (frame) => {
      if (!isAgentSessionCommandTerminalFrame(frame, requestId, input.sessionId)) {
        return;
      }
      unsubscribe();
      input.onTerminal?.(frame);
    });
  }
  try {
    await sendCommand();
    return { status: "sent", requestId, acknowledged: true };
  } catch {
    unsubscribe();
    return { status: "runtime_error", requestId, acknowledged: false };
  }
}
