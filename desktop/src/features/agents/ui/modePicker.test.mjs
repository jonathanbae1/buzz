import assert from "node:assert/strict";
import test from "node:test";

import {
  MODE_DEFAULT_DROPDOWN_VALUE,
  modePickerState,
  modeSelectionToPersistedValue,
} from "./modePicker.ts";

const localBackend = { type: "local" };
const providerBackend = { type: "provider", id: "openai", config: {} };
const options = [
  { value: "default", displayName: "Default" },
  { value: "plan", displayName: "Plan" },
];

test("session mode picker is hidden for a provider backend", () => {
  const state = modePickerState({
    backend: providerBackend,
    modeConfigId: "mode",
    modeOptions: options,
    configuredMode: "plan",
    runningMode: "plan",
  });
  assert.equal(state.visible, false);
});

test("session mode picker is hidden without a discovered mode config id", () => {
  const state = modePickerState({
    backend: localBackend,
    modeConfigId: undefined,
    modeOptions: options,
    configuredMode: "plan",
    runningMode: "plan",
  });
  assert.equal(state.visible, false);
});

test("session mode picker exposes adapter options and selects the configured mode", () => {
  const state = modePickerState({
    backend: localBackend,
    modeConfigId: "session_mode",
    modeOptions: options,
    configuredMode: "plan",
    runningMode: "plan",
  });
  assert.equal(state.visible, true);
  assert.deepEqual(state.options, [
    { label: "Adapter default", value: MODE_DEFAULT_DROPDOWN_VALUE },
    { label: "Default", value: "default" },
    { label: "Plan", value: "plan" },
  ]);
  assert.equal(state.selectValue, "plan");
  assert.equal(state.runningNotice, null);
});

test("an unknown configured mode falls back to the adapter default", () => {
  const state = modePickerState({
    backend: localBackend,
    modeConfigId: "mode",
    modeOptions: options,
    configuredMode: "unknown",
    runningMode: "default",
  });
  assert.equal(state.selectValue, MODE_DEFAULT_DROPDOWN_VALUE);
});

// The picker selects the mode the NEXT session starts in, so a session already
// running a different mode must be stated rather than silently contradicted.
test("a running mode that differs from the selection is reported by display name", () => {
  const state = modePickerState({
    backend: localBackend,
    modeConfigId: "mode",
    modeOptions: options,
    configuredMode: "plan",
    runningMode: "default",
  });
  assert.equal(state.selectValue, "plan");
  assert.equal(state.runningNotice, "Default");
});

test("no notice is shown while nothing is configured", () => {
  const state = modePickerState({
    backend: localBackend,
    modeConfigId: "mode",
    modeOptions: options,
    configuredMode: null,
    runningMode: "default",
  });
  assert.equal(state.selectValue, MODE_DEFAULT_DROPDOWN_VALUE);
  assert.equal(state.runningNotice, null);
});

test("the adapter-default selection clears the persisted session mode", () => {
  assert.equal(
    modeSelectionToPersistedValue(MODE_DEFAULT_DROPDOWN_VALUE),
    null,
  );
});

test("a concrete mode selection persists as its explicit value", () => {
  assert.equal(modeSelectionToPersistedValue("plan"), "plan");
});
