import type * as React from "react";

import type { ParsedMessageLink } from "@/features/messages/lib/messageLink";
import type { ParsedEntityLink } from "@/shared/lib/entityLink";
import type { Channel } from "@/shared/api/types";
import type { CustomEmoji } from "@/shared/lib/remarkCustomEmoji";
import type { VideoReviewContext } from "../VideoPlayer";

export type ImetaEntry = {
  dim?: string;
  image?: string;
  thumb?: string;
  m?: string;
  size?: number;
  filename?: string;
  duration?: number;
  /** SHA-256 hex of the attachment bytes (from imeta `x` field). */
  x?: string;
};

export type ImetaLookup = Map<string, ImetaEntry>;

export type MessageLinkPillProps = {
  /** Member channels available synchronously from the caller's runtime. */
  channels?: Channel[];
  /** Resolve a missing channel id with a bounded detail query. */
  resolveChannelReference?: boolean;
  /** Original permalink text, preserved for the context menu's Copy action. */
  href?: string;
  interactive: boolean;
  link: ParsedMessageLink;
  onOpenChannel: (channelId: string) => void;
  onOpenMessageLink: (link: ParsedMessageLink) => void;
  threadExcerpt?: string | null;
  variant?: "default" | "sent-from-thread";
};

export type MarkdownRuntime = {
  agentMentionPubkeysByName?: Record<string, string>;
  channels: Channel[];
  imetaByUrl?: ImetaLookup;
  /** Inline content supplied to the first prose-capable Markdown block. */
  leadingInlineContent?: React.ReactNode;
  mentionPubkeysByName?: Record<string, string>;
  onOpenChannel: (channelId: string) => void;
  /** Navigate to a Buzz git entity (`buzz://pr|issue|repo` deep link). */
  onOpenEntityLink: (link: ParsedEntityLink) => void;
  onOpenMessageLink: (link: ParsedMessageLink) => void;
  /**
   * The resolved relay origin (e.g. `https://buzz.block.builderlab.xyz`),
   * or `null` when not yet resolved. Used by the anchor component to
   * validate that clone-URL rewrites point to the active relay only.
   */
  relayOrigin: string | null;
  resolveChannelReferences?: boolean;
  /** Display name of the message author sharing an agent snapshot. */
  snapshotSharedBy?: string;
  /**
   * Resolves relative hrefs when the document surface is active. Supplied by
   * the caller (never captured in the cached component map), so the parse
   * cache stays policy-free.
   */
  documentLinkPolicy?: MarkdownDocumentLinkPolicy;
  /**
   * Navigate to another document in the same collection, scrolled to
   * `heading` when given. Only used when `documentSurface` is set.
   */
  onOpenDocumentLink?: (href: string, heading?: string) => void;
  /**
   * Open a root-confined file outside the collection (e.g. `../buzz-fork.json`)
   * through the local content reader, with an *Open in editor* action. The
   * action is explicit so the anchor never encodes one into a path prefix.
   */
  onOpenDocumentArtifact?: (path: string, action: "preview" | "editor") => void;
  /**
   * Decide whether a `(source: path:line)` citation resolves to exactly one
   * tracked file. Supplied by the caller, which is the only party that knows
   * the checkout; without it every citation renders inert.
   */
  resolveSourceCitation?: (
    path: string | undefined,
    line?: number,
  ) => DocumentCitationResolution;
  /** Navigate to a resolved `(source: …)` citation. */
  onOpenSourceCitation?: (path: string, line?: number) => void;
  /**
   * Called by AgentSnapshotCard after a successful verified in-memory fetch.
   * The implementation should navigate to /agents and trigger the existing
   * snapshot import flow with the supplied bytes. Optional — when absent the
   * Import button is present but falls back to a no-op (the card is still
   * rendered on read-only surfaces such as the forum post renderer).
   */
  onImportSnapshotFromUrl?: (
    fileBytes: number[],
    fileName: string,
    snapshotKind: "agent" | "team",
  ) => void;
};

export type MarkdownProps = {
  channelNames?: string[];
  className?: string;
  content: string;
  customEmoji?: CustomEmoji[];
  /**
   * When true (default), single newlines become `<br>` — chat Enter behavior.
   * Git commit bodies are hard-wrapped at ~72 columns; pass false so those
   * wraps reflow with the panel instead of staying a narrow column.
   */
  hardLineBreaks?: boolean;
  imetaByUrl?: ImetaLookup;
  interactive?: boolean;
  /**
   * Render fenced code as scrollable code blocks even when `interactive` is
   * false. Non-interactive surfaces default to inlining code (compact
   * previews); document surfaces like repository READMEs pass true so long
   * lines scroll inside the block instead of stretching the layout.
   */
  blockCode?: boolean;
  agentMentionPubkeysByName?: Record<string, string>;
  mentionNames?: string[];
  mentionPubkeysByName?: Record<string, string>;
  mediaInset?: boolean;
  /** Event/message identity used only for local preview-image visibility. */
  messageId?: string;
  linkPreviewsSuppressed?: boolean;
  linkPreviewTags?: readonly (readonly string[])[];
  /** Inline content prepended inside the first rendered prose paragraph. */
  leadingInlineContent?: React.ReactNode;
  onRemoveLinkPreviewsForEveryone?: () => Promise<void>;
  searchQuery?: string;
  /** Display name shown in shared-agent card metadata. */
  snapshotSharedBy?: string;
  videoReviewContext?: VideoReviewContext;
  /**
   * When set and the nudge payload's agent_pubkey matches, renders the
   * config-nudge sentinel as an Attachment card and strips the fence from
   * displayed prose. Must be undefined/null for every non-message Markdown
   * surface — keeps card rendering opt-in so untrusted content cannot forge
   * a nudge card.
   */
  configNudgeAuthorPubkey?: string | null;
  /**
   * Render as a document rather than a chat message: headings get stable
   * GitHub-style ids, and relative markdown hrefs inside `content` are routed
   * through `documentLinkPolicy` instead of being handed to the OS opener as
   * meaningless relative URLs. Off by default so chat and README rendering are
   * byte-for-byte unchanged.
   */
  documentSurface?: boolean;
  /**
   * Resolve one relative/absolute href from document content. Only consulted
   * when `documentSurface` is set. Returning `null` renders the link as inert
   * monospace text — never a live link to a wrong target.
   */
  documentLinkPolicy?: MarkdownDocumentLinkPolicy;
  /** Navigate to another document in the same collection (document surface). */
  onOpenDocumentLink?: (href: string, heading?: string) => void;
  /** Open a root-confined artifact outside the collection (document surface). */
  onOpenDocumentArtifact?: (path: string, action: "preview" | "editor") => void;
  /**
   * Decide whether a `(source: path:line)` citation resolves to exactly one
   * tracked file. Supplied by the caller, which is the only party that knows
   * the checkout; without it every citation renders inert.
   */
  resolveSourceCitation?: (
    path: string | undefined,
    line?: number,
  ) => DocumentCitationResolution;
  /** Navigate to a resolved `(source: …)` citation. */
  onOpenSourceCitation?: (path: string, line?: number) => void;
};

/**
 * Whether a `(source: …)` citation resolves to exactly one tracked file.
 *
 * The chip cannot navigate without this: a citation that matches zero or
 * several files must render inert, because opening one of two same-named files
 * looks authoritative and is wrong.
 */
export type DocumentCitationResolution =
  | { navigable: false }
  | { navigable: true; path: string; line?: number };

/** Where a document-surface relative link points, decided by resolution. */
export type MarkdownDocumentLinkTarget =
  /** A page inside the same document collection (optionally + heading). */
  | { kind: "document"; href: string; heading?: string }
  /** A file inside the checkout but outside the collection (root-confined). */
  | { kind: "artifact"; path: string }
  /** An absolute http(s) URL: the only class ExternalLinkAnchor is correct for. */
  | { kind: "external"; href: string }
  /** Nothing resolvable: render inert. */
  | { kind: "unresolved" };

export type MarkdownDocumentLinkPolicy = (
  href: string,
) => MarkdownDocumentLinkTarget;
