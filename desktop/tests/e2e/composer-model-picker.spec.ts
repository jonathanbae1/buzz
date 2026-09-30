import { expect, test, type Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

type TestWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke?: (command: string, payload?: unknown) => Promise<unknown>;
  };
  __BUZZ_E2E_QUERY_CLIENT__?: {
    invalidateQueries: (input: {
      queryKey: readonly unknown[];
    }) => Promise<unknown>;
  };
  __BUZZ_E2E_SEED_LIVE_OBSERVER_EVENTS__?: (input: {
    agentPubkey: string;
    events: Array<Record<string, unknown>>;
  }) => void;
  __BUZZ_E2E_COMMAND_LOG__?: Array<{ command: string; payload: unknown }>;
};

const AGENT = "f".repeat(64);
const SESSION_ID = "session-e2e-model";

async function seedDirectSession(page: Page) {
  return page.evaluate(
    async ({ agent, session }) => {
      const state = window as TestWindow;
      const invoke = state.__TAURI_INTERNALS__?.invoke;
      if (!invoke) throw new Error("Mock Tauri invoke bridge is unavailable.");
      const channel = (await invoke("open_dm", { pubkeys: [agent] })) as {
        id?: unknown;
      } | null;
      if (typeof channel?.id !== "string") {
        throw new Error("Mock direct-message creation returned no channel id.");
      }
      state.__BUZZ_E2E_SEED_LIVE_OBSERVER_EVENTS__?.({
        agentPubkey: agent,
        events: [
          {
            seq: 1,
            timestamp: new Date().toISOString(),
            kind: "session_start",
            agentIndex: null,
            channelId: channel.id,
            sessionId: session,
            turnId: null,
            payload: {},
          },
        ],
      });
      await state.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
        queryKey: ["channels"],
      });
      return channel.id;
    },
    { agent: AGENT, session: SESSION_ID },
  );
}

async function commandLog(page: Page) {
  return page.evaluate(
    () => (window as TestWindow).__BUZZ_E2E_COMMAND_LOG__ ?? [],
  );
}

test.describe("composer /model", () => {
  test("a bare /model opens the session model picker and never dispatches the text command", async ({
    page,
  }) => {
    await installMockBridge(page, {
      managedAgents: [{ pubkey: AGENT, name: "Scout", status: "running" }],
      agentConfigSurfaces: {
        [AGENT]: {
          modelConfigId: "model",
          modelOptions: [
            { value: "openai-codex/gpt-6-luna", displayName: "Luna" },
            { value: "anthropic/claude-opus-5-5", displayName: "Opus" },
          ],
          normalized: { model: { value: "openai-codex/gpt-6-luna" } },
        },
      },
    });
    await page.goto("/");
    await expect(page.getByTestId("open-agent-tasks-view")).toBeVisible();
    const channelId = await seedDirectSession(page);
    await page.locator(`[data-channel-id="${channelId}"]`).first().click();

    const input = page.getByTestId("message-input");
    await input.click();
    await input.pressSequentially("/model");
    await page.getByTestId("send-message").click();

    const strip = page.getByTestId("composer-model-picker");
    await expect(strip).toContainText("Model for this conversation");
    const dispatched = (await commandLog(page)).filter(
      (call) =>
        call.command === "build_observer_control_event" &&
        JSON.stringify(call.payload).includes("dispatch_command"),
    );
    expect(dispatched).toEqual([]);

    await strip.getByRole("button", { name: /Luna/ }).click();
    await page.getByRole("menuitemradio", { name: "Opus" }).click();

    await expect
      .poll(async () =>
        (await commandLog(page))
          .filter((call) => call.command === "build_observer_control_event")
          .map((call) => JSON.stringify(call.payload)),
      )
      .toContainEqual(expect.stringContaining("set_session_config"));
    const control = (await commandLog(page)).find(
      (call) =>
        call.command === "build_observer_control_event" &&
        JSON.stringify(call.payload).includes("set_session_config"),
    );
    expect(JSON.stringify(control?.payload)).toContain(SESSION_ID);
    expect(JSON.stringify(control?.payload)).toContain(
      "anthropic/claude-opus-5-5",
    );
  });
});
