import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

/**
 * Private Tasks route (M1).
 *
 * Same shell pattern as `pulse`/`projects`: a top-level virtual route, a lazy view, and a
 * preview-feature warning while the surface is new.
 *
 * The pane deliberately takes no search params: it owns no auxiliary panel, and the
 * selection it shows is re-derived from a fresh store read rather than from the URL.
 */

const AgentTasksScreen = React.lazy(async () => {
  const module = await import("@/features/agent-tasks/ui/AgentTasksPane");
  return { default: module.AgentTasksPane };
});

export const Route = createFileRoute("/agent-tasks")({
  component: AgentTasksRouteComponent,
});

function AgentTasksRouteComponent() {
  usePreviewFeatureWarning("agentTasks");
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="tasks" />}>
      <AgentTasksScreen />
    </React.Suspense>
  );
}
