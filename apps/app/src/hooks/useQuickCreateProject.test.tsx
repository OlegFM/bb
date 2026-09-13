// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { Host } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectPathDialogTarget } from "@/components/dialogs/ProjectPathDialog";
import type { LocalPathSubmitParams } from "@/hooks/useLocalPathPicker";
import { useQuickCreateProject } from "./useQuickCreateProject";

const mocks = vi.hoisted(() => ({
  hosts: [] as Host[] | undefined,
  isLoadingHosts: false,
  mutate: vi.fn(),
  navigate: vi.fn(),
  onClose: vi.fn(),
  onOpen: vi.fn(),
  onOpenChange: vi.fn(),
  openPathEntry: vi.fn(),
  openPicker: vi.fn(),
  setRootComposeProjectId: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/" }),
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/hooks/mutations/project-mutations", () => ({
  useCreateProject: () => ({ isPending: false, mutate: mocks.mutate }),
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  selectPersistentHosts: (hosts: readonly Host[] | undefined) =>
    hosts ? [...hosts] : [],
  useHosts: () => ({ data: mocks.hosts, isPending: mocks.isLoadingHosts }),
}));

vi.mock("@/hooks/useLocalPathPicker", () => ({
  useLocalPathPicker: ({
    submit,
  }: {
    submit: (params: LocalPathSubmitParams) => void;
  }) => ({
    isAvailable: true,
    hostId: "host_atum",
    hostName: "atum",
    openPathEntry: mocks.openPathEntry,
    openPicker: mocks.openPicker,
    platform: "linux",
    projectPathDialog: {
      isOpen: false,
      onClose: mocks.onClose,
      onOpen: mocks.onOpen,
      onOpenChange: mocks.onOpenChange,
      target: null,
    },
    submitProjectPath: (
      target: ProjectPathDialogTarget,
      path: string,
      targetHostId: string | null,
    ) => {
      if (targetHostId === null) return;
      submit({
        path,
        hostId: targetHostId,
        target,
        closeDialog: mocks.onClose,
      });
    },
  }),
}));

vi.mock("@/lib/root-compose-selection", () => ({
  useSetRootComposeProjectId: () => mocks.setRootComposeProjectId,
}));

function host(
  id: string,
  name: string,
  status: Host["status"] = "connected",
): Host {
  return makeHost({
    id,
    name,
    status,
  });
}

beforeEach(() => {
  mocks.hosts = [host("host_atum", "atum")];
  mocks.isLoadingHosts = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useQuickCreateProject", () => {
  it("delegates opening to the shared path-entry surface", () => {
    const { result } = renderHook(() => useQuickCreateProject());

    act(() => result.current.openCreateDialog());

    expect(mocks.openPathEntry).toHaveBeenCalledWith({ kind: "create" });
  });

  it("exposes the machine list for the dialog's picker", () => {
    mocks.hosts = [host("host_atum", "atum"), host("host_thoth", "Thoth")];
    const { result } = renderHook(() => useQuickCreateProject());

    expect(result.current.hosts.map((item) => item.id)).toEqual([
      "host_atum",
      "host_thoth",
    ]);
  });

  it("derives the project name from a submitted Windows drive-absolute path", () => {
    const { result } = renderHook(() => useQuickCreateProject());

    act(() => {
      result.current.submitProjectPath(
        { kind: "create" },
        "C:\\Work\\bb",
        "host_atum",
      );
    });

    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "bb" }),
      expect.anything(),
    );
  });
});
