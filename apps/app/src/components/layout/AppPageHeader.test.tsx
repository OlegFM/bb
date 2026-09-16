// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BbDesktopInfo } from "@bb/desktop-contract";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { createBbDesktopApi } from "@/test/bb-desktop-test-utils";
import { WINDOWS_CAPTION_CONTROLS_RESERVE_CLASS } from "@/lib/bb-desktop";
import { AppPageHeader } from "./AppPageHeader";

vi.mock("@/components/ui/sidebar.js", () => ({
  useIsSidebarShowing: () => true,
}));

const desktopInfo: BbDesktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "macos",
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-test",
};

afterEach(() => {
  cleanup();
  delete window.bbDesktop;
});

function renderPageHeader() {
  return render(
    <CompactViewportOverrideProvider isCompactViewport={false}>
      <AppPageHeader actions={<button type="button">Act</button>} />
    </CompactViewportOverrideProvider>,
  );
}

describe("AppPageHeader desktop chrome", () => {
  it("reserves the caption-control width and drags the window on Windows", () => {
    window.bbDesktop = createBbDesktopApi({
      ...desktopInfo,
      platform: "windows",
    });

    renderPageHeader();

    expect(screen.getByRole("banner").className).toContain("[app-region:drag]");
    expect(
      screen.getByTestId("app-page-header-content-row").className,
    ).toContain(WINDOWS_CAPTION_CONTROLS_RESERVE_CLASS);
  });

  it("keeps the macOS header free of the caption reserve", () => {
    window.bbDesktop = createBbDesktopApi(desktopInfo);

    renderPageHeader();

    expect(screen.getByRole("banner").className).toContain("[app-region:drag]");
    expect(
      screen.getByTestId("app-page-header-content-row").className,
    ).not.toContain(WINDOWS_CAPTION_CONTROLS_RESERVE_CLASS);
  });
});
