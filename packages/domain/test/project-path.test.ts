import { describe, expect, it } from "vitest";
import {
  deriveProjectNameFromPath,
  getProjectPathValidationMessage,
  INVALID_PROJECT_PATH_MESSAGE,
  isAbsoluteProjectPath,
  normalizeProjectPathInput,
  PROJECT_PATH_ROOT_MESSAGE,
  UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE,
} from "../src/project-path.js";

describe("project-path", () => {
  const windowsProjectPath = "C:\\Users\\michael\\bb";
  const uncProjectPath = "\\\\server\\share\\bb";

  it("derives a project name from POSIX paths", () => {
    expect(deriveProjectNameFromPath("/srv/repos/bb")).toBe("bb");
    expect(deriveProjectNameFromPath("/srv/repos/bb/")).toBe("bb");
    expect(deriveProjectNameFromPath("/mnt/c/Users/michael/bb/")).toBe("bb");
  });

  it("derives a project name from Windows paths with either separator", () => {
    expect(deriveProjectNameFromPath(windowsProjectPath)).toBe("bb");
    expect(deriveProjectNameFromPath("C:/Users/michael/bb/")).toBe("bb");
    expect(deriveProjectNameFromPath("c:\\users\\michael\\bb\\")).toBe("bb");
  });

  it("does not derive a project name from roots, UNC paths or relative paths", () => {
    expect(deriveProjectNameFromPath("/")).toBe("");
    expect(deriveProjectNameFromPath("C:\\")).toBe("");
    expect(deriveProjectNameFromPath("c:/")).toBe("");
    expect(deriveProjectNameFromPath(uncProjectPath)).toBe("");
    expect(deriveProjectNameFromPath("relative/bb")).toBe("");
  });

  it("recognizes absolute paths of both flavors", () => {
    expect(isAbsoluteProjectPath("/srv/repos/bb")).toBe(true);
    expect(isAbsoluteProjectPath("/mnt/c/Users/michael/bb")).toBe(true);
    expect(isAbsoluteProjectPath(windowsProjectPath)).toBe(true);
    expect(isAbsoluteProjectPath("  C:/Users/michael/bb  ")).toBe(true);
    expect(isAbsoluteProjectPath(uncProjectPath)).toBe(false);
    expect(isAbsoluteProjectPath("C:Users\\michael\\bb")).toBe(false);
    expect(isAbsoluteProjectPath("relative/path")).toBe(false);
  });

  it("normalizes input without collapsing roots", () => {
    expect(normalizeProjectPathInput("/srv/repos/bb/")).toBe("/srv/repos/bb");
    expect(normalizeProjectPathInput("/")).toBe("/");
    expect(normalizeProjectPathInput(" c:/Users/michael/bb/ ")).toBe(
      windowsProjectPath,
    );
    expect(normalizeProjectPathInput(`${windowsProjectPath}\\`)).toBe(
      windowsProjectPath,
    );
    expect(normalizeProjectPathInput("c:")).toBe("C:\\");
    expect(normalizeProjectPathInput(uncProjectPath)).toBe(uncProjectPath);
    expect(normalizeProjectPathInput("   ")).toBe("");
  });

  it("returns clear validation messages", () => {
    expect(getProjectPathValidationMessage("/srv/repos/bb")).toBeNull();
    expect(getProjectPathValidationMessage(windowsProjectPath)).toBeNull();
    expect(getProjectPathValidationMessage("c:/Users/michael/bb/")).toBeNull();
    expect(getProjectPathValidationMessage("/")).toBe(
      PROJECT_PATH_ROOT_MESSAGE,
    );
    expect(getProjectPathValidationMessage("C:\\")).toBe(
      PROJECT_PATH_ROOT_MESSAGE,
    );
    expect(getProjectPathValidationMessage("relative/path")).toBe(
      INVALID_PROJECT_PATH_MESSAGE,
    );
    expect(getProjectPathValidationMessage("C:Users\\michael\\bb")).toBe(
      INVALID_PROJECT_PATH_MESSAGE,
    );
    expect(getProjectPathValidationMessage("")).toBe(
      INVALID_PROJECT_PATH_MESSAGE,
    );
    expect(getProjectPathValidationMessage(uncProjectPath)).toBe(
      UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE,
    );
    expect(getProjectPathValidationMessage("//server/share/bb")).toBe(
      UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE,
    );
    expect(
      getProjectPathValidationMessage("\\\\?\\C:\\Users\\michael\\bb"),
    ).toBe(UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE);
  });

  it("names both accepted path shapes when refusing a UNC path", () => {
    expect(UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE).toBe(
      "UNC and device paths (\\\\server\\share, //server/share) are not supported. Use an absolute path on the machine, such as /home/me/repo or C:\\Users\\me\\repo.",
    );
  });
});
