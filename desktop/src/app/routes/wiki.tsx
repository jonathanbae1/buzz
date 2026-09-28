import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const WikiScreen = React.lazy(async () => {
  // Code-splitting is the route-table convention (see routes/pulse.tsx): the
  // screen ships only when its route is visited, not with the app shell.
  const module = await import("@/features/wiki/ui/WikiScreen");
  return { default: module.WikiScreen };
});

type WikiRouteSearch = {
  page?: string;
};

function validateWikiSearch(search: Record<string, unknown>): WikiRouteSearch {
  return {
    page:
      typeof search.page === "string" && search.page.length > 0
        ? search.page
        : undefined,
  };
}

export const Route = createFileRoute("/wiki")({
  validateSearch: validateWikiSearch,
  component: WikiRouteComponent,
});

function WikiRouteComponent() {
  usePreviewFeatureWarning("wiki");
  return (
    <React.Suspense
      fallback={<ViewLoadingFallback includeHeader kind="projects" />}
    >
      <WikiScreen />
    </React.Suspense>
  );
}
