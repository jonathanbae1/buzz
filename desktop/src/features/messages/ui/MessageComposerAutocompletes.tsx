import { setKeepMentionedAgentsPinned } from "@/features/messages/lib/autoPinMentionedAgentsPreference";
import type {
  AgentSessionCommand,
  AgentSessionCommandSubcommand,
} from "@/shared/api/types";
import type {
  ChannelSuggestion,
  UseChannelLinksResult,
} from "@/features/messages/lib/useChannelLinks";
import type {
  EmojiSuggestion,
  UseEmojiAutocompleteResult,
} from "@/features/messages/lib/useEmojiAutocomplete";
import type { UseMentionsResult } from "@/features/messages/lib/useMentions";
import { ChannelAutocomplete } from "./ChannelAutocomplete";
import { CommandAutocomplete } from "./CommandAutocomplete";
import { EmojiAutocomplete } from "./EmojiAutocomplete";
import {
  MentionAutocomplete,
  type MentionSuggestion,
} from "./MentionAutocomplete";

type MessageComposerAutocompletesProps = {
  /**
   * Whether the mention menu offers its agent-audience controls. Edit
   * composers and channels without a persistent audience omit them.
   */
  audienceControlsEnabled: boolean;
  channelLinks: UseChannelLinksResult;
  commandPicker: {
    activeCommand: AgentSessionCommand | null;
    composerOwnsFocus: boolean;
    isCommandRecognized: boolean;
    isCommandOpen: boolean;
    isDispatching: boolean;
    query: string;
    selectedIndex: number;
    stateStatus: string | null;
    suggestions: readonly AgentSessionCommand[];
    targetSummary: string | null;
    onDismiss: () => void;
    onRun: () => void;
    onSelect: (command: AgentSessionCommand) => void;
    onSelectSubcommand: (
      subcommand: AgentSessionCommandSubcommand,
    ) => void;
  };
  composerOwnsFocus: boolean;
  emojiAutocomplete: UseEmojiAutocompleteResult;
  keepMentionedAgentsPinned: boolean;
  lockedAgentPubkeys: ReadonlySet<string>;
  mentions: UseMentionsResult;
  /**
   * Bumped to ask the mention menu to reveal its agent-audience options; the
   * menu reports back through `onOptionsRevealComplete` once it has.
   */
  openOptionsRequest?: number;
  onChannelSelect: (suggestion: ChannelSuggestion) => void;
  onEmojiSelect: (suggestion: EmojiSuggestion) => void;
  onMentionSelect: (suggestion: MentionSuggestion) => void;
  onOptionsRevealComplete?: (request: number) => void;
  onToggleAlwaysAddressAgent: (suggestion: MentionSuggestion) => void;
};

/**
 * The message composer's three suggestion overlays. Each one gates its own
 * rendering on `composerOwnsFocus`, so a background composer replaying a
 * stale update cannot resurrect a suggestion menu over the focused composer,
 * while keyboard focus moving into an overlay's own controls keeps that
 * overlay mounted.
 */
export function MessageComposerAutocompletes({
  audienceControlsEnabled,
  channelLinks,
  commandPicker,
  composerOwnsFocus,
  emojiAutocomplete,
  keepMentionedAgentsPinned,
  lockedAgentPubkeys,
  mentions,
  openOptionsRequest,
  onChannelSelect,
  onEmojiSelect,
  onMentionSelect,
  onOptionsRevealComplete,
  onToggleAlwaysAddressAgent,
}: MessageComposerAutocompletesProps) {
  return (
    <>
      <CommandAutocomplete
        activeCommand={commandPicker.activeCommand}
        composerOwnsFocus={
          composerOwnsFocus && commandPicker.isCommandOpen
        }
        isDispatching={commandPicker.isDispatching}
        onDismiss={commandPicker.onDismiss}
        onRun={commandPicker.onRun}
        onSelect={commandPicker.onSelect}
        onSelectSubcommand={commandPicker.onSelectSubcommand}
        query={commandPicker.query}
        selectedIndex={commandPicker.selectedIndex}
        stateStatus={commandPicker.stateStatus}
        suggestions={commandPicker.suggestions}
        targetSummary={commandPicker.targetSummary}
      />
      <EmojiAutocomplete
        composerOwnsFocus={composerOwnsFocus}
        onSelect={onEmojiSelect}
        selectedIndex={emojiAutocomplete.emojiSelectedIndex}
        suggestions={
          emojiAutocomplete.isEmojiAutocompleteOpen
            ? emojiAutocomplete.emojiSuggestions
            : []
        }
      />
      <ChannelAutocomplete
        composerOwnsFocus={composerOwnsFocus}
        onSelect={onChannelSelect}
        selectedIndex={channelLinks.channelSelectedIndex}
        suggestions={
          channelLinks.isChannelOpen ? channelLinks.channelSuggestions : []
        }
      />
      <MentionAutocomplete
        composerOwnsFocus={composerOwnsFocus}
        keepMentionedAgentsPinned={keepMentionedAgentsPinned}
        lockedAgentPubkeys={lockedAgentPubkeys}
        openOptionsRequest={openOptionsRequest}
        onKeepMentionedAgentsPinnedChange={
          audienceControlsEnabled ? setKeepMentionedAgentsPinned : undefined
        }
        onOptionsRevealComplete={onOptionsRevealComplete}
        onToggleAlwaysAddressAgent={
          audienceControlsEnabled ? onToggleAlwaysAddressAgent : undefined
        }
        onFetchMore={mentions.fetchMoreSuggestions}
        onDismiss={mentions.cancelMentionAutocomplete}
        onSelect={onMentionSelect}
        selectedIndex={mentions.mentionSelectedIndex}
        suggestions={mentions.isMentionOpen ? mentions.suggestions : []}
      />
    </>
  );
}
