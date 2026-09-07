import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAgentSessionCommandTerminalNotice,
  getAgentSessionCommandTerminalStatus,
  isAgentSessionCommandTerminalFrame,
} from "./commandOutcome.ts";

const frame = (status, overrides = {}) => ({
  type: "dispatch_command",
  requestId: "request-1",
  sessionId: "session-1",
  status,
  ...overrides,
});

test("sent is acceptance, not a terminal command outcome", () => {
  assert.equal(
    isAgentSessionCommandTerminalFrame(
      frame("sent"),
      "request-1",
      "session-1",
    ),
    false,
  );
  assert.equal(getAgentSessionCommandTerminalStatus(frame("sent")), null);
});

test("terminal outcomes require the exact request and session", () => {
  assert.equal(
    isAgentSessionCommandTerminalFrame(
      frame("completed"),
      "request-1",
      "session-1",
    ),
    true,
  );
  assert.equal(
    isAgentSessionCommandTerminalFrame(
      frame("completed", { sessionId: "other-session" }),
      "request-1",
      "session-1",
    ),
    false,
  );
  assert.equal(
    isAgentSessionCommandTerminalFrame(
      frame("runtime_error"),
      "old-request",
      "session-1",
    ),
    false,
  );
});

test("terminal notices describe publication disposition without fabricating text", () => {
  assert.match(
    formatAgentSessionCommandTerminalNotice(
      frame("completed", { outputDisposition: "published" }),
    ),
    /reply is in this conversation/,
  );
  assert.match(
    formatAgentSessionCommandTerminalNotice(
      frame("completed", { outputDisposition: "empty" }),
    ),
    /without chat output/,
  );
  assert.match(
    formatAgentSessionCommandTerminalNotice(
      frame("runtime_error", { error: "session closed" }),
    ),
    /session closed/,
  );
});
