import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  document: dom.window.document,
  window: dom.window,
  self: dom.window,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
  writable: true,
});
dom.window.matchMedia ??= () => ({
  matches: false,
  media: "",
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return false;
  },
});
const mediaDevices = {
  enumerateDevices: async () => [],
  addEventListener() {},
  removeEventListener() {},
};
Object.defineProperty(dom.window.navigator, "mediaDevices", {
  configurable: true,
  value: mediaDevices,
});
dom.window.requestAnimationFrame = (callback) =>
  dom.window.setTimeout(() => callback(Date.now()), 0);
dom.window.cancelAnimationFrame = (id) => dom.window.clearTimeout(id);
dom.window.HTMLElement.prototype.scrollTo = () => {};
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame;
globalThis.matchMedia = dom.window.matchMedia;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key === "window" || key === "document" || key === "globalThis") continue;
  const value = dom.window[key];
  if (
    typeof value === "function" &&
    /^(HTML|SVG)|Element$|Event$|EventTarget$|^Node|^Document|Observer$/.test(
      key,
    )
  ) {
    globalThis[key] = value;
  }
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

globalThis.__TAURI_INTERNALS__ = {
  invoke: async (command) =>
    command === "get_identity"
      ? {
          pubkey: "a".repeat(64),
          display_name: "Owner",
        }
      : command === "plugin:event|listen"
        ? 1
        : [],
  transformCallback: () => 1,
};
globalThis.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  registerListener() {},
  unregisterListener() {},
};
dom.window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__;
dom.window.__TAURI_EVENT_PLUGIN_INTERNALS__ =
  globalThis.__TAURI_EVENT_PLUGIN_INTERNALS__;
let TooltipProvider;
let useState;
let createMemoryHistory;
let createRootRoute;
let createRouter;
let RouterProvider;
let act;
let createElement;
let render;
let cleanup;
let CommunitiesProvider;
let InboxDetailPane;
let QueryClient;
let QueryClientProvider;
let UpdaterProvider;
let HuddleProvider;
let router;
let currentRender;
let updateTestRoot;
const clients = [];

before(async () => {
  ({ act, createElement, useState } = await import("react"));
  ({ render, cleanup } = await import("@testing-library/react"));
  ({ HuddleProvider } = await import("@/features/huddle/HuddleContext.tsx"));
  ({ TooltipProvider } = await import("@/shared/ui/tooltip.tsx"));
  ({ UpdaterProvider } = await import("@/features/settings/hooks/UpdaterProvider.tsx"));
  ({ CommunitiesProvider } = await import("@/features/communities/useCommunities.tsx"));
  ({ QueryClient, QueryClientProvider } = await import("@tanstack/react-query"));
  ({
    createMemoryHistory,
    createRootRoute,
    createRouter,
    RouterProvider,
  } = await import("@tanstack/react-router"));
  ({ InboxDetailPane } = await import("./InboxDetailPane.tsx"));
  const rootRoute = createRootRoute({
    component: function TestRoot() {
      const [value, setValue] = useState(currentRender);
      updateTestRoot = setValue;
      if (!value) return null;
      return createElement(
        QueryClientProvider,
        { client: value.client },
        createElement(
          TooltipProvider,
          null,
          createElement(
            CommunitiesProvider,
            null,
            createElement(
              UpdaterProvider,
              null,
              createElement(
                HuddleProvider,
                null,
                createElement(InboxDetailPane, value.props),
              ),
            ),
          ),
        ),
      );
    },
  });
  router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) {
    client.clear();
  }
});

after(() => dom.window.close());

const OWNER = "a".repeat(64);
const AGENT = "b".repeat(64);
const CHANNEL = "c".repeat(64);

function makeItem() {
  return {
    avatarUrl: null,
    conversationId: "conversation-1",
    id: "event-1",
    item: {
      channelId: CHANNEL,
      channelName: "coder",
      channelType: "dm",
      content: "hello",
      createdAt: 1,
      kind: 1,
      pubkey: AGENT,
      tags: [["h", CHANNEL]],
    },
    categories: ["mention"],
    categoryLabel: "Mention",
    channelLabel: "coder",
    fullTimestampLabel: "now",
    groupItems: [],
    isActionRequired: false,
    latestActivityAt: 1,
    mentionNames: [],
    preview: "hello",
    senderLabel: "Coder",
    subject: "Coder",
    timestampLabel: "now",
    unreadCount: 0,
  };
}

function makeChannel() {
  return {
    id: CHANNEL,
    name: "coder",
    channelType: "dm",
    participantPubkeys: [OWNER, AGENT],
  };
}

function makeProps(item) {
  return {
    agentPubkeys: new Set([AGENT]),
    canDelete: false,
    canOpenChannel: true,
    canReply: true,
    editTargetId: null,
    item,
    channel: item ? makeChannel() : null,
    currentPubkey: OWNER,
    selectedEventId: null,
    onDelete: () => {},
    onDeleteMessage: () => {},
    onEditTargetChange: () => {},
    onEditSave: async () => {},
    onRequestEmptyEditDelete: () => {},
    onManageChannel: () => {},
    onOpenContext: () => {},
    onSendReply: async () => {},
  };
}
function tree(props, client) {
  currentRender = { client, props };
  return createElement(RouterProvider, { router });
}

test("InboxDetailPane survives null-to-DM-to-null selection transitions", async () => {
  assert.equal(typeof QueryClientProvider, "function");
  assert.equal(typeof CommunitiesProvider, "function");
  assert.equal(typeof UpdaterProvider, "function");
  assert.equal(typeof HuddleProvider, "function");
  assert.equal(typeof InboxDetailPane, "function");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const view = render(tree(makeProps(null), client));
  await act(async () => {});
  assert.ok(view.getByTestId("home-inbox-detail-empty"));
  await act(async () => {
    updateTestRoot({ client, props: makeProps(makeItem()) });
  });
  assert.ok(view.getByTestId("home-inbox-detail"));

  await act(async () => {
    updateTestRoot({ client, props: makeProps(null) });
  });
  assert.ok(view.getByTestId("home-inbox-detail-empty"));
});
