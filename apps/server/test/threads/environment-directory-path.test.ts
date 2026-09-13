import { describe, expect, it } from "vitest";
import { validateEnvironmentDirectoryPath } from "../../src/services/threads/thread-environment-directory.js";

describe("validateEnvironmentDirectoryPath", () => {
  it("accepts absolute paths of both flavors", () => {
    expect(validateEnvironmentDirectoryPath("/srv/repo")).toBeNull();
    expect(validateEnvironmentDirectoryPath("C:\\Work\\bb")).toBeNull();
    expect(validateEnvironmentDirectoryPath("c:/work/bb")).toBeNull();
  });

  it("rejects relative, root, UNC and NUL paths", () => {
    expect(validateEnvironmentDirectoryPath("repo")).toMatch(/absolute/u);
    expect(validateEnvironmentDirectoryPath("/")).toMatch(/filesystem root/u);
    expect(validateEnvironmentDirectoryPath("C:\\")).toMatch(
      /filesystem root/u,
    );
    expect(validateEnvironmentDirectoryPath("\\\\server\\share\\repo")).toMatch(
      /UNC/u,
    );
    expect(validateEnvironmentDirectoryPath("/srv/re\0po")).toMatch(/NUL/u);
  });
});
