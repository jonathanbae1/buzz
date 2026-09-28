import * as React from "react";
import { ExternalLink, X } from "lucide-react";

import {
  openWikiArtifactInEditor,
  useWikiArtifact,
  useWikiReposDir,
} from "@/features/wiki/lib/useWikiCollection";
import { Button } from "@/shared/ui/button";

/**
 * A root-confined artifact from outside the wiki collection — e.g. the wiki
 * citing `../buzz-fork.json` or a `docs/…` page.
 *
 * The content comes through the same local content reader the Projects file
 * viewer uses, and *Open in editor* goes through the root-confined opener
 * command. The pane never pretends such a path is a URL.
 */
export function WikiArtifactPreview({
  onClose,
  path,
}: {
  onClose: () => void;
  path: string;
}) {
  const { reposDir } = useWikiReposDir();
  const artifact = useWikiArtifact(path, reposDir);
  const [editorError, setEditorError] = React.useState<string | null>(null);

  return (
    <aside
      className="flex w-96 shrink-0 flex-col overflow-hidden border-l border-border/60"
      data-testid="wiki-artifact-preview"
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs"
          data-testid="wiki-artifact-path"
          title={path}
        >
          {path}
        </span>
        <Button
          aria-label="Open in editor"
          className="h-7 w-7 shrink-0"
          onClick={() => {
            setEditorError(null);
            void openWikiArtifactInEditor(path, reposDir).catch((error) => {
              setEditorError(
                error instanceof Error ? error.message : String(error),
              );
            });
          }}
          size="icon"
          title="Open in editor"
          variant="ghost"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
        <Button
          aria-label="Close artifact preview"
          className="h-7 w-7 shrink-0"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>
      {editorError ? (
        <p className="px-3 py-2 text-xs text-destructive">{editorError}</p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {artifact.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : artifact.error ? (
          <p className="text-xs text-destructive">{artifact.error}</p>
        ) : artifact.content === null ? (
          <p className="text-xs text-muted-foreground">
            This file is unavailable — it is missing, larger than the 64 KiB
            preview limit, a symlink, or not UTF-8.
          </p>
        ) : (
          <pre
            className="whitespace-pre-wrap break-all font-mono text-2xs"
            data-testid="wiki-artifact-content"
          >
            {artifact.content}
          </pre>
        )}
      </div>
    </aside>
  );
}
