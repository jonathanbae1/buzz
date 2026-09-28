import * as React from "react";

const STORAGE_KEY_PREFIX = "buzz:agent-prompt-history";
const MAX_PROMPTS = 8;

type PromptHistoryDirection = "older" | "newer";

type NavigationState = {
  storageKey: string | null;
  prompts: string[];
  index: number | null;
  draft: string;
  displayedPrompt: string | null;
};

type CachedHistory = {
  storageKey: string | null;
  prompts: string[];
};

function createNavigationState(storageKey: string | null): NavigationState {
  return {
    storageKey,
    prompts: [],
    index: null,
    draft: "",
    displayedPrompt: null,
  };
}

export function promptHistoryStorageKey(
  agentPubkey: string | null | undefined,
): string | null {
  const normalizedPubkey = agentPubkey?.trim().toLowerCase();
  return normalizedPubkey
    ? `${STORAGE_KEY_PREFIX}:${normalizedPubkey}`
    : null;
}

export function getPromptHistoryDirection(
  event: Pick<
    KeyboardEvent,
    | "key"
    | "altKey"
    | "ctrlKey"
    | "metaKey"
    | "shiftKey"
    | "defaultPrevented"
    | "isComposing"
  >,
): PromptHistoryDirection | null {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    !event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return null;
  }

  if (event.key === "ArrowUp") return "older";
  if (event.key === "ArrowDown") return "newer";
  return null;
}

function readPromptHistory(storageKey: string): string[] | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const prompts: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string") continue;
      const prompt = value.trim();
      if (!prompt || prompts.includes(prompt)) continue;
      prompts.push(prompt);
      if (prompts.length === MAX_PROMPTS) break;
    }
    return prompts;
  } catch {
    return null;
  }
}

export function usePromptHistory(storageKey: string | null): {
  recordSentPrompt: (prompt: string) => void;
  navigate: (
    direction: PromptHistoryDirection,
    currentText: string,
  ) => string | null;
  observeComposerText: (text: string) => void;
} {
  const cachedHistoryRef = React.useRef<CachedHistory>({
    storageKey,
    prompts: [],
  });
  const navigationRef = React.useRef(createNavigationState(storageKey));

  React.useEffect(() => {
    const loadedPrompts = storageKey ? readPromptHistory(storageKey) : [];
    cachedHistoryRef.current = {
      storageKey,
      prompts: loadedPrompts ?? [],
    };
    navigationRef.current = createNavigationState(storageKey);
  }, [storageKey]);

  const recordSentPrompt = React.useCallback(
    (content: string) => {
      const prompt = content.trim();
      if (!storageKey || !prompt) return;

      const cached =
        cachedHistoryRef.current.storageKey === storageKey
          ? cachedHistoryRef.current.prompts
          : [];
      const current = readPromptHistory(storageKey) ?? cached;
      const next = [prompt, ...current.filter((entry) => entry !== prompt)].slice(
        0,
        MAX_PROMPTS,
      );
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Keep the current-session history when localStorage is unavailable.
      }
      cachedHistoryRef.current = { storageKey, prompts: next };
      navigationRef.current = createNavigationState(storageKey);
    },
    [storageKey],
  );

  const navigate = React.useCallback(
    (direction: PromptHistoryDirection, currentText: string) => {
      if (!storageKey) {
        navigationRef.current = createNavigationState(storageKey);
        return null;
      }

      let navigation = navigationRef.current;
      if (navigation.storageKey !== storageKey) {
        navigation = createNavigationState(storageKey);
        navigationRef.current = navigation;
      }

      if (direction === "older") {
        if (navigation.index === null) {
          const cached =
            cachedHistoryRef.current.storageKey === storageKey
              ? cachedHistoryRef.current.prompts
              : [];
          const prompts = readPromptHistory(storageKey) ?? cached;
          if (prompts.length === 0) return null;
          cachedHistoryRef.current = { storageKey, prompts };
          navigation.prompts = prompts;
          navigation.draft = currentText;
          navigation.index = 0;
        } else {
          navigation.index = Math.min(
            navigation.index + 1,
            navigation.prompts.length - 1,
          );
        }
        navigation.displayedPrompt = navigation.prompts[navigation.index];
        return navigation.displayedPrompt;
      }

      if (navigation.index === null) return null;
      if (navigation.index === 0) {
        const draft = navigation.draft;
        navigationRef.current = createNavigationState(storageKey);
        return draft;
      }

      navigation.index -= 1;
      navigation.displayedPrompt = navigation.prompts[navigation.index];
      return navigation.displayedPrompt;
    },
    [storageKey],
  );

  const observeComposerText = React.useCallback(
    (text: string) => {
      const navigation = navigationRef.current;
      if (
        navigation.storageKey !== storageKey ||
        navigation.index === null ||
        text === navigation.displayedPrompt
      ) {
        return;
      }
      navigationRef.current = createNavigationState(storageKey);
    },
    [storageKey],
  );

  return { recordSentPrompt, navigate, observeComposerText };
}
