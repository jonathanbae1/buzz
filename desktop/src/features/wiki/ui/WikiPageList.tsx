import { cn } from "@/shared/lib/cn";
import type { WikiPage } from "@/features/wiki/lib/wikiModel";

/**
 * The collection's page list.
 *
 * Every page appears in one of three explicit states. An unavailable page is
 * listed *with its reason* rather than omitted, so a page that exists on disk
 * can never be mistaken for one that does not.
 */
export function WikiPageList({
  activePath,
  onSelect,
  pages,
}: {
  activePath: string | null;
  onSelect: (path: string) => void;
  pages: WikiPage[];
}) {
  return (
    <nav className="flex flex-col gap-0.5 p-2" data-testid="wiki-page-list">
      {pages.map((page) => {
        const isActive = page.path === activePath;
        return (
          <button
            className={cn(
              "flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              isActive
                ? "bg-sidebar-active/70 text-sidebar-active-foreground"
                : "hover:bg-sidebar-accent/60",
            )}
            data-page-state={page.state}
            data-testid={`wiki-page-${page.name}`}
            key={page.path}
            onClick={() => onSelect(page.path)}
            type="button"
          >
            <span className="font-medium">{page.name}</span>
            {page.state === "unavailable" ? (
              <span
                className="text-2xs text-muted-foreground"
                data-testid={`wiki-page-unavailable-${page.name}`}
                title={page.unavailableReason ?? undefined}
              >
                not covered by search — {page.unavailableReason}
              </span>
            ) : null}
            {page.state === "loading" ? (
              <span className="text-2xs text-muted-foreground">loading…</span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
