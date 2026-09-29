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
