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
  __BUZZ_E2E_SEED_OBSERVER_EVENTS__?: (input: {
    agentPubkey: string;
    events: Array<Record<string, unknown>>;
  }) => void;
  __BUZZ_E2E_COMMANDS__?: string[];
  __BUZZ_E2E_COMMAND_LOG__?: Array<{ command: string; payload: unknown }>;
};

const WORKER = "d".repeat(64);
const ACTION_ID = "act-e2e-run";
const SESSION_ID = "session-e2e-run";

function taskRow(assignmentTarget: string | null) {
  return {
    id: ACTION_ID,
    title: "Run this task",
    description: "Exercise the routed direct-message path.",
    status: "pending",
    priority: 5,
    project: "oh-my-buzz",
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assignedTo: null,
    assignmentTarget,
    assignmentRevision: 1,
    dispatch: null,
    leaseLive: false,
    leaseId: null,
    leaseAgent: null,
    leaseExpiresAt: null,
    lastAttempt: null,
    blockers: [],
    readiness: assignmentTarget ? "ready" : "unassigned",
    reasons: [],
    result: null,
  };
}

async function openTasks(page: Page) {
  if (page.url() === "about:blank") await page.goto("/");
  const tasksButton = page.getByTestId("open-agent-tasks-view");
  await expect(tasksButton).toBeVisible();
  await tasksButton.click();
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
}
async function observedCommands(page: Page) {
  return page.evaluate(() => {
    const state = window as TestWindow;
    return state.__BUZZ_E2E_COMMANDS__ ?? [];
  });
}

async function seedDirectSession(page: Page) {
  return page.evaluate(
    async ({ worker, session }) => {
      const state = window as TestWindow;
      const invoke = state.__TAURI_INTERNALS__?.invoke;
      if (!invoke) throw new Error("Mock Tauri invoke bridge is unavailable.");
      const rawChannel = await invoke("open_dm", { pubkeys: [worker] });
      if (
        rawChannel === null ||
        typeof rawChannel !== "object" ||
        !("id" in rawChannel) ||
        typeof rawChannel.id !== "string"
      ) {
        throw new Error("Mock direct-message creation returned no channel id.");
      }
      const channelId = rawChannel.id;
      state.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey: worker,
        events: [
          {
            seq: 1,
            timestamp: new Date().toISOString(),
            kind: "session_start",
            agentIndex: null,
            channelId,
            sessionId: session,
            turnId: null,
            payload: {},
          },
        ],
      });
      await state.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
        queryKey: ["channels"],
      });
      return channelId;
    },
    { worker: WORKER, session: SESSION_ID },
  );
}

test.describe("Tasks Run", () => {
  test("refuses an unassigned action before registering or sending", async ({
    page,
  }) => {
    await installMockBridge(page, {
      agentTasks: {
        contract: "agentmemory-m1.1",
        managedAvailable: true,
        tasks: [taskRow(null)],
      },
    });
    await openTasks(page);

    await page.getByRole("button", { name: "Run", exact: true }).click();

    await expect(
      page.getByText(
        "Run refused: assign this action to a managed agent first.",
      ),
    ).toBeVisible();
    const commands = await observedCommands(page);
    expect(commands).not.toContain("agent_tasks_register_dispatch");
    expect(commands).not.toContain("send_channel_message");
  });

  test("refuses an unavailable managed agent before dispatch", async ({
    page,
  }) => {
    await installMockBridge(page, {
      agentTasks: {
        contract: "agentmemory-m1.1",
        managedAvailable: true,
        tasks: [taskRow(`buzz:${WORKER}`)],
      },
    });
    await openTasks(page);
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(
      page.getByText("Run refused: the assigned managed agent is unavailable."),
    ).toBeVisible();
    expect(await observedCommands(page)).not.toContain(
      "agent_tasks_register_dispatch",
    );
  });

  test("refuses an incompatible task contract before dispatch", async ({
    page,
  }) => {
    await installMockBridge(page, {
      managedAgents: [{ pubkey: WORKER, name: "Coder", status: "running" }],
      agentTasks: {
        contract: null,
        managedAvailable: false,
        tasks: [taskRow(`buzz:${WORKER}`)],
      },
    });
    await openTasks(page);
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(
      page.getByText(
        "Run refused: the compatible agentmemory-m1.1 task contract is unavailable.",
      ),
    ).toBeVisible();
    expect(await observedCommands(page)).not.toContain(
      "agent_tasks_register_dispatch",
    );
  });

  test("registers then sends the ordinary routed prompt to the assigned direct session", async ({
    page,
  }) => {
    await installMockBridge(page, {
      managedAgents: [{ pubkey: WORKER, name: "Coder", status: "running" }],
      agentTasks: {
        contract: "agentmemory-m1.1",
        managedAvailable: true,
        tasks: [taskRow(`buzz:${WORKER}`)],
      },
    });
    await page.goto("/");
    await expect(page.getByTestId("open-agent-tasks-view")).toBeVisible();
    const channelId = await seedDirectSession(page);
    await openTasks(page);
    await page.getByRole("button", { name: "Run", exact: true }).click();

    await expect(page.getByText(/Run sent to Coder\. Request/)).toBeVisible();
    await expect(page.getByText(/session session-e2e-run/)).toBeVisible();
    const calls = await page.evaluate(() => {
      const state = window as TestWindow;
      return state.__BUZZ_E2E_COMMAND_LOG__ ?? [];
    });
    const registerIndex = calls.findIndex(
      (call) => call.command === "agent_tasks_register_dispatch",
    );
    const sendIndex = calls.findIndex(
      (call) => call.command === "send_channel_message",
    );
    expect(registerIndex).toBeGreaterThanOrEqual(0);
    expect(sendIndex).toBeGreaterThan(registerIndex);
    const payload = calls[sendIndex]?.payload;
    if (
      payload === null ||
      typeof payload !== "object" ||
      !("channelId" in payload) ||
      !("content" in payload) ||
      typeof payload.channelId !== "string" ||
      typeof payload.content !== "string"
    ) {
      throw new Error(
        "Sent direct message was missing its channel id or prompt.",
      );
    }
    expect(payload.channelId).toBe(channelId);
    expect(payload.content).toMatch(new RegExp(`^M1W ${ACTION_ID} `));
    expect(payload.content).toContain("Run this task");
  });
});
