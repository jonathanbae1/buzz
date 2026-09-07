import assert from "node:assert/strict";
import test from "node:test";

import {
  filterAgentSessionCommands,
  normalizeCommandName,
  parseLeadingCommand,
} from "./useComposerCommandPicker.ts";
import { normalizeAvailableCommands } from "@/features/agents/ui/agentSessionCommandCatalog";

test("leading command parsing preserves argument text for exact dispatch", () => {
  assert.deepEqual(parseLeadingCommand("/quick --profile coder"), {
    name: "quick",
    arguments: "--profile coder",
  });
  assert.deepEqual(parseLeadingCommand("/skill\ninspect this"), {
    name: "skill",
    arguments: "inspect this",
  });
});

test("ordinary slash text and URLs are not command drafts", () => {
  assert.equal(parseLeadingCommand("See /quick in the docs"), null);
  assert.equal(parseLeadingCommand("https://example.test/path"), null);
  assert.equal(parseLeadingCommand("/"), null);
});

test("command filtering uses advertised names without synthesizing entries", () => {
  const commands = [
    { name: "quick", description: "Fast pass" },
    { name: "/orchestrator", description: "Delegated pass" },
    { name: "skill:inspect", description: "Advertised skill" },
  ];
  assert.deepEqual(
    filterAgentSessionCommands(commands, "skill"),
    [commands[2]],
  );
  assert.equal(normalizeCommandName("/ORCHESTRATOR"), "orchestrator");
});

test("leading generated mention prefixes are preserved while parsing commands", () => {
  assert.deepEqual(
    parseLeadingCommand("@Agent ", "@Agent "),
    null,
  );
  assert.deepEqual(
    parseLeadingCommand("@Agent /quick hello", "@Agent "),
    { name: "quick", arguments: "hello" },
  );
});

test("command metadata carries declarative subcommands into the picker", () => {
  assert.deepEqual(
    normalizeAvailableCommands([
      {
        name: "orchestrator",
        description: "Workflow control",
        input: { type: "string" },
        _meta: {
          "dev.ohmybuzz/subcommands": [
            { name: "on", description: "Enable" },
            { name: "off", description: "Disable", usage: "/orchestrator off" },
          ],
        },
      },
    ]),
    [
      {
        name: "orchestrator",
        description: "Workflow control",
        inputSchema: { type: "string" },
        subcommands: [
          { name: "on", description: "Enable" },
          { name: "off", description: "Disable", usage: "/orchestrator off" },
        ],
      },
    ],
  );
});
