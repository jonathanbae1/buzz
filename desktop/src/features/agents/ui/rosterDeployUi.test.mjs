import assert from "node:assert/strict";
import test from "node:test";

import {
  canPreviewRosterDeployment,
  isRosterApplyDisabled,
  resolveRosterProfileAsNew,
  rosterCandidatesAvailableToEntry,
  updateRosterMapping,
} from "./rosterDeployUi.ts";

function plan({ applyBlocked = false, applyable = 1, teams = [] } = {}) {
  return { applyBlocked, counts: { applyable }, teams };
}

function rosterPlan() {
  const candidates = [
    { personaId: "persona-a", displayName: "Agent A", expectedDigest: "digest-a" },
  ];
  const entry = (name) => ({
    name,
    verdict: "unmapped",
    kind: "unmapped-unaccounted",
    via: null,
    personaId: null,
    personaDisplayName: null,
    currentSelector: null,
    message: "Choose an agent.",
    detail: null,
    candidates,
    rulePaths: [],
    pluginNames: [],
    modelLane: "anthropic/claude-opus-5-5:high",
    expectedDigest: null,
  });
  return {
    ambient: null,
    entries: [entry("reviewer"), entry("scout")],
    notInstalled: [],
    manualValue: [],
    teams: [
      {
        slug: "build",
        name: "Build",
        version: "1",
        verdict: "blocked",
        teamId: null,
        members: [
          { profile: "reviewer", personaId: null, displayName: null, message: "" },
          { profile: "scout", personaId: null, displayName: null, message: "" },
        ],
        message: "Needs profile mappings.",
        expectedDigest: null,
        memberProfiles: ["reviewer", "scout"],
      },
    ],
    sharedMembers: [],
    counts: {
      create: 0,
      adopt: 0,
      unchanged: 0,
      diverged: 0,
      unmapped: 2,
      conflict: 0,
      unavailable: 0,
      applyable: 0,
    },
    applyBlocked: true,
  };
}

test("apply is disabled before preview and while mutations are pending", () => {
  assert.equal(isRosterApplyDisabled(null, false), true);
  assert.equal(isRosterApplyDisabled(plan(), true), true);
});

test("apply uses the backend plan's blocked state and applyable count", () => {
  assert.equal(isRosterApplyDisabled(plan({ applyBlocked: true }), false), true);
  assert.equal(isRosterApplyDisabled(plan({ applyable: 0 }), false), true);
  assert.equal(isRosterApplyDisabled(plan(), false), false);
  assert.equal(
    isRosterApplyDisabled(
      plan({
        applyable: 0,
        teams: [{ verdict: "create" }],
      }),
      false,
    ),
    false,
  );
});

test("preview requires a settled configured catalogue and no pending mutation", () => {
  const configured = { state: "configured" };
  assert.equal(canPreviewRosterDeployment(undefined, false, false), false);
  assert.equal(canPreviewRosterDeployment(configured, true, false), false);
  assert.equal(canPreviewRosterDeployment(configured, false, true), false);
  assert.equal(canPreviewRosterDeployment(configured, false, false), true);
});

test("profile mappings stay unique, can be cleared, and resolve by creating", () => {
  const initial = rosterPlan();
  const [agentA] = initial.entries[0].candidates;

  const mappedReviewer = updateRosterMapping(initial, "reviewer", agentA);
  assert.equal(mappedReviewer.counts.adopt, 1);
  assert.equal(mappedReviewer.counts.unmapped, 1);
  assert.deepEqual(rosterCandidatesAvailableToEntry(mappedReviewer, "scout"), []);
  assert.strictEqual(
    updateRosterMapping(mappedReviewer, "scout", agentA),
    mappedReviewer,
  );
  const selectorClaimant = structuredClone(initial);
  selectorClaimant.entries[1].kind = "unmapped-claimants";
  assert.strictEqual(
    resolveRosterProfileAsNew(selectorClaimant, "scout"),
    selectorClaimant,
  );

  const createdScout = resolveRosterProfileAsNew(mappedReviewer, "scout");
  assert.equal(createdScout.counts.create, 1);
  assert.equal(createdScout.counts.adopt, 1);
  assert.equal(createdScout.counts.unmapped, 0);
  assert.equal(mappedReviewer.teams[0].verdict, "blocked");
  assert.equal(isRosterApplyDisabled(createdScout, false), false);

  assert.equal(createdScout.teams[0].verdict, "create");
  const cleared = updateRosterMapping(createdScout, "reviewer", null);
  assert.equal(cleared.counts.adopt, 0);
  assert.equal(cleared.counts.unmapped, 1);
  assert.equal(isRosterApplyDisabled(cleared, false), true);

  const remapped = updateRosterMapping(cleared, "reviewer", agentA);
  assert.equal(remapped.counts.create, 1);
  assert.equal(remapped.counts.adopt, 1);
  assert.equal(remapped.counts.unmapped, 0);
  assert.equal(isRosterApplyDisabled(remapped, false), false);
  assert.equal(remapped.teams[0].verdict, "create");
});
