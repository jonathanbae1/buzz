import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    window: dom.window,
  });
});

afterEach(async () => {
  dom.window.localStorage.clear();
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

function keyEvent(key, overrides = {}) {
  return {
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    key,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

test("history navigation shortcuts stay separate from edit-last and reload", async () => {
  const { getPromptHistoryDirection } = await import("./usePromptHistory.ts");

  assert.equal(
    getPromptHistoryDirection(keyEvent("ArrowUp", { altKey: true })),
    "older",
  );
  assert.equal(
    getPromptHistoryDirection(keyEvent("ArrowDown", { altKey: true })),
    "newer",
  );
  assert.equal(getPromptHistoryDirection(keyEvent("ArrowUp")), null);
  assert.equal(getPromptHistoryDirection(keyEvent("ArrowDown")), null);
  assert.equal(
    getPromptHistoryDirection(
      keyEvent("ArrowUp", { altKey: true, ctrlKey: true }),
    ),
    null,
  );
  assert.equal(
    getPromptHistoryDirection(
      keyEvent("ArrowUp", { altKey: true, defaultPrevented: true }),
    ),
    null,
  );
  assert.equal(
    getPromptHistoryDirection(keyEvent("r", { ctrlKey: true })),
    null,
  );
  assert.equal(
    getPromptHistoryDirection(keyEvent("r", { metaKey: true })),
    null,
  );
});

test("history is per agent, capped, deduplicated, and stores trimmed sent prompts", async () => {
  const { act, renderHook } = await import("@testing-library/react");
  const { promptHistoryStorageKey, usePromptHistory } = await import(
    "./usePromptHistory.ts"
  );
  const agentAKey = promptHistoryStorageKey("A".repeat(64));
  const agentBKey = promptHistoryStorageKey("B".repeat(64));
  const { result, rerender } = renderHook(
    ({ storageKey }) => usePromptHistory(storageKey),
    { initialProps: { storageKey: agentAKey } },
  );

  act(() => {
    result.current.recordSentPrompt("  prompt-1  ");
    for (let index = 2; index <= 10; index += 1) {
      result.current.recordSentPrompt(`prompt-${index}`);
    }
    result.current.recordSentPrompt(" prompt-10 ");
  });

  assert.deepEqual(JSON.parse(localStorage.getItem(agentAKey)), [
    "prompt-10",
    "prompt-9",
    "prompt-8",
    "prompt-7",
    "prompt-6",
    "prompt-5",
    "prompt-4",
    "prompt-3",
  ]);
  assert.equal(localStorage.getItem(agentBKey), null);

  rerender({ storageKey: agentBKey });
  assert.equal(result.current.navigate("older", "draft"), null);
  act(() => result.current.recordSentPrompt("agent b prompt"));
  assert.deepEqual(JSON.parse(localStorage.getItem(agentBKey)), [
    "agent b prompt",
  ]);
});

test("history navigation restores the current draft and stops after manual edits", async () => {
  const { act, renderHook } = await import("@testing-library/react");
  const { promptHistoryStorageKey, usePromptHistory } = await import(
    "./usePromptHistory.ts"
  );
  const storageKey = promptHistoryStorageKey("C".repeat(64));
  const { result } = renderHook(() => usePromptHistory(storageKey));

  act(() => {
    result.current.recordSentPrompt("older prompt");
    result.current.recordSentPrompt("newest prompt");
  });

  assert.equal(
    result.current.navigate("older", "unfinished draft"),
    "newest prompt",
  );
  assert.equal(
    result.current.navigate("older", "newest prompt"),
    "older prompt",
  );
  assert.equal(
    result.current.navigate("older", "older prompt"),
    "older prompt",
  );
  assert.equal(
    result.current.navigate("newer", "older prompt"),
    "newest prompt",
  );
  assert.equal(
    result.current.navigate("newer", "newest prompt"),
    "unfinished draft",
  );
  assert.equal(result.current.navigate("newer", "unfinished draft"), null);

  assert.equal(result.current.navigate("older", "draft"), "newest prompt");
  act(() => result.current.observeComposerText("edited prompt"));
  assert.equal(
    result.current.navigate("older", "edited prompt"),
    "newest prompt",
  );
  assert.equal(
    result.current.navigate("newer", "newest prompt"),
    "edited prompt",
  );
});
