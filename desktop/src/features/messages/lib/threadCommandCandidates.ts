import { getOverrides } from "@/shared/features/store";

type ThreadMessageLike = {
  pubkey?: string;
  tags?: string[][];
};

/**
 * Managed agents a thread reply addresses for slash commands: the thread
 * head's author and `p` mentions, plus every reply author, restricted to known
 * managed agents. The channel composer's candidates (currently active agents)
 * do not apply in a thread, where the conversation already names its agent.
 */
export function threadCommandCandidates(
  head: ThreadMessageLike,
  replies: readonly ThreadMessageLike[],
  knownAgentPubkeys: ReadonlySet<string>,
): string[] {
  const candidates = new Set<string>();
  const consider = (pubkey: string | undefined) => {
    const normalized = pubkey?.trim().toLowerCase();
    if (normalized && knownAgentPubkeys.has(normalized)) {
      candidates.add(normalized);
    }
  };
  consider(head.pubkey);
  for (const tag of head.tags ?? []) {
    if (tag[0] === "p") consider(tag[1]);
  }
  for (const reply of replies) consider(reply.pubkey);
  return [...candidates];
}

/**
 * With the experimental thread-scoped ACP sessions, each thread in a non-DM
 * channel runs its own session, but observer events carry no thread root, so
 * the desktop cannot tell which session is this thread's. Commands are refused
 * there rather than sent to whichever session in the channel was latest. DMs
 * are always one conversation session (buzz-acp `SessionScope::Conversation`).
 */
export function threadScopeRefusal(
  channelType: string | null,
  threadScopedSessions = getOverrides().threadScopedAcpSessions === true,
): { sessionId?: null; unresolvedScopeReason?: string } {
  if (!threadScopedSessions || channelType === "dm") return {};
  return {
    sessionId: null,
    unresolvedScopeReason:
      "Commands are unavailable here: thread-scoped agent sessions are on, and Buzz cannot yet tell which session belongs to this conversation.",
  };
}
