import * as React from "react";
import { RefreshCw, Search } from "lucide-react";

import {
  openWikiArtifactInEditor,
  useWikiCollection,
  useWikiReposDir,
} from "@/features/wiki/lib/useWikiCollection";
import {
  ageInDays,
  declaredVerifiedAt,
} from "@/shared/lib/remarkProvenanceMarkers";
import {
  type CitationResolution,
  type WikiLinkTarget,
  pageDirectory,
  resolveCitation,
  resolveWikiLink,
  searchWikiCorpus,
  WIKI_DIR,
  type WikiPage,
} from "@/features/wiki/lib/wikiModel";
import { WikiPageList } from "@/features/wiki/ui/WikiPageList";
import { WikiArtifactPreview } from "@/features/wiki/ui/WikiArtifactPreview";
import { Markdown } from "@/shared/ui/markdown";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

/**
 * Read-only wiki viewer.
 *
 * A destination rather than a glance-beside-a-conversation panel: pages are long,
 * tables are wide, and both navigation and search want the full width. The pane
 * never writes — the collection is git-tracked and hand-curated, and a write
 * from here would be a second provenance authority with no honest commit path.
 */
export function WikiScreen() {
  const collection = useWikiCollection();
  const { reposDir } = useWikiReposDir();
  const [activePath, setActivePath] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [includeCode, setIncludeCode] = React.useState(false);
  const [debouncedQuery, setDebouncedQuery] = React.useState("");
  const [artifactPath, setArtifactPath] = React.useState<string | null>(null);
  const [pendingHeading, setPendingHeading] = React.useState<string | null>(
    null,
  );
  const [missingHeading, setMissingHeading] = React.useState<string | null>(
    null,
  );
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  // Keystroke-rate parsing is wasteful: a query bypasses the parse cache by
  // design. The largest wiki page parses in ~19 ms, so 150 ms is comfortably
  // responsive while collapsing a burst of keystrokes into one parse.
  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 150);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Default to README.md: `git ls-files` sorts by path and the collection's own
  // listing leads with it, so the pane opens where the collection says to start.
  React.useEffect(() => {
    if (activePath !== null) return;
    const first = collection.pages[0];
    if (first) setActivePath(first.path);
  }, [activePath, collection.pages]);

  const activePage = React.useMemo(
    () => collection.pages.find((page) => page.path === activePath) ?? null,
    [activePath, collection.pages],
  );
  const pageDirectoryOfActive = activePage
    ? pageDirectory(activePage.path)
    : WIKI_DIR;

  const handleNavigate = React.useCallback((path: string, heading?: string) => {
    setActivePath(path);
    setPendingHeading(heading ?? null);
    setMissingHeading(null);
  }, []);

  const resolveLink = React.useCallback(
    (href: string): WikiLinkTarget =>
      resolveWikiLink({
        href,
        fromDir: pageDirectoryOfActive,
        pages: collection.pages.map((page) => page.path),
        trackedPaths: collection.trackedPaths,
      }),
    [collection.pages, collection.trackedPaths, pageDirectoryOfActive],
  );

  const handleOpenCitation = React.useCallback(
    (path: string, line?: number) => {
      // A citation showing `path:12` is a line-level reference into the artifact
      // preview; `line` orients the preview and is never dropped.
      setArtifactPath(path);
      setPendingHeading(line === undefined ? null : `L${line}`);
    },
    [],
  );

  const handleOpenArtifact = React.useCallback(
    (path: string, action: "preview" | "editor") => {
      if (action === "editor") {
        void openWikiArtifactInEditor(path, reposDir).catch(() => undefined);
        return;
      }
      setArtifactPath(path);
    },
    [reposDir],
  );

  // Scroll to a heading once the page that owns it has rendered. A heading that
  // matches nothing leaves the top visible and says so, rather than scrolling
  // nowhere in silence.
  React.useEffect(() => {
    if (!pendingHeading || !activePage || activePage.state !== "loaded") return;
    const container = contentRef.current;
    if (!container) return;
    if (pendingHeading.startsWith("L")) {
      setPendingHeading(null);
      return;
    }
    const target = container.querySelector(
      `[id="${CSS.escape(pendingHeading)}"]`,
    );
    if (target) target.scrollIntoView({ block: "start" });
    else setMissingHeading(pendingHeading);
    setPendingHeading(null);
  }, [pendingHeading, activePage]);

  const results = React.useMemo(
    () =>
      includeCode ? searchWikiCorpus(collection.pages, debouncedQuery) : [],
    [collection.pages, debouncedQuery, includeCode],
  );

  const loadedCount = collection.pages.filter(
    (page) => page.state === "loaded",
  ).length;
  const isLoading = collection.status === "loading";

  if (collection.status === "error") {
    return (
      <WikiSetupState
        detail={collection.error}
        onRetry={collection.refresh}
        root={collection.root}
      />
    );
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="wiki-screen"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="text-base font-semibold tracking-tight">Wiki</h1>
          <span
            className="truncate font-mono text-2xs text-muted-foreground"
            data-testid="wiki-root"
            title={collection.root ?? undefined}
          >
            {collection.root ?? "checkout not resolved"}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 pl-7 text-sm"
              data-testid="wiki-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search pages…"
              value={query}
            />
          </div>
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <input
              checked={includeCode}
              data-testid="wiki-search-code-toggle"
              onChange={(event) => setIncludeCode(event.target.checked)}
              type="checkbox"
            />
            match in code too
          </label>
        </div>
        <span
          className="shrink-0 text-2xs text-muted-foreground"
          data-testid="wiki-index-status"
        >
          {isLoading
            ? `indexing ${loadedCount} of ${collection.pages.length}`
            : `${loadedCount} of ${collection.pages.length} pages searchable`}
        </span>
        <Button
          aria-label="Refresh wiki pages"
          className="h-8 w-8 shrink-0"
          data-testid="wiki-refresh"
          disabled={collection.isRefreshing}
          onClick={collection.refresh}
          size="icon"
          variant="ghost"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </header>

      {includeCode && debouncedQuery.trim().length > 0 ? (
        <div
          className="max-h-48 shrink-0 overflow-auto border-b border-border/60 bg-muted/30 px-4 py-2"
          data-search-mode="code"
          data-testid="wiki-code-results"
        >
          <p className="pb-1 text-2xs text-muted-foreground">
            {results.length} line{results.length === 1 ? "" : "s"} across loaded
            pages, including code spans and fenced blocks.
          </p>
          {results.slice(0, 200).map((hit) => (
            <button
              className="block w-full truncate text-left font-mono text-2xs hover:underline"
              key={`${hit.page}:${hit.line}`}
              onClick={() => handleNavigate(hit.page, `L${hit.line}`)}
              type="button"
            >
              {hit.page}:{hit.line} — {hit.text}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <aside className="w-56 shrink-0 overflow-auto border-r border-border/60">
          <WikiPageList
            activePath={activePath}
            onSelect={handleNavigate}
            pages={collection.pages}
          />
        </aside>
        <main className="min-w-0 flex-1 overflow-auto" ref={contentRef}>
          {activePage ? (
            <WikiPageView
              missingHeading={missingHeading}
              onNavigate={handleNavigate}
              onOpenArtifact={handleOpenArtifact}
              onOpenCitation={handleOpenCitation}
              page={activePage}
              resolveCitation={(path, line) =>
                resolveCitation(path, line, collection.trackedPaths)
              }
              resolveLink={resolveLink}
              searchQuery={includeCode ? "" : debouncedQuery}
            />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              No pages are tracked in this checkout&apos;s wiki collection.
            </p>
          )}
        </main>
        {artifactPath ? (
          <WikiArtifactPreview
            onClose={() => setArtifactPath(null)}
            path={artifactPath}
          />
        ) : null}
      </div>
    </div>
  );
}

function WikiPageView({
  missingHeading,
  onNavigate,
  onOpenArtifact,
  onOpenCitation,
  page,
  resolveCitation,
  resolveLink,
  searchQuery,
}: {
  missingHeading: string | null;
  onNavigate: (path: string, heading?: string) => void;
  onOpenArtifact: (path: string, action: "preview" | "editor") => void;
  onOpenCitation: (path: string, line?: number) => void;
  page: WikiPage;
  resolveCitation: (
    path: string | undefined,
    line?: number,
  ) => CitationResolution;
  resolveLink: (href: string) => WikiLinkTarget;
  searchQuery: string;
}) {
  const verifiedAt = React.useMemo(
    () => (page.content ? declaredVerifiedAt(page.content) : null),
    [page.content],
  );
  const age = verifiedAt ? ageInDays(verifiedAt) : null;

  const documentLinkPolicy = React.useCallback(
    (href: string): WikiLinkTarget => resolveLink(href),
    [resolveLink],
  );

  return (
    <article
      className="mx-auto max-w-3xl px-6 py-5"
      data-testid={`wiki-page-view-${page.name}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 pb-3">
        <h2 className="text-xl font-semibold tracking-tight">{page.name}</h2>
        {verifiedAt ? (
          <span
            className="text-2xs text-muted-foreground"
            data-testid="wiki-verified-at"
            title={`Declared in the page, not derived from git history`}
          >
            Last verified {verifiedAt}
            {age !== null ? ` · ${age} days ago` : ""}
          </span>
        ) : null}
      </div>

      {missingHeading ? (
        <p
          className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-warning"
          data-testid="wiki-missing-heading"
        >
          No heading on this page matches <code>{missingHeading}</code>.
        </p>
      ) : null}

      {page.state === "unavailable" ? (
        <p
          className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-warning"
          data-testid="wiki-page-unavailable"
        >
          This page is not covered by search: {page.unavailableReason}
        </p>
      ) : page.content === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <Markdown
          blockCode
          className="text-sm"
          content={page.content}
          documentLinkPolicy={documentLinkPolicy}
          documentSurface
          hardLineBreaks={false}
          interactive
          onOpenDocumentArtifact={onOpenArtifact}
          onOpenDocumentLink={(href) => {
            if (href.length === 0) return;
            onNavigate(href);
          }}
          onOpenSourceCitation={onOpenCitation}
          resolveSourceCitation={resolveCitation}
          searchQuery={searchQuery}
        />
      )}
    </article>
  );
}

function WikiSetupState({
  detail,
  onRetry,
  root,
}: {
  detail: string | null;
  onRetry: () => void;
  root: string | null;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-start gap-3 p-6"
      data-testid="wiki-setup-state"
    >
      <h1 className="text-base font-semibold tracking-tight">Wiki</h1>
      <p className="max-w-2xl text-sm text-muted-foreground">
        No local checkout answered for <code>oh-my-buzz</code>. The resolver
        looks under the community&apos;s configured <code>reposDir</code>, and
        otherwise under the managed nest&apos;s <code>REPOS</code> and{" "}
        <code>~/.buzz/REPOS</code>.
      </p>
      {detail ? (
        <p className="max-w-2xl font-mono text-xs text-destructive">{detail}</p>
      ) : null}
      {root ? (
        <p className="font-mono text-2xs text-muted-foreground">{root}</p>
      ) : null}
      <Button onClick={onRetry} size="sm" variant="outline">
        Retry
      </Button>
    </div>
  );
}
