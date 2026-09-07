import * as React from "react";
import { CircleAlert, Play, TerminalSquare } from "lucide-react";

import type {
  AgentSessionCommand,
  AgentSessionCommandSubcommand,
} from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import {
  POPOVER_CUSTOM_ENTER_MOTION_CLASS,
  POPOVER_SHADOW_STYLE,
  POPOVER_SURFACE_CLASS,
} from "@/shared/ui/popoverSurface";
import { commandDisplayName } from "./useComposerCommandPicker";

type CommandAutocompleteProps = {
  activeCommand?: AgentSessionCommand | null;
  composerOwnsFocus: boolean;
  isDispatching?: boolean;
  query: string;
  selectedIndex: number;
  stateStatus: string | null;
  suggestions: readonly AgentSessionCommand[];
  targetSummary?: string | null;
  onDismiss: () => void;
  onRun: () => void;
  onSelect: (command: AgentSessionCommand) => void;
  onSelectSubcommand: (subcommand: AgentSessionCommandSubcommand) => void;
};

export const CommandAutocomplete = React.memo(function CommandAutocomplete({
  activeCommand = null,
  composerOwnsFocus,
  isDispatching = false,
  query,
  selectedIndex,
  stateStatus,
  suggestions,
  targetSummary = null,
  onDismiss,
  onRun,
  onSelect,
  onSelectSubcommand,
}: CommandAutocompleteProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(
        `[data-command-suggestion-index="${selectedIndex}"]`,
      )
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  React.useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      const target = event.target;
      if (!root || !(target instanceof Node) || root.contains(target)) return;
      onDismiss();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [onDismiss]);

  if (!composerOwnsFocus) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the overlay owns Escape and pointer focus guards for its child controls.
    <div
      className="absolute bottom-full left-0 right-0 z-50 px-3 pb-1 sm:px-4"
      data-testid="command-autocomplete-layer"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      }}
      ref={rootRef}
    >
      <div className="w-full max-w-2xl">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: prevents the owning editor from blurring before a command button receives its click. */}
        <div
          className={cn(
            "max-h-64 w-full overflow-y-auto rounded-xl p-1",
            POPOVER_CUSTOM_ENTER_MOTION_CLASS,
            "origin-bottom slide-in-from-bottom-1",
            POPOVER_SURFACE_CLASS,
          )}
          data-testid="command-autocomplete"
          onMouseDown={(event) => event.preventDefault()}
          ref={listRef}
          role="listbox"
          aria-label={query ? `Agent commands matching ${query}` : "Agent commands"}
          style={POPOVER_SHADOW_STYLE}
        >
          {activeCommand ? (
            <div
              aria-label={`Run ${commandDisplayName(activeCommand.name)}`}
              className="mb-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
              data-testid="command-action-panel"
              role="group"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-sm font-medium">
                    {commandDisplayName(activeCommand.name)}
                  </div>
                  {activeCommand.description ? (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {activeCommand.description}
                    </div>
                  ) : null}
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Target: {targetSummary ?? "current agent session"}
                  </div>
                </div>
                <button
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  data-testid="command-run"
                  disabled={isDispatching}
                  onClick={onRun}
                  onMouseDown={(event) => event.preventDefault()}
                  type="button"
                >
                  <Play aria-hidden className="size-3" />
                  Run
                </button>
              </div>
              {activeCommand.subcommands?.length ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">
                    Actions
                  </span>
                  {activeCommand.subcommands.map((subcommand) => (
                    <button
                      aria-label={`Use ${commandDisplayName(activeCommand.name)} ${subcommand.name}`}
                      className="rounded-md border border-border/70 bg-background px-2 py-1 font-mono text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isDispatching}
                      key={subcommand.name}
                      onClick={() => onSelectSubcommand(subcommand)}
                      onMouseDown={(event) => event.preventDefault()}
                      title={subcommand.description ?? subcommand.usage}
                      type="button"
                    >
                      {subcommand.name}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="mt-1 text-[11px] text-muted-foreground">
                Type arguments in the composer, then choose Run.
              </div>
            </div>
          ) : null}
          {suggestions.length > 0 ? (
            suggestions.map((command, index) => (
              <button
                aria-label={`Use ${commandDisplayName(command.name)}`}
                aria-selected={index === selectedIndex}
                className={cn(
                  "flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-sm",
                  index === selectedIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-popover-foreground hover:bg-accent/50",
                  isDispatching && "cursor-not-allowed opacity-60",
                )}
                data-command-suggestion-index={index}
                disabled={isDispatching}
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (!isDispatching) {
                    onSelect(command);
                  }
                }}
                role="option"
                type="button"
              >
                <TerminalSquare aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block font-mono font-medium">
                    {commandDisplayName(command.name)}
                  </span>
                  {command.description ? (
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {command.description}
                    </span>
                  ) : null}
                </span>
              </button>
            ))
          ) : (
            <div
              className="flex items-start gap-2 px-3 py-2 text-sm text-muted-foreground"
              data-testid="command-autocomplete-status"
              role="status"
            >
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{stateStatus ?? "No matching commands."}</span>
            </div>
          )}
          {suggestions.length > 0 && stateStatus ? (
            <div
              className="border-t border-border/50 px-3 py-2 text-xs text-muted-foreground"
              data-testid="command-autocomplete-state"
              role="status"
            >
              {stateStatus}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});
