import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveLayout,
  deriveWorkspacePaneLayout,
  deriveCenteredContentHorizontalPadding,
} from "./layout.ts";
import { resolveThreadSelectionNavigationAction } from "./adaptive-navigation.ts";

void test("phone rotation keeps the conversation on a compact back stack", () => {
  for (const dimensions of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    const layout = deriveLayout(dimensions);
    assert.equal(layout.usesSplitView, false);
    assert.equal(
      resolveThreadSelectionNavigationAction({
        usesSplitView: layout.usesSplitView,
        pathname: "/threads/vivid/one",
      }),
      "push",
    );
  }
});
void test("tablet selects peer conversations without growing history", () => {
  const layout = deriveLayout({ width: 1024, height: 768 });
  assert.equal(layout.usesSplitView, true);
  assert.equal(layout.listPaneWidth, 328);
  assert.equal(
    resolveThreadSelectionNavigationAction({
      usesSplitView: true,
      pathname: "/",
    }),
    "push",
  );
  assert.equal(
    resolveThreadSelectionNavigationAction({
      usesSplitView: true,
      pathname: "/threads/vivid/one",
    }),
    "set-params",
  );
  assert.equal(
    resolveThreadSelectionNavigationAction({
      usesSplitView: true,
      pathname: "/Library",
    }),
    "replace",
  );
});
void test("inspector cannot squeeze the main thread below its usable width", () => {
  const panes = deriveWorkspacePaneLayout({
    layout: deriveLayout({ width: 900, height: 700 }),
    viewportWidth: 900,
    primarySidebarPreferredVisible: true,
    auxiliaryPanePreferredVisible: true,
    auxiliaryPaneRole: "inspector",
  });
  assert.equal(panes.primarySidebarSuppressedByAuxiliary, true);
  assert.ok(panes.contentPaneWidth - (panes.auxiliaryPaneWidth ?? 0) >= 560);
});
void test("phone content padding does not go negative", () => {
  assert.equal(
    deriveCenteredContentHorizontalPadding({
      viewportWidth: 320,
      maxContentWidth: 760,
      minimumPadding: 20,
    }),
    20,
  );
});
