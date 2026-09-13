import { describe, expect, it } from "vitest";
import {
  basenameHostPath,
  buildHostPathKey,
  detectHostPathFlavor,
  isAbsoluteHostPath,
  isBareDriveHostPath,
  isHostPathRoot,
  isHostPathWithin,
  isUncOrDeviceHostPath,
  joinHostPath,
  normalizeHostPath,
} from "../src/host-path.js";

describe("host-path", () => {
  it("classifies host paths by shape", () => {
    expect(detectHostPathFlavor("/home/me/repo")).toBe("posix");
    expect(detectHostPathFlavor("C:\\Users\\me\\repo")).toBe("windows");
    expect(detectHostPathFlavor("c:/Users/me/repo")).toBe("windows");
    expect(detectHostPathFlavor("C:\\")).toBe("windows");
    expect(detectHostPathFlavor("C:")).toBe("windows");
    expect(detectHostPathFlavor("C:Users\\me")).toBeNull();
    expect(detectHostPathFlavor("relative/path")).toBeNull();
    expect(detectHostPathFlavor("\\\\server\\share\\repo")).toBeNull();
    expect(detectHostPathFlavor("//server/share/repo")).toBeNull();
    expect(detectHostPathFlavor("\\\\?\\C:\\Users\\me")).toBeNull();
    expect(detectHostPathFlavor("")).toBeNull();
  });

  it("recognizes UNC and device paths", () => {
    expect(isUncOrDeviceHostPath("\\\\server\\share")).toBe(true);
    expect(isUncOrDeviceHostPath("//server/share")).toBe(true);
    expect(isUncOrDeviceHostPath("\\\\?\\C:\\x")).toBe(true);
    expect(isUncOrDeviceHostPath("\\\\.\\pipe\\x")).toBe(true);
    expect(isUncOrDeviceHostPath("C:\\x")).toBe(false);
    expect(isUncOrDeviceHostPath("/x")).toBe(false);
  });

  it("recognizes a bare drive letter without a separator", () => {
    expect(isBareDriveHostPath("C:")).toBe(true);
    expect(isBareDriveHostPath("c:")).toBe(true);
    expect(isBareDriveHostPath("C:\\")).toBe(false);
    expect(isBareDriveHostPath("C:/")).toBe(false);
    expect(isBareDriveHostPath("C:Users\\me")).toBe(false);
    expect(isBareDriveHostPath("/srv/repo")).toBe(false);
    expect(isBareDriveHostPath("")).toBe(false);
  });

  it("answers absolute and windows checks", () => {
    expect(isAbsoluteHostPath("/srv/repo")).toBe(true);
    expect(isAbsoluteHostPath("D:/repo")).toBe(true);
    expect(isAbsoluteHostPath("repo")).toBe(false);
    expect(detectHostPathFlavor("D:/repo")).toBe("windows");
    expect(detectHostPathFlavor("/srv/repo")).toBe("posix");
  });

  it("normalizes Windows paths to uppercase drive and backslashes", () => {
    expect(normalizeHostPath("c:/Users//me\\repo/")).toBe(
      "C:\\Users\\me\\repo",
    );
    expect(normalizeHostPath("c:\\")).toBe("C:\\");
    expect(normalizeHostPath("c:/")).toBe("C:\\");
    expect(normalizeHostPath("c:")).toBe("C:\\");
    expect(normalizeHostPath("C:\\Work\\bb\\\\")).toBe("C:\\Work\\bb");
  });

  it("normalizes POSIX paths by trimming trailing separators only", () => {
    expect(normalizeHostPath("/srv/repo/")).toBe("/srv/repo");
    expect(normalizeHostPath("/srv//repo")).toBe("/srv//repo");
    expect(normalizeHostPath("/")).toBe("/");
    expect(normalizeHostPath("///")).toBe("/");
  });

  it("returns non-absolute input unchanged", () => {
    expect(normalizeHostPath("relative/path/")).toBe("relative/path/");
    expect(normalizeHostPath("\\\\server\\share\\")).toBe(
      "\\\\server\\share\\",
    );
  });

  it("detects filesystem roots", () => {
    expect(isHostPathRoot("/")).toBe(true);
    expect(isHostPathRoot("c:/")).toBe(true);
    expect(isHostPathRoot("C:")).toBe(true);
    expect(isHostPathRoot("/srv")).toBe(false);
    expect(isHostPathRoot("C:\\srv")).toBe(false);
  });

  it("joins with the root's separator", () => {
    expect(joinHostPath("/home/me/.bb", "worktrees")).toBe(
      "/home/me/.bb/worktrees",
    );
    expect(joinHostPath("/", "srv", "repo")).toBe("/srv/repo");
    expect(joinHostPath("C:\\Users\\me\\.bb", "worktrees", "env/repo")).toBe(
      "C:\\Users\\me\\.bb\\worktrees\\env\\repo",
    );
    expect(joinHostPath("C:\\", "Work")).toBe("C:\\Work");
    expect(joinHostPath("C:\\Work")).toBe("C:\\Work");
  });

  it("derives basenames per flavor", () => {
    expect(basenameHostPath("/srv/repos/bb/")).toBe("bb");
    expect(basenameHostPath("C:\\Users\\me\\bb")).toBe("bb");
    expect(basenameHostPath("c:/Users/me/bb/")).toBe("bb");
    expect(basenameHostPath("/")).toBe("");
    expect(basenameHostPath("C:\\")).toBe("");
  });

  it("builds comparison keys", () => {
    expect(buildHostPathKey("C:\\Work\\bb")).toBe("c:/work/bb");
    expect(buildHostPathKey("c:/work/bb/")).toBe("c:/work/bb");
    expect(buildHostPathKey("C:\\")).toBe("c:/");
    expect(buildHostPathKey("/Work/bb/")).toBe("/Work/bb");
    expect(buildHostPathKey("/")).toBe("/");
  });

  it("checks containment by key", () => {
    expect(
      isHostPathWithin({
        rootPath: "/home/me/.bb/worktrees",
        candidatePath: "/home/me/.bb/worktrees/env/repo",
      }),
    ).toBe(true);
    expect(
      isHostPathWithin({
        rootPath: "/home/me/.bb/worktrees",
        candidatePath: "/home/me/.bb/worktrees",
      }),
    ).toBe(true);
    expect(
      isHostPathWithin({
        rootPath: "/home/me/.bb/worktrees",
        candidatePath: "/home/me/.bb/worktrees-2",
      }),
    ).toBe(false);
    expect(isHostPathWithin({ rootPath: "/", candidatePath: "/srv" })).toBe(
      true,
    );
    expect(
      isHostPathWithin({
        rootPath: "C:\\Users\\me\\.bb\\worktrees",
        candidatePath: "c:/users/ME/.bb/worktrees/env/repo",
      }),
    ).toBe(true);
    expect(
      isHostPathWithin({ rootPath: "C:\\", candidatePath: "C:\\Work" }),
    ).toBe(true);
    expect(
      isHostPathWithin({
        rootPath: "C:\\Users\\me",
        candidatePath: "/Users/me/repo",
      }),
    ).toBe(false);
    expect(
      isHostPathWithin({
        rootPath: "C:\\Users\\me",
        candidatePath: "C:\\Users\\me2",
      }),
    ).toBe(false);
  });
});
