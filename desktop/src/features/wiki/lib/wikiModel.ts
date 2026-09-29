/**
 * Wiki collection model.
 *
 * The wiki is a git-tracked, hand-curated collection of markdown pages
 * (`wiki/README.md`). This module owns everything that is *about the
 * collection* rather than about rendering: which tracked paths count as pages,
 * how a relative href resolves against the collection, how a citation resolves
 * against the checkout, and what a raw-substring search finds.
 *
 * Nothing here writes. The pane is a reader, and the collection's own rules
 * (superseded in place, provenance per claim) make an in-app editor a second
 * provenance authority rather than a convenience.
 */
import { parseProvenance } from "@/shared/lib/remarkProvenanceMarkers";

export type WikiPageState = "loading" | "loaded" | "unavailable";

export type WikiPage = {
  /** Path inside the checkout, e.g. `wiki/store.md`. */
  path: string;
  /** File name without the `wiki/` prefix, e.g. `store.md`. */
  name: string;
  state: WikiPageState;
  content: string | null;
  /** Why the page is unavailable, verbatim from the reader. */
  unavailableReason: string | null;
};

export type WikiLinkTarget =
  | { kind: "document"; href: string; heading?: string }
  | { kind: "artifact"; path: string }
  | { kind: "external"; href: string }
  | { kind: "unresolved" };

export const WIKI_DIR = "wiki";
export const WIKI_PAGE_EXTENSION = ".md";

/** Sort `README.md` first, then the rest alphabetically. */
export function sortWikiPages(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) => {
    const leftName = left.slice(WIKI_DIR.length + 1);
    const rightName = right.slice(WIKI_DIR.length + 1);
    if (leftName === "README.md") return -1;
    if (rightName === "README.md") return 1;
    return leftName.localeCompare(rightName);
  });
}

/** Page names from a full `git ls-files` listing of the collection. */
export function wikiPageNames(
  paths: readonly string[],
  prefix = `${WIKI_DIR}/`,
): string[] {
  return sortWikiPages(
    paths.filter(
      (path) =>
        path.startsWith(prefix) &&
        path.endsWith(WIKI_PAGE_EXTENSION) &&
        !path.slice(prefix.length).includes("/"),
    ),
  );
}

/**
 * Resolve one href from page content.
 *
 * The three classes are decided by resolution, not by directory: a relative
 * filesystem reference is not a URL, and being *outside* `wiki/` does not make
 * it externally resolvable. Determination wins over a directory check.
 */
export function resolveWikiLink(input: {
  href: string;
  /** Directory of the page doing the linking, e.g. `wiki`. */
  fromDir: string;
  /** Page paths in the collection, e.g. `wiki/store.md`. */
  pages: readonly string[];
  /** Every tracked path in the checkout, for artifact resolution. */
  trackedPaths: readonly string[];
}): WikiLinkTarget {
  const { href, fromDir, pages, trackedPaths } = input;
  if (/^https?:\/\//i.test(href)) return { kind: "external", href };
  // `buzz://` and other custom schemes are handled by the chat anchor path.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
    return { kind: "unresolved" };
  }
  // A bare fragment targets the page already open.
  if (href.startsWith("#")) {
    return { kind: "document", href: "", heading: href.slice(1) };
  }

  const [rawPath, rawHeading] = href.split("#");
  const heading = rawHeading && rawHeading.length > 0 ? rawHeading : undefined;
  const resolved = normalizeRelative(fromDir, rawPath);
  if (resolved === null) return { kind: "unresolved" };
  if (resolved.length === 0) {
    return heading
      ? { kind: "document", href: "", heading }
      : { kind: "unresolved" };
  }

  if (pages.includes(resolved)) {
    return { kind: "document", href: resolved, heading };
  }
  // Tracked but outside the collection: a root-confined artifact. Only files
  // the checkout actually tracks qualify, so a typo cannot mint a link.
  if (trackedPaths.includes(resolved))
    return { kind: "artifact", path: resolved };
  return { kind: "unresolved" };
}

/**
 * Join a relative href against a directory, refusing to climb past the
 * checkout root. Returns `null` for anything that escapes or is absolute.
 */
export function normalizeRelative(
  fromDir: string,
  href: string,
): string | null {
  if (href.startsWith("/")) return null;
  const segments = fromDir.length > 0 ? fromDir.split("/") : [];
  for (const segment of href.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** The directory a page lives in, e.g. `wiki` for `wiki/store.md`. */
export function pageDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export type CitationResolution =
  | { navigable: false }
  | { navigable: true; path: string; line?: number };

/**
 * Resolve a `(source: …)` citation to a tracked file.
 *
 * A repo-relative path is used only when the checkout tracks exactly that path.
 * A bare basename is resolved only when exactly one tracked file ends in it:
 * on zero or several matches the citation renders inert, because silently
 * opening one of two same-named files looks authoritative and is wrong. An
 * absolute path (e.g. `/Users/…/buzz/…`) is a different repository on a
 * different path per machine and is never navigable.
 */
export function resolveCitation(
  rawPath: string | undefined,
  line: number | undefined,
  trackedPaths: readonly string[],
): CitationResolution {
  if (!rawPath || rawPath.startsWith("/") || rawPath.startsWith("~")) {
    return { navigable: false };
  }
  if (trackedPaths.includes(rawPath)) {
    return { navigable: true, path: rawPath, line };
  }
  const suffix = `/${rawPath}`;
  const matches = trackedPaths.filter(
    (path) => path === rawPath || path.endsWith(suffix),
  );
  if (matches.length === 1) {
    return { navigable: true, path: matches[0], line };
  }
  return { navigable: false };
}

export type WikiSearchHit = {
  page: string;
  line: number;
  text: string;
};

/**
 * Raw substring scan of loaded markdown, including inside code spans and
 * fenced blocks.
 *
 * This exists because the renderer's `searchQuery` highlighting is token-based
 * and deliberately skips `code`/`pre`. A reader searching for an identifier
 * that appears only in backticks — which is a large share of the wiki's
 * substantive words — would otherwise get zero hits on the page that discusses
 * it. Two modes, stated, rather than one silent empty result.
 */
export function searchWikiCorpus(
  pages: readonly WikiPage[],
  query: string,
): WikiSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const hits: WikiSearchHit[] = [];
  for (const page of pages) {
    if (page.state !== "loaded" || page.content === null) continue;
    const lines = page.content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.toLowerCase().includes(needle)) {
        hits.push({
          page: page.path,
          line: index + 1,
          text: line.trim().slice(0, 160),
        });
      }
    }
  }
  return hits;
}

/** Count of `(source: …)`-style provenance markers in a page's raw content. */
export function countProvenanceMarkers(content: string): number {
  const matches = content.match(/\([^()\n]*\)/g) ?? [];
  return matches.filter((match) => parseProvenance(match) !== null).length;
}
