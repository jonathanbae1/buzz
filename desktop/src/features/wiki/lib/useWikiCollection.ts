import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useCommunities } from "@/features/communities/useCommunities";
import {
  getProjectLocalRepoDocumentContent,
  getProjectLocalRepoFileContent,
  getProjectLocalRepoTrackedPaths,
  openProjectLocalRepoFile,
} from "@/shared/api/projectGit";
import type { WikiPage } from "@/features/wiki/lib/wikiModel";
import { WIKI_DIR, wikiPageNames } from "@/features/wiki/lib/wikiModel";

/**
 * The repository whose checkout holds the wiki.
 *
 * These are properties of the repository, not of this machine: the resolver
 * tries `<owner>--<repo>`, the dtag, and the bare repo name under every
 * configured repos root, so no absolute path appears here. The resolved root is
 * displayed in the pane header, which is what makes a wrong answer visible
 * instead of silent.
 */
const WIKI_PROJECT_DTAG = "oh-my-buzz";
const WIKI_CLONE_URL = "https://github.com/jonathanbae1/oh-my-buzz";

export type WikiCollection = {
  status: "loading" | "ready" | "error";
  /** Resolved checkout root, shown so a wrong root is visible. */
  root: string | null;
  error: string | null;
  pages: WikiPage[];
  /** Every tracked path in the checkout, used for artifact resolution. */
  trackedPaths: string[];
  isRefreshing: boolean;
};

/** The active community's configured checkout root, if any. */
export function useWikiReposDir(): { reposDir: string | null } {
  const { activeCommunity } = useCommunities();
  return { reposDir: activeCommunity?.reposDir ?? null };
}

function unavailableReasonFor(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function useWikiCollection(): WikiCollection & {
  refresh: () => void;
} {
  const { activeCommunity } = useCommunities();
  const reposDir = activeCommunity?.reposDir ?? null;
  const queryClient = useQueryClient();

  const listingQuery = useQuery({
    queryKey: ["wiki-tracked-paths", reposDir, WIKI_PROJECT_DTAG],
    queryFn: () =>
      getProjectLocalRepoTrackedPaths({
        reposDir,
        projectDtag: WIKI_PROJECT_DTAG,
        cloneUrl: WIKI_CLONE_URL,
        prefix: null,
      }),
    staleTime: 30_000,
    retry: 1,
  });

  const trackedPaths = React.useMemo(
    () => listingQuery.data?.paths ?? [],
    [listingQuery.data],
  );
  const pagePaths = React.useMemo(
    () => wikiPageNames(trackedPaths, `${WIKI_DIR}/`),
    [trackedPaths],
  );

  const pagesQuery = useQuery({
    queryKey: ["wiki-pages", reposDir, WIKI_PROJECT_DTAG, pagePaths.join("|")],
    enabled: pagePaths.length > 0,
    queryFn: async () => {
      const results = await Promise.all(
        pagePaths.map(async (path): Promise<WikiPage> => {
          const name = path.slice(WIKI_DIR.length + 1);
          try {
            const document = await getProjectLocalRepoDocumentContent({
              reposDir,
              projectDtag: WIKI_PROJECT_DTAG,
              cloneUrl: WIKI_CLONE_URL,
              path,
            });
            if (document.content === null) {
              return {
                path,
                name,
                state: "unavailable",
                content: null,
                unavailableReason: document.unavailableReason,
              };
            }
            return {
              path,
              name,
              state: "loaded",
              content: document.content,
              unavailableReason: null,
            };
          } catch (error) {
            return {
              path,
              name,
              state: "unavailable",
              content: null,
              unavailableReason: unavailableReasonFor(error),
            };
          }
        }),
      );
      return results;
    },
    staleTime: 30_000,
  });

  // Pages are listed as soon as the listing resolves, so the sidebar shows the
  // collection while content streams in — a page absent from the list would be
  // indistinguishable from "no such page".
  const pages = React.useMemo<WikiPage[]>(() => {
    if (pagesQuery.data) return pagesQuery.data;
    return pagePaths.map((path) => ({
      path,
      name: path.slice(WIKI_DIR.length + 1),
      state: "loading" as const,
      content: null,
      unavailableReason: null,
    }));
  }, [pagesQuery.data, pagePaths]);

  return {
    status: listingQuery.isError
      ? "error"
      : listingQuery.isLoading || (pagePaths.length > 0 && pagesQuery.isLoading)
        ? "loading"
        : "ready",
    root: listingQuery.data?.root ?? null,
    error: listingQuery.isError
      ? unavailableReasonFor(listingQuery.error)
      : null,
    pages,
    trackedPaths,
    isRefreshing: pagesQuery.isFetching || listingQuery.isFetching,
    refresh: () => {
      void queryClient.invalidateQueries({
        queryKey: ["wiki-tracked-paths", reposDir, WIKI_PROJECT_DTAG],
      });
      void queryClient.invalidateQueries({
        queryKey: ["wiki-pages", reposDir, WIKI_PROJECT_DTAG],
      });
    },
  };
}

/** Content of a root-confined artifact outside the collection. */
export function useWikiArtifact(
  path: string | null,
  reposDir: string | null | undefined,
) {
  const query = useQuery({
    queryKey: ["wiki-artifact", reposDir, path],
    enabled: Boolean(path),
    queryFn: () =>
      getProjectLocalRepoFileContent({
        reposDir: reposDir ?? null,
        projectDtag: WIKI_PROJECT_DTAG,
        cloneUrl: WIKI_CLONE_URL,
        path: path ?? "",
      }),
    staleTime: 30_000,
    retry: 1,
  });
  return {
    content: query.data ?? null,
    error: query.error ? unavailableReasonFor(query.error) : null,
    isLoading: query.isLoading,
  };
}

/** Open a root-confined artifact in the OS default editor. */
export async function openWikiArtifactInEditor(
  path: string,
  reposDir: string | null | undefined,
): Promise<void> {
  await openProjectLocalRepoFile({
    reposDir: reposDir ?? null,
    projectDtag: WIKI_PROJECT_DTAG,
    cloneUrl: WIKI_CLONE_URL,
    path,
  });
}
