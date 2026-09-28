/**
 * Rehype plugin that gives document-surface headings stable GitHub-style ids.
 *
 * Chat and README rendering never install this plugin: it is registered only
 * when `documentSurface` is set (see `buildMarkdownElement` in
 * `shared/ui/markdown/nodeCache.ts`). The ids exist so a curated wiki's own
 * cross-page `page.md#heading` links resolve, which is a property of the
 * document, not of the renderer.
 *
 * Ids are assigned in document order with GitHub's deterministic `-1`, `-2`, …
 * suffix for repeated slugs. Assignment happens here, over the whole tree,
 * rather than inside an `h1`/`h2` component: the component map is module-stable
 * and shared across cached parses, so it cannot hold the per-document "have I
 * seen this slug" cursor without leaking state between documents.
 */

interface HastText {
  type: "text";
  value: string;
}

interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}

type HastNode = HastElement | HastText | { type: string };

interface HastRoot {
  type: "root";
  children: HastNode[];
}

const HEADING_TAGS: Record<string, true> = {
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
};

function isElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

function isText(node: HastNode): node is HastText {
  return node.type === "text";
}

/** Concatenate the text content of a subtree (headings carry inline children). */
function textContent(children: HastNode[]): string {
  let text = "";
  for (const child of children) {
    if (isText(child)) {
      text += child.value;
    } else if (isElement(child)) {
      text += textContent(child.children);
    }
  }
  return text;
}

/**
 * The single slug rule for the whole app: both this plugin (which writes the
 * ids) and the document-link resolver that scrolls to them call this, so a
 * heading's id and its anchor can never drift apart.
 */
export function githubHeadingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

export default function rehypeDocumentHeadings() {
  return (tree: HastRoot) => {
    const seen = new Map<string, number>();
    const walk = (nodes: HastNode[]) => {
      for (const node of nodes) {
        if (!isElement(node)) continue;
        if (HEADING_TAGS[node.tagName]) {
          const base = githubHeadingSlug(textContent(node.children));
          if (base.length > 0) {
            const count = seen.get(base) ?? 0;
            seen.set(base, count + 1);
            const id = count === 0 ? base : `${base}-${count}`;
            node.properties = { ...(node.properties ?? {}), id };
          }
        }
        walk(node.children);
      }
    };
    walk(tree.children);
  };
}
