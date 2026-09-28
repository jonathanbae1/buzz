import type { DocumentCitationResolution } from "@/shared/ui/markdown/types";
import {
  type ParsedProvenance,
  parseProvenance,
} from "@/shared/lib/remarkProvenanceMarkers";

/**
 * Provenance markers for the document surface.
 *
 * `wiki/README.md` defines five markers, and every claim in the wiki carries
 * one. All five are rendered even though two have no instances today: a marker
 * that disappears the first time someone writes it is worse than an unused
 * style.
 *
 * The chip is inert by construction. Full citation resolution needs the
 * checkout's tracked paths, which the renderer does not have, so a `source`
 * marker is rendered with its citation verbatim and its full title — the caller
 * that *does* know the checkout composes navigation around it via the runtime's
 * `onOpenCitation`, which the pane supplies.
 */

const MARKER_STYLE: Record<ParsedProvenance["kind"], string> = {
  // Cobalt `#1d4ed8`/`#60a5fa` — `docs/DESIGN.md` binds it to "CURRENT (proven
  // facts)", which is exactly what `(source: …)` asserts.
  source:
    "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  // Vermilion `#c22d15`/`#ff6b52` — "PLANNED; NOT IMPLEMENTED" in DESIGN.md,
  // and a `(decision)` is by definition reversible.
  decision: "border-destructive/40 bg-destructive/10 text-destructive",
  // Amber `#9a4205`/`#fbbf24` — "UNVERIFIED (Open Caveats)". Both markers that
  // rest on an unverified or ageing source wear it: a measurement taken on a
  // date, and a citation to a captured record nobody re-reads.
  measured: "border-amber-500/30 bg-amber-500/10 text-warning",
  captured: "border-amber-500/30 bg-amber-500/10 text-warning",
  // Neutral `#4e5058`/`#a3a6b2` — "HISTORICAL (Past Evidence)".
  upstream: "border-border bg-muted text-muted-foreground",
};

const MARKER_LABEL: Record<ParsedProvenance["kind"], string> = {
  source: "source",
  measured: "measured",
  decision: "reversible",
  upstream: "upstream",
  captured: "captured",
};

/**
 * A provenance chip. The full original marker text and its line/range are
 * preserved in `title` whether or not anything can navigate to the target:
 * provenance text is never rewritten.
 */
export function ProvenanceChip({
  onOpenSource,
  raw,
  resolveSource,
}: {
  onOpenSource?: (path: string, line?: number) => void;
  raw: string;
  resolveSource?: (
    path: string | undefined,
    line?: number,
  ) => DocumentCitationResolution;
}) {
  const parsed = parseProvenance(raw);
  const className = [
    "inline-flex max-w-full items-baseline gap-1 rounded border px-1.5 py-0.5 align-baseline font-mono text-2xs",
    parsed ? MARKER_STYLE[parsed.kind] : "border-border bg-muted",
  ].join(" ");

  if (!parsed) {
    return (
      <span className={className} data-provenance-marker="unknown" title={raw}>
        {raw}
      </span>
    );
  }

  const label = parsed.kind === "source" && parsed.path ? parsed.path : parsed.raw;
  // A citation navigates only when the caller's resolver found exactly one
  // tracked file for it. Zero or several matches stays inert: the full citation
  // is still shown, so the reader sees the source without a click that could
  // open the wrong file.
  const resolution =
    parsed.kind === "source" && resolveSource
      ? resolveSource(parsed.path, parsed.line)
      : ({ navigable: false } as const);
  const canNavigate =
    resolution.navigable && onOpenSource !== undefined && parsed.kind === "source";

  if (canNavigate && resolution.navigable) {
    return (
      <button
        className={[className, "cursor-pointer hover:brightness-110"].join(" ")}
        data-provenance-marker={parsed.kind}
        onClick={() => onOpenSource?.(resolution.path, resolution.line)}
        title={parsed.raw}
        type="button"
      >
        {MARKER_LABEL[parsed.kind]} {label}
        {resolution.line ? `:${resolution.line}` : ""}
      </button>
    );
  }

  return (
    <span
      className={className}
      data-provenance-marker={parsed.kind}
      title={parsed.raw}
    >
      {MARKER_LABEL[parsed.kind]} {label}
      {parsed.kind === "source" && parsed.line ? `:${parsed.line}` : ""}
    </span>
  );
}
