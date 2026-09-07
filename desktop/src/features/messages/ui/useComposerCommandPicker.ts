import * as React from "react";

import {
  getLatestLiveSessionId,
  subscribeAgentObserverStore,
} from "@/features/agents/observerRelayStore";
import {
  dispatchAgentSessionCommand,
  findAgentSessionCommand,
  getAgentSessionCommandCatalog,
  getAgentSessionCommandCatalogStatus,
  subscribeAgentSessionCommandCatalog,
} from "@/features/agents/ui/agentSessionCommandCatalog";
import {
  formatAgentSessionCommandTerminalNotice,
} from "@/features/agents/lib/commandOutcome";
import type {
  AgentSessionCommand,
  AgentSessionCommandCatalogStatus,
  AgentSessionCommandDispatchStatus,
  AgentSessionCommandSubcommand,
  ControlResultFrame,
} from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import type { AutocompleteEdit } from "@/features/messages/lib/useRichTextEditor";

export type ComposerCommandTarget = {
  /** The one exact agent target, when this conversation has one. */
  agentPubkey?: string | null;
  /** All managed-agent participants in the current conversation. */
  candidateAgentPubkeys?: readonly string[];
  /** Set this only when a parent already resolved the exact ACP session. */
  sessionId?: string | null;
};

type ParsedCommand = {
  name: string;
  arguments: string;
};

function stripImplicitMentionPrefix(
  content: string,
  implicitMentionPrefix: string,
): string {
  if (implicitMentionPrefix && content.startsWith(implicitMentionPrefix)) {
    return content.slice(implicitMentionPrefix.length);
  }
  return content;
}

export function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

export function commandDisplayName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function parseLeadingCommand(
  content: string,
  implicitMentionPrefix = "",
): ParsedCommand | null {
  const commandContent = stripImplicitMentionPrefix(
    content.trim(),
    implicitMentionPrefix,
  );
  const match = /^\/([^\s\n]+)(?:\s+([\s\S]*))?$/.exec(commandContent);
  if (!match) return null;
  return {
    name: match[1],
    arguments: match[2]?.trim() ?? "",
  };
}

export function filterAgentSessionCommands(
  commands: readonly AgentSessionCommand[],
  query: string,
): AgentSessionCommand[] {
  const normalizedQuery = normalizeCommandName(query);
  if (!normalizedQuery) return [...commands];
  return commands.filter((command) =>
    normalizeCommandName(command.name).includes(normalizedQuery),
  );
}

export type ComposerCommandDispatchResult = {
  status: AgentSessionCommandDispatchStatus;
  requestId?: string;
  acknowledged?: boolean;
};

type CommandPickerState = {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  selectedCommandName: string | null;
  commandStartOffset: number;
  dispatchError: string | null;
  dispatchNotice: string | null;
};

const INITIAL_STATE: CommandPickerState = {
  isOpen: false,
  query: "",
  selectedIndex: 0,
  selectedCommandName: null,
  commandStartOffset: 0,
  dispatchError: null,
  dispatchNotice: null,
};

function statusMessage({
  candidateCount,
  hasAgent,
  hasSession,
  catalogStatus,
  hasCatalog,
  query,
  suggestionCount,
}: {
  candidateCount: number;
  hasAgent: boolean;
  hasSession: boolean;
  catalogStatus: AgentSessionCommandCatalogStatus;
  hasCatalog: boolean;
  query: string;
  suggestionCount: number;
}): string | null {
  if (candidateCount > 1) {
    return "More than one managed agent is in this conversation. Address one agent to use commands.";
  }
  if (!hasAgent) {
    return "No managed agent is addressed in this conversation.";
  }
  if (!hasSession) {
    return "Send a message in this conversation to load its commands.";
  }
  if (catalogStatus === "stale") {
    return "Commands are stale. Wait for a fresh session update before sending.";
  }
  if (catalogStatus === "error") {
    return "The command catalog could not be read for this session.";
  }
  if (!hasCatalog || catalogStatus === "unsupported") {
    return "No commands have been advertised by this session yet.";
  }
  if (suggestionCount === 0) {
    return query
      ? `No commands match “${query}”.`
      : "No commands have been advertised by this session yet.";
  }
  return null;
}

function dispatchStatusMessage(
  result: ComposerCommandDispatchResult,
): string {
  switch (result.status) {
    case "active_turn":
      return "This agent is already handling a turn. The draft was kept.";
    case "ambiguous_target":
      return "The command target is ambiguous. The draft was kept.";
    case "no_agent":
      return "This conversation has no command-capable agent. The draft was kept.";
    case "stale_cache":
    case "stale_session":
      return "This command catalog is stale. The draft was kept.";
    case "unsupported_command":
      return "That command is not advertised by this session. The draft was kept.";
    case "runtime_error":
      return "The agent rejected the command. The draft was kept.";
    case "disabled":
      return "Command dispatch is unavailable. The draft was kept.";
    default:
      return "The command could not be dispatched. The draft was kept.";
  }
}

export function useComposerCommandPicker({
  applyAutocompleteEdit,
  channelId,
  implicitMentionPrefix = "",
  target,
}: {
  applyAutocompleteEdit: (edit: AutocompleteEdit) => void;
  channelId: string | null;
  implicitMentionPrefix?: string;
  target?: ComposerCommandTarget | null;
}) {
  const [state, setState] = React.useState(INITIAL_STATE);
  const [isDispatching, setIsDispatching] = React.useState(false);
  const isDispatchingRef = React.useRef(false);
  const stateRef = React.useRef(state);
  const draftContentRef = React.useRef("");
  const pendingRequestRef = React.useRef<string | null>(null);
  const terminalFramesRef = React.useRef(new Map<string, ControlResultFrame>());
  stateRef.current = state;

  const candidateAgentPubkeys = React.useMemo(() => {
    const candidates = new Set<string>();
    for (const pubkey of target?.candidateAgentPubkeys ?? []) {
      const normalized = normalizePubkey(pubkey);
      if (normalized) candidates.add(normalized);
    }
    const explicit = normalizePubkey(target?.agentPubkey ?? "");
    if (explicit) candidates.add(explicit);
    return [...candidates];
  }, [target?.agentPubkey, target?.candidateAgentPubkeys]);
  const agentPubkey =
    candidateAgentPubkeys.length === 1 ? candidateAgentPubkeys[0] : null;
  const hasAgent = candidateAgentPubkeys.length > 0;

  const getLatestSession = React.useCallback(
    () => getLatestLiveSessionId(agentPubkey, channelId),
    [agentPubkey, channelId],
  );
  const latestLiveSessionId = React.useSyncExternalStore(
    subscribeAgentObserverStore,
    getLatestSession,
    getLatestSession,
  );
  const sessionId =
    target?.sessionId !== undefined ? target.sessionId : latestLiveSessionId;
  const getCatalog = React.useCallback(
    () => getAgentSessionCommandCatalog(agentPubkey, sessionId),
    [agentPubkey, sessionId],
  );
  const subscribeCatalog = React.useCallback(
    (listener: () => void) => {
      if (!agentPubkey || !sessionId) return () => {};
      return subscribeAgentSessionCommandCatalog(
        agentPubkey,
        sessionId,
        () => listener(),
      );
    },
    [agentPubkey, sessionId],
  );
  const findCandidateCommand = React.useCallback(
    (commandName: string) => {
      for (const candidate of candidateAgentPubkeys) {
        const match = findAgentSessionCommand(candidate, commandName);
        if (match) return match;
      }
      return null;
    },
    [candidateAgentPubkeys],
  );
  const catalog = React.useSyncExternalStore(
    subscribeCatalog,
    getCatalog,
    getCatalog,
  );
  const catalogStatus = getAgentSessionCommandCatalogStatus(
    agentPubkey,
    sessionId,
  );
  const suggestions = React.useMemo(
    () => filterAgentSessionCommands(catalog?.commands ?? [], state.query),
    [catalog?.commands, state.query],
  );

  const commandTargetKey = `${channelId ?? ""}:${candidateAgentPubkeys.join(",")}:${sessionId ?? ""}`;
  React.useEffect(() => {
    if (isDispatchingRef.current || pendingRequestRef.current) return;
    setState(INITIAL_STATE);
  }, [commandTargetKey]);

  const updateQuery = React.useCallback(
    (text: string, cursor: number) => {
      draftContentRef.current = text;
      const beforeCursor = text.slice(0, cursor);
      const commandDraft = parseLeadingCommand(
        text,
        implicitMentionPrefix,
      );
      const commandStartOffset =
        implicitMentionPrefix && text.startsWith(implicitMentionPrefix)
          ? implicitMentionPrefix.length
          : 0;
      const sourceBeforeCursor = stripImplicitMentionPrefix(
        beforeCursor,
        implicitMentionPrefix,
      );
      const triggerMatch = /^\/([^\s\n]*)$/.exec(sourceBeforeCursor);
      const freshCommand =
        catalogStatus === "fresh" && commandDraft
          ? catalog?.commands.find(
              (command) =>
                normalizeCommandName(command.name) ===
                normalizeCommandName(commandDraft.name),
            )
          : null;
      const knownCommand =
        catalogStatus !== "fresh" && commandDraft
          ? findCandidateCommand(commandDraft.name)
          : null;

      setState((current) => {
        if (triggerMatch || freshCommand || knownCommand) {
          return {
            ...current,
            isOpen: true,
            query: triggerMatch?.[1] ?? commandDraft?.name ?? "",
            selectedIndex: 0,
            selectedCommandName:
              freshCommand?.name ??
              knownCommand?.command.name ??
              current.selectedCommandName,
            commandStartOffset,
            dispatchError: null,
          };
        }
        return {
          ...current,
          isOpen: false,
          query: "",
          selectedIndex: 0,
          selectedCommandName: null,
          commandStartOffset: 0,
          dispatchError: null,
        };
      });
    },
    [
      agentPubkey,
      catalog?.commands,
      catalogStatus,
      findCandidateCommand,
      implicitMentionPrefix,
    ],
  );

  const dismiss = React.useCallback(() => {
    setState((current) => ({ ...current, isOpen: false, dispatchError: null }));
  }, []);
  const reportDispatchError = React.useCallback((message: string) => {
    setState((current) => ({
      ...current,
      dispatchError: message,
      dispatchNotice: null,
    }));
  }, []);

  const selectCommand = React.useCallback(
    (command: AgentSessionCommand) => {
      const current = stateRef.current;
      const commandName = commandDisplayName(command.name);
      const commandStart = current.commandStartOffset;
      const cursor = Math.max(
        commandStart,
        commandStart + current.query.length + 1,
      );
      applyAutocompleteEdit({
        insertText: `${commandName} `,
        preserveSelection: false,
        replaceFromOffset: commandStart,
        replaceToOffset: cursor,
      });
      setState((previous) => ({
        ...previous,
        isOpen: true,
        query: command.name,
        selectedIndex: 0,
        selectedCommandName: command.name,
        dispatchError: null,
        dispatchNotice: null,
      }));
    },
    [applyAutocompleteEdit],
  );

  const selectSubcommand = React.useCallback(
    (subcommand: AgentSessionCommandSubcommand) => {
      const current = draftContentRef.current;
      const suffix = current.endsWith(" ") || current.length === 0 ? "" : " ";
      applyAutocompleteEdit({
        insertText: `${suffix}${subcommand.name} `,
        preserveSelection: false,
        replaceFromOffset: current.length,
        replaceToOffset: current.length,
      });
    },
    [applyAutocompleteEdit],
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (!stateRef.current.isOpen) return { handled: false };
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return { handled: true };
      }
      const parsed = parseLeadingCommand(
        draftContentRef.current,
        implicitMentionPrefix,
      );
      if (parsed?.arguments) return { handled: false };
      if (suggestions.length === 0) return { handled: false };
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setState((current) => ({
          ...current,
          selectedIndex:
            event.key === "ArrowDown"
              ? (current.selectedIndex + 1) % suggestions.length
              : (current.selectedIndex - 1 + suggestions.length) %
                suggestions.length,
        }));
        return { handled: true };
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        selectCommand(
          suggestions[stateRef.current.selectedIndex] ?? suggestions[0],
        );
        return { handled: true };
      }
      return { handled: false };
    },
    [dismiss, implicitMentionPrefix, selectCommand, suggestions],
  );

  const dispatchSelectedCommand = React.useCallback(
    async (
      content: string,
    ): Promise<{
      handled: boolean;
      succeeded: boolean;
      result?: ComposerCommandDispatchResult;
    }> => {
      const parsed = parseLeadingCommand(content, implicitMentionPrefix);
      if (!parsed) return { handled: false, succeeded: false };
      const freshCommand =
        catalogStatus === "fresh"
          ? catalog?.commands.find(
              (command) =>
                normalizeCommandName(command.name) ===
                normalizeCommandName(parsed.name),
            )
          : null;
      const knownCommand =
        catalogStatus !== "fresh" ? findCandidateCommand(parsed.name) : null;
      if (!freshCommand && !knownCommand) {
        return { handled: false, succeeded: false };
      }
      if (isDispatchingRef.current) {
        return { handled: true, succeeded: false };
      }
      isDispatchingRef.current = true;
      setIsDispatching(true);
      setState((previous) => ({
        ...previous,
        dispatchError: null,
        dispatchNotice: "Sending command…",
      }));

      let result: ComposerCommandDispatchResult;
      try {
        result = await dispatchAgentSessionCommand({
          agentPubkey,
          sessionId,
          commandName: freshCommand?.name ?? parsed.name,
          arguments: parsed.arguments || null,
          candidateAgentPubkeys,
          onTerminal: (frame) => {
            const requestId = frame.requestId;
            if (requestId) terminalFramesRef.current.set(requestId, frame);
            if (
              requestId &&
              pendingRequestRef.current === requestId
            ) {
              pendingRequestRef.current = null;
            }
            setState((previous) => ({
              ...previous,
              dispatchNotice: formatAgentSessionCommandTerminalNotice(frame),
            }));
          },
        });
      } catch {
        result = { status: "runtime_error", acknowledged: false };
      }

      const succeeded = result.status === "sent";
      if (succeeded) {
        const terminalFrame = result.requestId
          ? terminalFramesRef.current.get(result.requestId)
          : undefined;
        if (result.requestId && !terminalFrame) {
          pendingRequestRef.current = result.requestId;
        }
        setState((previous) => ({
          ...previous,
          isOpen: false,
          selectedCommandName: null,
          dispatchError: null,
          dispatchNotice: terminalFrame
            ? formatAgentSessionCommandTerminalNotice(terminalFrame)
            : "Command accepted. Waiting for completion.",
        }));
      } else {
        setState((previous) => ({
          ...previous,
          dispatchError: dispatchStatusMessage(result),
          dispatchNotice: null,
        }));
      }
      isDispatchingRef.current = false;
      setIsDispatching(false);
      return { handled: true, succeeded, result };
    },
    [
      agentPubkey,
      candidateAgentPubkeys,
      catalog?.commands,
      catalogStatus,
      findCandidateCommand,
      implicitMentionPrefix,
      sessionId,
    ],
  );
  const activeCommand =
    state.selectedCommandName && catalogStatus === "fresh"
      ? (catalog?.commands.find(
          (command) =>
            normalizeCommandName(command.name) ===
            normalizeCommandName(state.selectedCommandName ?? ""),
        ) ?? null)
      : state.selectedCommandName
        ? (findCandidateCommand(state.selectedCommandName)?.command ?? null)
        : null;
  const isCommandRecognized = activeCommand !== null;
  const targetSummary =
    agentPubkey && sessionId
      ? `agent ${agentPubkey.slice(0, 8)} · session ${sessionId.slice(0, 8)}`
      : null;
  const stateStatus = statusMessage({
    candidateCount: candidateAgentPubkeys.length,
    hasAgent,
    hasSession: Boolean(sessionId),
    catalogStatus,
    hasCatalog: catalog !== null,
    query: state.query,
    suggestionCount: suggestions.length,
  });

  return {
    isCommandRecognized,
    activeCommand,
    catalog,
    catalogStatus,
    dispatchError: state.dispatchError,
    dispatchNotice: state.dispatchNotice,
    dispatchSelectedCommand,
    handleKeyDown,
    isCommandOpen: state.isOpen,
    isDispatching,
    query: state.query,
    selectedCommandName: state.selectedCommandName,
    selectedIndex: state.selectedIndex,
    targetSummary,
    sessionId,
    stateStatus,
    suggestions,
    dismiss,
    reportDispatchError,
    selectCommand,
    selectSubcommand,
    updateQuery,
  };
}
