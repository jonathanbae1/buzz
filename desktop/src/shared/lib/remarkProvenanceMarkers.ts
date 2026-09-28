/**
 * Provenance markers for the document surface.
 *
 * `wiki/README.md` defines five markers, and every claim in the wiki carries
 * one. Rendering four of them and silently dropping the fifth would make a
 * `(captured mem_…)` citation invisible the first time someone writes one, so
 * all five are recognised here — two simply have no instances today.
 *
 * Registration is document-surface-only (see `buildMarkdownElement`), which is
 * why the emitted node type is inert everywhere else: chat and README
 * rendering never install the plugin.
 */
import { createRemarkPrefixPlugin } from "@/shared/lib/createRemarkPrefixPlugin.ts";

/** One `( … )` marker, matched whole so partial text is never chipped. */
const PROVENANCE_PATTERN =
  /\((?:source: [^)\n]+|measured \d{4}-\d{2}-\d{2}|decision|upstream #[^)\n]+|captured [^)\n]+)\)/g;

export type ProvenanceKind =
  | "source"
  | "measured"
  | "decision"
  | "upstream"
  | "captured";

export type ParsedProvenance = {
  kind: ProvenanceKind;
  /** Full original marker text, preserved verbatim for the chip's title. */
  raw: string;
  /** Cited path for `source` markers, with any `:line` / `:a-b` suffix split off. */
  path?: string;
  /** First line of a cited range, when the marker carried one. */
  line?: number;
};

export function parseProvenance(text: string): ParsedProvenance | null {
  const trimmed = text.trim();
  const inner = trimmed.replace(/^\(/, "").replace(/\)$/, "");
  if (inner.startsWith("source: ")) {
    const citation = inner.slice("source: ".length).trim();
    // A marker may cite several paths (`source: a:1, b:2`). The original text
    // is still shown verbatim, but navigation is only offered for a single
    // unambiguous path — opening one of two cited files would look
    // authoritative and be wrong.
    const match = citation.match(/^(.*?):(\d+)(?:-\d+)?$/);
    return {
      kind: "source",
      raw: trimmed,
      path: citation.includes(", ") ? undefined : match ? match[1] : citation,
      line: !citation.includes(", ") && match ? Number(match[2]) : undefined,
    };
  }
  if (/^measured \d{4}-\d{2}-\d{2}$/.test(inner)) {
    return { kind: "measured", raw: trimmed };
  }
  if (inner === "decision") return { kind: "decision", raw: trimmed };
  if (inner.startsWith("upstream #")) {
    return { kind: "upstream", raw: trimmed };
  }
  if (inner.startsWith("captured ")) {
    return { kind: "captured", raw: trimmed };
  }
  return null;
}

export default function remarkProvenanceMarkers() {
  return createRemarkPrefixPlugin(PROVENANCE_PATTERN, (matchText) => ({
    node: {
      type: "provenance-marker",
      value: matchText,
      data: {
        hName: "provenance-marker",
        hChildren: [{ type: "text", value: matchText }],
      },
    },
  }));
}

/**
 * Rule 5 requires a page to say when it was last verified, and the wiki uses
 * four different phrasings for it. Only the declared date is displayed; the
 * pane does not sort, filter or warn on it.
 */
const VERIFIED_PATTERNS = [
  /Last verified:\s*(\d{4}-\d{2}-\d{2})/,
  /Acceptance verified:\s*(\d{4}-\d{2}-\d{2})/,
  /Acceptance completed:\s*(\d{4}-\d{2}-\d{2})/,
];

/** The page's own declared verification date, from its first block only. */
export function declaredVerifiedAt(content: string): string | null {
  const head = content.split("\n").slice(0, 10).join("\n");
  for (const pattern of VERIFIED_PATTERNS) {
    const match = head.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/** Whole days between the declared date and today, or null if unparseable. */
export function ageInDays(isoDate: string, now = Date.now()): number | null {
  const parsed = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.floor((now - parsed) / 86_400_000));
}
