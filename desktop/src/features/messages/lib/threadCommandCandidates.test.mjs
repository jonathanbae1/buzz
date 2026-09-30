import assert from "node:assert/strict";
import test from "node:test";

import {
  threadCommandCandidates,
  threadScopeRefusal,
} from "./threadCommandCandidates.ts";

const HUMAN = "a".repeat(64);
const SCOUT = "b".repeat(64);
const CODER = "c".repeat(64);
const KNOWN = new Set([SCOUT, CODER]);

test("a thread whose head mentions one agent addresses that agent", () => {
  const head = { pubkey: HUMAN, tags: [["p", SCOUT.toUpperCase()]] };
  assert.deepEqual(threadCommandCandidates(head, [], KNOWN), [SCOUT]);
});

test("an agent that only replied is addressed; humans and unknown keys are not", () => {
  const head = {
    pubkey: HUMAN,
    tags: [
      ["p", HUMAN],
      ["e", SCOUT],
    ],
  };
  const replies = [
    { pubkey: SCOUT },
    { pubkey: HUMAN },
    { pubkey: "d".repeat(64) },
  ];
  assert.deepEqual(threadCommandCandidates(head, replies, KNOWN), [SCOUT]);
});

test("two agents in one thread stay ambiguous", () => {
  const head = { pubkey: CODER, tags: [] };
  const replies = [{ pubkey: SCOUT }, { pubkey: CODER }];
  assert.deepEqual(
    threadCommandCandidates(head, replies, KNOWN).sort(),
    [SCOUT, CODER].sort(),
  );
});

test("thread-scoped sessions refuse commands in channel threads instead of guessing a session", () => {
  // Two threads in one channel with the same agent run two sessions; observer
  // events carry no thread root, so neither may be picked by channel alone.
  const refusal = threadScopeRefusal("stream", true);
  assert.equal(refusal.sessionId, null);
  assert.match(refusal.unresolvedScopeReason, /thread-scoped/);
});

test("DMs and the default channel policy keep resolving by channel", () => {
  assert.deepEqual(threadScopeRefusal("dm", true), {});
  assert.deepEqual(threadScopeRefusal("stream", false), {});
});
