// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BbDesktopInfo } from "@bb/desktop-contract";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";
import { WINDOWS_CAPTION_CONTROLS_RESERVE_CLASS } from "@/lib/bb-desktop";
import { createBbDesktopApi } from "@/test/bb-desktop-test-utils";
import { PaneContext, type PaneContextValue } from "./PaneContext";
import { ThreadDetailHeader } from "./ThreadDetailHeader";

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  useThreadActions: () => ({
    renameThread: vi.fn(),
  }),
}));

const desktopInfo: BbDesktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "windows",
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-test",
};

const PANE_CONTEXT: PaneContextValue = {
  paneId: "main",
  isFocused: true,
  isSplitPane: false,
  secondaryPanelHost: null,
  reservesWindowPanelToggle: false,
  onRequestClose: null,
  isMaximized: false,
  onToggleMaximize: null,
  isBoundedPane: false,
  isTopRow: true,
  ownsWindowTopLeft: true,
  ownsWindowTopRight: true,
  navigateInPane: vi.fn(),
};

afterEach(() => {
  cleanup();
  delete window.bbDesktop;
});

function renderThreadHeader(args: {
  isCompactViewport: boolean;
  isSecondaryPanelOpen: boolean;
  platform: BbDesktopInfo["platform"];
}): string {
  window.bbDesktop = createBbDesktopApi({
    ...desktopInfo,
    platform: args.platform,
  });

  render(
    <CompactViewportOverrideProvider isCompactViewport={args.isCompactViewport}>
      <SidebarProvider>
        <TooltipProvider>
          <PaneContext.Provider value={PANE_CONTEXT}>
            <ThreadDetailHeader
              actionsMenu={null}
              childPillLabel={null}
              isSecondaryPanelOpen={args.isSecondaryPanelOpen}
              onOpenThreadGitAction={vi.fn()}
              onToggleSecondaryPanel={vi.fn()}
              threadHeaderGitActions={[]}
              threadId="thr_caption_reserve"
              threadTitle="Caption reserve"
            />
          </PaneContext.Provider>
        </TooltipProvider>
      </SidebarProvider>
    </CompactViewportOverrideProvider>,
  );

  return screen.getByTestId("app-page-header-content-row").className;
}

describe("ThreadDetailHeader Windows caption reserve", () => {
  it("cedes the caption reserve to the inline secondary panel header", () => {
    expect(
      renderThreadHeader({
        isCompactViewport: false,
        isSecondaryPanelOpen: true,
        platform: "windows",
      }),
    ).not.toContain(WINDOWS_CAPTION_CONTROLS_RESERVE_CLASS);
  });

  it("keeps the caption reserve while the secondary panel is closed", () => {
    expect(
      renderThreadHeader({
        isCompactViewport: false,
        isSecondaryPanelOpen: false,
        platform: "windows",
      }),
    ).toContain(WINDOWS_CAPTION_CONTROLS_RESERVE_CLASS);
  });

  it("keeps the caption reserve when the open panel is a compact drawer", () => {
    expect(
      renderThreadHeader({
        isCompactViewport: true,
        isSecondaryPanelOpen: true,
        platform: "windows",
      }),
    ).toContain(WINDOWS_CAPTION_CONTROLS_RESERVE_CLASS);
  });

  it("renders the macOS header identically whether the panel is open or closed", () => {
    const openClassName = renderThreadHeader({
      isCompactViewport: false,
      isSecondaryPanelOpen: true,
      platform: "macos",
    });
    cleanup();
    const closedClassName = renderThreadHeader({
      isCompactViewport: false,
      isSecondaryPanelOpen: false,
      platform: "macos",
    });

    expect(openClassName).toBe(closedClassName);
    expect(openClassName).not.toContain(WINDOWS_CAPTION_CONTROLS_RESERVE_CLASS);
  });
});
