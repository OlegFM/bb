import { describe, expect, it } from "vitest";
import {
  buildAbsoluteFilePath,
  getAbsoluteDirname,
  isAbsoluteFilePath,
  isAbsoluteFilePathWithinRoot,
  normalizeAbsoluteFilePath,
  resolveAbsoluteFilePath,
} from "./absolute-file-path";

describe("isAbsoluteFilePath", () => {
  it.each([
    ["/Users/me/repo/README.md", true],
    ["/", true],
    ["///x", true],
    ["C:\\Users\\me\\repo", true],
    ["c:/Users/me/repo", true],
    ["C:\\", true],
    ["C:", false],
    ["c:", false],
    ["C:Users\\me", false],
    ["//srv/x", true],
    ["\\\\server\\share\\README.md", false],
    ["\\\\?\\C:\\Users\\me", false],
    ["docs/README.md", false],
    ["", false],
  ])("classifies %s the way @bb/domain does", (path, expected) => {
    expect(isAbsoluteFilePath(path)).toBe(expected);
  });

  it("produces no normalized path for a bare drive or a UNC path", () => {
    expect(normalizeAbsoluteFilePath({ path: "C:" })).toBeNull();
    expect(normalizeAbsoluteFilePath({ path: "\\\\srv\\share\\x" })).toBeNull();
  });

  it("collapses repeated leading separators in POSIX paths", () => {
    expect(normalizeAbsoluteFilePath({ path: "//srv/x" })).toBe("/srv/x");
    expect(normalizeAbsoluteFilePath({ path: "///x" })).toBe("/x");
  });
});

describe("getAbsoluteDirname", () => {
  it.each([
    ["/storage/thr_1/current/summary.md", "/storage/thr_1/current"],
    ["/README.md", "/"],
    ["/storage/thr_1/", "/storage"],
  ])("resolves the parent of %s", (path, expected) => {
    expect(getAbsoluteDirname({ path })).toBe(expected);
  });
});

describe("normalizeAbsoluteFilePath", () => {
  it("normalizes dot segments in absolute file paths", () => {
    expect(
      normalizeAbsoluteFilePath({
        path: "/Users/me/project/docs/../README.md",
      }),
    ).toBe("/Users/me/project/README.md");
  });

  it("rejects relative file paths", () => {
    expect(normalizeAbsoluteFilePath({ path: "docs/README.md" })).toBeNull();
  });
});

describe("isAbsoluteFilePathWithinRoot", () => {
  it("accepts normalized paths inside the root", () => {
    expect(
      isAbsoluteFilePathWithinRoot({
        candidatePath: "/Users/me/project/docs/../README.md",
        rootPath: "/Users/me/project/",
      }),
    ).toBe(true);
  });

  it("rejects normalized paths outside the root", () => {
    expect(
      isAbsoluteFilePathWithinRoot({
        candidatePath: "/Users/me/project/../../.ssh/id_rsa",
        rootPath: "/Users/me/project",
      }),
    ).toBe(false);
  });

  it("does not confuse sibling roots with matching prefixes", () => {
    expect(
      isAbsoluteFilePathWithinRoot({
        candidatePath: "/Users/me/project-copy/README.md",
        rootPath: "/Users/me/project",
      }),
    ).toBe(false);
  });
});

describe("windows absolute file paths", () => {
  it("normalizes drive paths and resolves dot segments", () => {
    expect(
      normalizeAbsoluteFilePath({ path: "c:/Users/me/../me/repo/./file.ts" }),
    ).toBe("C:\\Users\\me\\repo\\file.ts");
    expect(normalizeAbsoluteFilePath({ path: "C:\\" })).toBe("C:\\");
    expect(
      normalizeAbsoluteFilePath({ path: "\\\\server\\share\\file" }),
    ).toBeNull();
    expect(normalizeAbsoluteFilePath({ path: "repo\\file" })).toBeNull();
  });

  it("checks containment case-insensitively within a Windows root", () => {
    expect(
      isAbsoluteFilePathWithinRoot({
        candidatePath: "c:/users/ME/repo/src/a.ts",
        rootPath: "C:\\Users\\me\\repo",
      }),
    ).toBe(true);
    expect(
      isAbsoluteFilePathWithinRoot({
        candidatePath: "C:\\Users\\me\\repo2\\a.ts",
        rootPath: "C:\\Users\\me\\repo",
      }),
    ).toBe(false);
    expect(
      isAbsoluteFilePathWithinRoot({
        candidatePath: "/Users/me/repo/a.ts",
        rootPath: "C:\\Users\\me\\repo",
      }),
    ).toBe(false);
  });

  it("builds and resolves paths under a Windows root", () => {
    expect(
      buildAbsoluteFilePath({
        path: "src/a.ts",
        rootPath: "C:\\Users\\me\\repo\\",
      }),
    ).toBe("C:\\Users\\me\\repo\\src\\a.ts");
    expect(
      resolveAbsoluteFilePath({
        path: "C:\\other\\b.ts",
        rootPath: "C:\\Users\\me\\repo",
      }),
    ).toBe("C:\\other\\b.ts");
    expect(getAbsoluteDirname({ path: "C:\\Users\\me\\repo\\a.ts" })).toBe(
      "C:\\Users\\me\\repo",
    );
    expect(getAbsoluteDirname({ path: "C:\\a.ts" })).toBe("C:\\");
  });
});
