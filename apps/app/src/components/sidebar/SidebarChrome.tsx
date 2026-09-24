import {
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { useCloseMobileSidebar } from "@/components/ui/sidebar.js";
import {
  CHROME_ROW_CLASS,
  getBbDesktopInfo,
  DESKTOP_CHROME_CONTROL_NO_DRAG_CLASS,
  DESKTOP_WINDOW_DRAG_CLASS,
  MACOS_CHROME_CONTROL_AXIS_CLASS,
  shouldReserveMacosTrafficLights,
  shouldUseDesktopWindowChrome,
  shouldUseMacosDesktopChrome,
} from "@/lib/bb-desktop";
import { useDesktopWindowState } from "@/hooks/useDesktopWindowState";
import { SidebarHistoryNavigationControls } from "./SidebarHistoryNavigationControls";

const BROWSER_HEADER_SLOT_START_CLASS =
  "pl-[calc(env(safe-area-inset-left)_+_12px_+_var(--bb-sidebar-control-size)_-_4px)]";
const MACOS_TRAFFIC_LIGHT_HEADER_SLOT_START_CLASS =
  "pl-[calc(84px_+_var(--bb-sidebar-control-size)_-_4px)]";

export function SidebarTopReserveRow({
  testId,
  renderHeaderSlot,
}: {
  testId: string;
  renderHeaderSlot?: (startInsetClassName: string) => ReactNode;
}) {
  const closeOnMobile = useCloseMobileSidebar();
  const [desktopInfo] = useState(getBbDesktopInfo);
  const desktopWindowState = useDesktopWindowState();
  const usesDesktopChrome = shouldUseDesktopWindowChrome(desktopInfo);
  const usesMacosChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const reserveMacosTrafficLights = shouldReserveMacosTrafficLights({
    desktopInfo,
    windowState: desktopWindowState,
  });

  return (
    <div
      data-testid={testId}
      className={cn(
        CHROME_ROW_CLASS,
        "shrink-0 justify-end gap-1 px-2",
        usesDesktopChrome && DESKTOP_WINDOW_DRAG_CLASS,
      )}
    >
      {renderHeaderSlot?.(
        reserveMacosTrafficLights
          ? MACOS_TRAFFIC_LIGHT_HEADER_SLOT_START_CLASS
          : BROWSER_HEADER_SLOT_START_CLASS,
      )}
      <SidebarHistoryNavigationControls
        onNavigate={closeOnMobile}
        className={cn(
          "shrink-0",
          usesDesktopChrome && DESKTOP_CHROME_CONTROL_NO_DRAG_CLASS,
          usesMacosChrome && MACOS_CHROME_CONTROL_AXIS_CLASS,
        )}
      />
    </div>
  );
}

export function SidebarResizeHandle({
  isResizing,
  onMouseDown,
  testId,
}: {
  isResizing: boolean;
  onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "absolute -right-1.5 top-0 z-30 hidden h-full w-3 cursor-col-resize md:block",
        "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors hover:before:bg-sidebar-border",
        isResizing && "before:bg-sidebar-border",
      )}
      onMouseDown={onMouseDown}
    />
  );
}
