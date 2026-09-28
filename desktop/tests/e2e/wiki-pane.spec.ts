/**
 * Wiki pane — renderer acceptance (A1–A11).
 *
 * These checks prove renderer behaviour against a *mocked* checkout: they can
 * never establish that the shipped app finds the real one, which is why the
 * native checks (F1–F5) are separate and are not claimed here.
 */
import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const WIKI_PAGES: Record<string, string> = {
  "wiki/README.md": [
    "# The wiki",
    "",
    "Curated knowledge, organised by topic. (decision)",
    "",
    "- [`capture.md`](capture.md)",
    "- [`store.md`](store.md)",
  ].join("\n"),
  "wiki/capture.md": [
    "# Capture",
    "",
    "**Last verified: 2026-09-07** — a real turn.",
    "",
    "## How a turn becomes a record",
    "",
    "`livez` appears in prose too. (source: extensions/agentmemory-capture.ts:119)",
    "",
    "See [`store.md`](store.md) and [`role-profiles.md`](role-profiles.md#routing).",
  ].join("\n"),
  "wiki/store.md": [
    "# Store",
    "",
    "**Last verified: 2026-08-20** — the central store.",
    "",
    "## Durability",
    "",
    "The `livez` probe answers without touching the store. (measured 2026-09-02)",
  ].join("\n"),
  "wiki/role-profiles.md": [
    "# Role profiles",
    "",
    "**Last verified: 2026-09-07** — six profiles.",
    "",
    "## Routing",
    "",
    "| Role | Model |",
    "| --- | --- |",
    "| coder | Luna |",
    "| scout | Luna |",
    "",
    "## Routing",
    "",
    "A second heading that collapses to the same slug. (upstream #2528)",
    "",
    "## Ambiguity",
    "",
    "A bare basename with two matches stays inert: `agentmemory-capture.ts:87`.",
    "",
    "An absolute citation is never navigable: `(source: /Users/juwonbae/Documents/buzz/desktop/src-tauri/src/lib.rs:1)`.",
    "",
    "[`buzz-fork.json`](../buzz-fork.json)",
  ].join("\n"),
  "wiki/fork-and-build.md": [
    "# Fork and build",
    "",
    "**Acceptance completed: 2026-09-07.**",
    "",
    "```sh",
    "just desktop-standalone",
    "```",
    "",
    "```json",
    "{ \"a\": 1 }",
    "```",
    "",
    "```toml",
    "a = 1",
    "```",
  ].join("\n"),
  "wiki/plugins-and-skills.md": [
    "# Plugins and skills",
    "",
    "**Last verified: 2026-08-20** — profile-scoped.",
    "",
    "## Skill roots",
    "",
    "Three roots, three behaviours.",
  ].join("\n"),
  "wiki/buzz-launch.md": [
    "# Buzz launch",
    "",
    "**Acceptance verified: 2026-09-07, Buzz 0.5.23.**",
    "",
    "## Argv",
    "",
    "Discussed elsewhere.",
  ].join("\n"),
};

/** A checkout where 250+ files sort before `wiki/`, the A11 degraded corpus. */
const FILLER_FILES = Array.from({ length: 260 }, (_, index) => ({
  path: `aaa/placeholder-${String(index).padStart(3, "0")}.rs`,
  kind: "blob",
  size: 10,
  preview_content: null,
  last_changed_at: null,
  latest_commit: null,
}));

async function seedWikiCheckout(
  page: import("@playwright/test").Page,
  options: {
    documents?: Record<string, string | null>;
    trackedPaths?: string[];
    omitWikiContent?: boolean;
  } = {},
) {
  await page.addInitScript(
    ({ documents, trackedPaths, omitWikiContent, filler }) => {
      const wikiFiles = Object.keys(documents).map((path) => ({
        path,
        kind: "blob",
        size: 100,
        preview_content: null,
        last_changed_at: null,
        latest_commit: null,
      }));
      const files = [...filler, ...wikiFiles];
      window.__BUZZ_E2E_PROJECT_LOCAL_REPO_SNAPSHOT__ = {
        path: "/tmp/REPOS/oh-my-buzz",
        snapshot: {
          latest_commit: null,
          commits: [],
          contributors: [],
          files: omitWikiContent ? filler : files,
        },
      };
      if (trackedPaths) {
        window.__BUZZ_E2E_PROJECT_LOCAL_REPO_TRACKED_PATHS__ = {
          root: "/tmp/REPOS/oh-my-buzz",
          paths: trackedPaths,
        };
      }
      window.__BUZZ_E2E_PROJECT_LOCAL_REPO_DOCUMENTS__ = documents;
      // The artifact preview goes through the existing local content reader,
      // which is a separate seam from the reason-aware document reader.
      window.__BUZZ_E2E_PROJECT_REPO_FILE_CONTENTS__ = Object.fromEntries(
        Object.entries(documents),
      );
    },
    {
      documents: options.documents ?? WIKI_PAGES,
      trackedPaths: options.trackedPaths,
      omitWikiContent: options.omitWikiContent ?? false,
      filler: FILLER_FILES,
    },
  );
  await installMockBridge(page);
}

async function openWiki(page: import("@playwright/test").Page) {
  await page.goto("/");
  // The app shell boots slowly under the E2E bundle; wait for the sidebar
  // before clicking, so a slow boot is not read as a missing entry point.
  await expect(page.getByTestId("sidebar-primary-menu")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("open-wiki-view").click();
  await expect(page.getByTestId("wiki-screen")).toBeVisible();
}

test.describe.configure({ timeout: 60_000 });

test.describe("wiki pane", () => {
  test("A1 lists tracked pages README first and never an untracked scratch page", async ({
    page,
  }) => {
    await seedWikiCheckout(page, {
      // `git ls-files --cached` cannot list an untracked draft. The snapshot
      // DOES include one, so a page appearing here would prove the pane read
      // the wrong listing.
      trackedPaths: [...Object.keys(WIKI_PAGES), "wiki/scratch.md"],
      documents: {
        ...WIKI_PAGES,
        "wiki/scratch.md": "# Scratch\n\nUncurated draft.",
      },
    });
    await openWiki(page);

    const names = await page
      .getByTestId("wiki-page-list")
      .locator("button")
      .allInnerTexts();
    const pageNames = names.map((text) => text.split("\n")[0]);
    expect(pageNames[0]).toBe("README.md");
    expect(pageNames).toContain("store.md");
    expect(pageNames).toContain("capture.md");
    expect(pageNames).toContain("role-profiles.md");
    expect(pageNames).toContain("fork-and-build.md");
    expect(pageNames).toContain("plugins-and-skills.md");
    expect(pageNames).toContain("buzz-launch.md");
  });

  test("A2 renders tables and fenced blocks intact", async ({ page }) => {
    await seedWikiCheckout(page);
    await openWiki(page);

    await page.getByTestId("wiki-page-role-profiles.md").click();
    await expect(
      page.getByTestId("wiki-page-view-role-profiles.md"),
    ).toBeVisible();
    await expect(
      page.getByTestId("wiki-page-view-role-profiles.md").locator("table"),
    ).toHaveCount(1);

    await page.getByTestId("wiki-page-fork-and-build.md").click();
    await expect(
      page.getByTestId("wiki-page-view-fork-and-build.md"),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("wiki-page-view-fork-and-build.md")
        .locator("[data-code-block]"),
    ).toHaveCount(3);
  });

  test("A3 cross-page link navigates in-pane, including to a heading", async ({
    page,
  }) => {
    await seedWikiCheckout(page);
    await openWiki(page);

    await page.getByTestId("wiki-page-capture.md").click();
    await expect(page.getByTestId("wiki-page-view-capture.md")).toBeVisible();

    // Page + heading, from real wiki-style content.
    await page.locator('[data-document-link="wiki/role-profiles.md"]').click();
    await expect(
      page.getByTestId("wiki-page-view-role-profiles.md"),
    ).toBeVisible();

    // An empty-content link targets the current page.
    await page.getByTestId("wiki-page-store.md").click();
    await expect(page.getByTestId("wiki-page-view-store.md")).toBeVisible();
  });

  test("A4 renders all five provenance markers with the citation preserved", async ({
    page,
  }) => {
    await seedWikiCheckout(page, {
      documents: {
        "wiki/README.md": [
          "# Fixture",
          "",
          "**Last verified: 2026-09-28**",
          "",
          "Sourced. (source: extensions/agentmemory-capture.ts:119)",
          "",
          "Measured. (measured 2026-09-02)",
          "",
          "Chosen. (decision)",
          "",
          "Reported. (upstream #2528)",
          "",
          "Recorded. (captured mem_mts8zbgi_106889bffc9a)",
        ].join("\n"),
      },
      trackedPaths: ["wiki/README.md"],
    });
    await openWiki(page);

    const view = page.getByTestId("wiki-page-view-README.md");
    for (const kind of [
      "source",
      "measured",
      "decision",
      "upstream",
      "captured",
    ]) {
      await expect(view.locator(`[data-provenance-marker="${kind}"]`)).toHaveCount(
        1,
      );
    }
    // The full original citation is preserved on the chip, not rewritten.
    await expect(
      view.locator('[data-provenance-marker="source"]'),
    ).toHaveAttribute(
      "title",
      "(source: extensions/agentmemory-capture.ts:119)",
    );
  });

  test("A5 citation resolution: repo-relative navigates, ambiguity and absolute paths stay inert", async ({
    page,
  }) => {
    await seedWikiCheckout(page, {
      documents: {
        "wiki/README.md": [
          "# Citations",
          "",
          "**Last verified: 2026-09-28**",
          "",
          "Unique. (source: profiles/routing.conf:33)",
          "",
          "Ambiguous. (source: agentmemory-capture.ts:87)",
          "",
          "Absolute. (source: /Users/juwonbae/Documents/buzz/desktop/src-tauri/src/lib.rs:1)",
        ].join("\n"),
      },
      trackedPaths: [
        "wiki/README.md",
        "profiles/routing.conf",
        "extensions/agentmemory-capture.ts",
        "crates/agentmemory-capture.ts",
      ],
    });
    await openWiki(page);

    const view = page.getByTestId("wiki-page-view-README.md");
    // One unique match → a real control.
    await expect(
      view.locator('[data-provenance-marker="source"]').first(),
    ).toHaveJSProperty("tagName", "BUTTON");
    // Two matches for the bare basename, and an absolute path: both inert, but
    // still showing the citation verbatim.
    const inert = view.locator('span[data-provenance-marker="source"]');
    await expect(inert).toHaveCount(2);
    await expect(inert.first()).toContainText("agentmemory-capture.ts");
  });

  test("A6 search covers prose, and the code-inclusive mode finds backticked identifiers", async ({
    page,
  }) => {
    await seedWikiCheckout(page);
    await openWiki(page);

    await page.getByTestId("wiki-page-store.md").click();
    await page.getByTestId("wiki-search").fill("livez");

    // Mode 1 skips code spans by design, so the backticked `livez` is not
    // highlighted. This is the deliberate two-mode search, not a silent miss.
    await page.waitForTimeout(400);
    await expect(page.locator("mark")).toHaveCount(0);

    await page.getByTestId("wiki-search-code-toggle").check();
    await expect(page.getByTestId("wiki-code-results")).toBeVisible();
    await expect(page.getByTestId("wiki-code-results")).toContainText(
      "wiki/store.md:",
    );
  });

  test("A7 the aging indicator matches the page's own declaration", async ({
    page,
  }) => {
    await seedWikiCheckout(page);
    await openWiki(page);

    await page.getByTestId("wiki-page-store.md").click();
    await expect(page.getByTestId("wiki-verified-at")).toContainText(
      "2026-08-20",
    );

    await page.getByTestId("wiki-page-capture.md").click();
    await expect(page.getByTestId("wiki-verified-at")).toContainText(
      "2026-09-07",
    );
  });

  test("A8 the pane issues no write command", async ({ page }) => {
    await seedWikiCheckout(page);
    await openWiki(page);
    await page.getByTestId("wiki-page-capture.md").click();
    await expect(page.getByTestId("wiki-page-view-capture.md")).toBeVisible();

    const commands = await page.evaluate(() => window.__BUZZ_E2E_COMMANDS__ ?? []);
    // Named exactly: every registered verb that would mutate the checkout. A
    // substring sweep would also match unrelated boot commands (`create_auth_event`),
    // which is a false positive, not a finding.
    const writeCommands = [
      "clone_project_repository",
      "create_project_remote_branch",
      "delete_project_remote_branch",
      "push_project_local_repository",
      "pull_project_local_repository",
      "stage_project_local_repository",
      "commit_project_local_repository",
    ];
    expect(commands.filter((command) => writeCommands.includes(command))).toEqual(
      [],
    );
    expect(commands).toContain("get_project_local_repo_tracked_paths");
    // The read path the pane actually uses.
    expect(commands).toContain("get_project_local_repo_document_content");
  });

  test("A9 wiki content comes only from the checkout, and pane chrome carries no record vocabulary", async ({
    page,
  }) => {
    await seedWikiCheckout(page, {
      documents: {
        "wiki/README.md": [
          "# Fixture",
          "",
          "**Last verified: 2026-09-28**",
          "",
          "Cites a record without merging planes. (captured mem_mts8zbgi_106889bffc9a)",
        ].join("\n"),
      },
      trackedPaths: ["wiki/README.md"],
    });
    await openWiki(page);

    // The source citation renders intact — the plane rule does not censor
    // legitimate curated content.
    await expect(
      page.locator('[data-provenance-marker="captured"]'),
    ).toContainText("mem_mts8zbgi");

    // No sync command in either direction is ever issued from this pane.
    // No bridge between the wiki and either memory plane exists in either
    // direction: neither the engram reads nor any agentmemory call is issued.
    const commands = await page.evaluate(() => window.__BUZZ_E2E_COMMANDS__ ?? []);
    expect(
      commands.filter((command) => /engram|agentmemory/i.test(command)),
    ).toEqual([]);

    // Pane-owned chrome says "Last verified", never "Last captured".
    const chrome = await page.getByTestId("wiki-screen").innerText();
    expect(chrome).toContain("Last verified");
    expect(chrome).not.toContain("Last captured");
  });

  test("A10 root-confined artifact link, both interactions", async ({ page }) => {
    await seedWikiCheckout(page, {
      documents: {
        ...WIKI_PAGES,
        "buzz-fork.json": '{ "commit": "f0a443eba" }',
      },
      trackedPaths: [...Object.keys(WIKI_PAGES), "buzz-fork.json"],
    });
    await openWiki(page);

    await page.getByTestId("wiki-page-role-profiles.md").click();
    const link = page.locator('[data-document-artifact="buzz-fork.json"]');
    await expect(link).toBeVisible();

    // Left click: opened through the local content reader in a side preview.
    await link.click();
    await expect(page.getByTestId("wiki-artifact-preview")).toBeVisible();
    await expect(page.getByTestId("wiki-artifact-content")).toContainText(
      "f0a443eba",
    );

    // Context menu → Open in editor: the second, distinct interaction.
    await link.click({ button: "right" });
    const menu = page.locator("[data-document-artifact-context-menu]");
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: "Open in editor" }).click();
  });

  test("A11 every page becomes searchable past the 250-file eager limit, and an oversized page is labelled", async ({
    page,
  }) => {
    const documents: Record<string, string | null> = { ...WIKI_PAGES };
    // One page over the reader's 64 KiB ceiling: honestly unsupported, and
    // labelled as not covered by search rather than silently absent.
    documents["wiki/store.md"] = null;
    await seedWikiCheckout(page, {
      documents,
      trackedPaths: Object.keys(WIKI_PAGES),
    });
    await openWiki(page);

    // Content is fetched per page, so the 260 filler files cannot starve it.
    await page.getByTestId("wiki-page-capture.md").click();
    await expect(page.getByTestId("wiki-page-view-capture.md")).toBeVisible();

    await expect(
      page.getByTestId("wiki-page-unavailable-store.md"),
    ).toContainText("not covered by search");

    await page.getByTestId("wiki-page-store.md").click();
    await expect(page.getByTestId("wiki-page-unavailable")).toContainText(
      "not covered by search",
    );
  });
});
