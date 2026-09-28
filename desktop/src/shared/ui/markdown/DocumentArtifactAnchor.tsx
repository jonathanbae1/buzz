import * as React from "react";

import {
  MediaContextMenu,
  type MediaContextMenuPosition,
  useDismissMediaContextMenu,
} from "./MediaContextMenu";

/**
 * A link from document content to a file inside the checkout but outside the
 * document collection — e.g. a wiki page citing `../buzz-fork.json`.
 *
 * Such a target is not a URL: the app runs under a CSP of `default-src 'self'`
 * with hashed routing, so handing the raw relative href to
 * `ExternalLinkAnchor` would send a meaningless path to the OS opener. Left
 * click opens the file through the local content reader; the context menu
 * offers the same action plus *Open in editor*, which goes through the
 * root-confined opener command.
 */
export function DocumentArtifactAnchor({
  children,
  onOpen,
  path,
}: {
  children: React.ReactNode;
  onOpen: (path: string, action: "preview" | "editor") => void;
  path: string;
}) {
  const [menu, setMenu] = React.useState<MediaContextMenuPosition | null>(null);
  const closeMenu = React.useCallback(() => setMenu(null), []);
  useDismissMediaContextMenu(Boolean(menu), closeMenu);

  return (
    <>
      <a
        className="cursor-pointer font-medium text-primary underline underline-offset-4 transition-colors hover:text-primary/80"
        data-document-artifact={path}
        href={`#${path}`}
        onClick={(event) => {
          event.preventDefault();
          onOpen(path, "preview");
        }}
        onContextMenuCapture={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {children}
      </a>
      {menu ? (
        <MediaContextMenu
          dataAttributes={["data-document-artifact-context-menu"]}
          items={[
            {
              label: "Open artifact",
              onSelect: () => {
                closeMenu();
                onOpen(path, "preview");
              },
            },
            {
              label: "Open in editor",
              onSelect: () => {
                closeMenu();
                onOpen(path, "editor");
              },
            },
          ]}
          position={menu}
        />
      ) : null}
    </>
  );
}
