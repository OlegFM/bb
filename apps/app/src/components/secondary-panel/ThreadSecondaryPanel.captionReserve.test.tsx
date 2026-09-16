// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PanelGroup } from "react-resizable-panels";
import type { BbDesktopInfo } from "@bb/desktop-contract";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  createGitDiffFixedPanelTab,
  createThreadInfoFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import { WINDOWS_CAPTION_CONTROLS_RESERVE_WITH_GUTTER_CLASS } from "@/lib/bb-desktop";
import { createBbDesktopApi } from "@/test/bb-desktop-test-utils";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  createSidebarSplitState,
  moveSidebarTab,
  serializeSidebarSplitState,
  sidebarSplitStorageKey,
} from "./sidebarSplitLayout";
import { ThreadSecondaryPanel } from "./ThreadSecondaryPanel";

const desktopInfo: BbDesktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "windows",
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-test",
};

const noop = () => {};
const infoFixedTab = createThreadInfoFixedPanelTab();
const diffFixedTab = createGitDiffFixedPanelTab();
const fixedTabs = [
  {
    ariaLabel: "Show thread info panel",
    label: "Info",
    leadingVisual: null,
    onSelect: noop,
    tab: infoFixedTab,
    title: "Thread info",
  },
  {
    ariaLabel: "Show diff panel",
    label: "Diff",
    leadingVisual: null,
    onSelect: noop,
    tab: diffFixedTab,
    title: "Diff",
  },
] as const;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete window.bbDesktop;
});

function renderSplitPanel(args: {
  panelStateId: string;
  zone: "bottom" | "right";
}) {
  const initial = createSidebarSplitState(
    [infoFixedTab.id, diffFixedTab.id],
    diffFixedTab.id,
  );
  const split = moveSidebarTab(
    initial,
    initial.layout.focusedPaneId,
    diffFixedTab.id,
    { paneId: initial.layout.focusedPaneId, zone: args.zone },
    { groupId: "group-diff" },
  );
  window.localStorage.setItem(
    sidebarSplitStorageKey(args.panelStateId),
    serializeSidebarSplitState(split),
  );
  const { wrapper: Wrapper } = createQueryClientTestHarness();

  return render(
    <Wrapper>
      <SidebarProvider>
        <TooltipProvider>
          <PanelGroup direction="horizontal">
            <ThreadSecondaryPanel
              activeTab={diffFixedTab}
              canUseGitUi
              fixedTabs={fixedTabs}
              tabs={[]}
              isConversationCollapsed={false}
              isOpen
              metadataContent={<div>Thread metadata</div>}
              onClose={noop}
              onCollapse={noop}
              onTabReorder={noop}
              onOpenNewTab={noop}
              onPanelFocus={noop}
              onToggleConversationCollapse={noop}
              renderAsDrawer={false}
              splitPanelStateId={args.panelStateId}
            />
          </PanelGroup>
        </TooltipProvider>
      </SidebarProvider>
    </Wrapper>,
  );
}

describe("ThreadSecondaryPanel Windows caption reserve", () => {
  it("reserves caption space only on the pane that owns the window top-right corner", () => {
    window.bbDesktop = createBbDesktopApi(desktopInfo);

    renderSplitPanel({ panelStateId: "caption-reserve-row", zone: "right" });

    const rows = screen.getAllByTestId("thread-secondary-panel-top-chrome");
    expect(rows).toHaveLength(2);
    const [leftRow, rightRow] = rows;
    expect(leftRow?.className).not.toContain(
      WINDOWS_CAPTION_CONTROLS_RESERVE_WITH_GUTTER_CLASS,
    );
    expect(rightRow?.className).toContain(
      WINDOWS_CAPTION_CONTROLS_RESERVE_WITH_GUTTER_CLASS,
    );
  });

  it("keeps the reserve off a bottom-row pane", () => {
    window.bbDesktop = createBbDesktopApi(desktopInfo);

    renderSplitPanel({
      panelStateId: "caption-reserve-column",
      zone: "bottom",
    });

    const rows = screen.getAllByTestId("thread-secondary-panel-top-chrome");
    expect(rows).toHaveLength(2);
    const [topRow, bottomRow] = rows;
    expect(topRow?.className).toContain(
      WINDOWS_CAPTION_CONTROLS_RESERVE_WITH_GUTTER_CLASS,
    );
    expect(bottomRow?.className).not.toContain(
      WINDOWS_CAPTION_CONTROLS_RESERVE_WITH_GUTTER_CLASS,
    );
  });

  it("leaves the macOS panel free of the caption reserve", () => {
    window.bbDesktop = createBbDesktopApi({
      ...desktopInfo,
      platform: "macos",
    });

    renderSplitPanel({ panelStateId: "caption-reserve-macos", zone: "right" });

    for (const row of screen.getAllByTestId(
      "thread-secondary-panel-top-chrome",
    )) {
      expect(row.className).not.toContain(
        WINDOWS_CAPTION_CONTROLS_RESERVE_WITH_GUTTER_CLASS,
      );
    }
  });
});
