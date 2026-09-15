import { describe, expect, it } from "vitest";
import {
  dedupeWatchPathChanges,
  isExtendedLengthWindowsPath,
  isWatchPathWithinRoot,
  joinWatchedEntry,
  normalizeWatchEventPath,
  toWatchRootRelativeKey,
} from "../src/watch-event-path.js";

describe("watch event paths on win32", () => {
  it("resolves relative event paths against the watched root", () => {
    expect(
      normalizeWatchEventPath("C:\\work\\repo", "src\\file.ts", "win32"),
    ).toBe("C:\\work\\repo\\src\\file.ts");
  });

  it("normalizes forward slashes and dot segments in absolute events", () => {
    expect(
      normalizeWatchEventPath(
        "C:\\work\\repo",
        "C:/work/repo/sub/../file.ts",
        "win32",
      ),
    ).toBe("C:\\work\\repo\\file.ts");
  });

  it("leaves extended-length event paths untouched", () => {
    const extendedPath = "\\\\?\\C:\\very\\long\\sub\\..\\file.ts";
    expect(
      normalizeWatchEventPath("C:\\work\\repo", extendedPath, "win32"),
    ).toBe(extendedPath);
  });

  it("joins relative events under an extended-length root without normalizing", () => {
    const root = "\\\\?\\C:\\very\\long\\repo";
    expect(normalizeWatchEventPath(root, "sub\\file.ts", "win32")).toBe(
      "\\\\?\\C:\\very\\long\\repo\\sub\\file.ts",
    );
  });

  it("does not join absolute events onto an extended-length root", () => {
    expect(
      normalizeWatchEventPath(
        "\\\\?\\C:\\very\\long\\repo",
        "C:\\very\\long\\repo\\file.ts",
        "win32",
      ),
    ).toBe("C:\\very\\long\\repo\\file.ts");
  });

  it("trims a trailing separator on an extended-length drive root before joining", () => {
    expect(normalizeWatchEventPath("\\\\?\\C:\\", "a.ts", "win32")).toBe(
      "\\\\?\\C:\\a.ts",
    );
  });

  it("treats same paths with different case as within root", () => {
    expect(
      isWatchPathWithinRoot("C:\\Work\\bb", "c:\\work\\bb\\SRC\\a.ts", "win32"),
    ).toBe(true);
  });

  it("accepts an extended-length candidate under a plain root", () => {
    expect(
      isWatchPathWithinRoot("C:\\Work\\bb", "\\\\?\\C:\\Work\\bb\\x", "win32"),
    ).toBe(true);
  });

  it("rejects siblings, other drives and parent escapes", () => {
    expect(
      isWatchPathWithinRoot("C:\\Work\\Repo", "C:\\Work\\Repo2\\x", "win32"),
    ).toBe(false);
    expect(
      isWatchPathWithinRoot("C:\\Work\\Repo", "D:\\Work\\Repo\\x", "win32"),
    ).toBe(false);
    expect(
      isWatchPathWithinRoot("C:\\Work\\Repo", "C:\\Work\\Repo\\..\\x", "win32"),
    ).toBe(false);
  });

  it("rejects a plain candidate that escapes an extended-length root via ..", () => {
    expect(
      isWatchPathWithinRoot(
        "\\\\?\\C:\\Work\\bb",
        "C:\\Work\\bb\\..\\evil\\x",
        "win32",
      ),
    ).toBe(false);
  });

  it("rejects an extended-length candidate that escapes a plain root via ..", () => {
    expect(
      isWatchPathWithinRoot(
        "C:\\Work\\bb",
        "\\\\?\\C:\\Work\\bb\\..\\evil\\x",
        "win32",
      ),
    ).toBe(false);
  });

  it("emits forward-slash relative keys for windows candidates", () => {
    expect(
      toWatchRootRelativeKey(
        "C:\\Work\\bb",
        "c:\\work\\bb\\SRC\\a.ts",
        "win32",
      ),
    ).toBe("SRC/a.ts");
  });

  it("strips an extended-length prefix from the candidate before keying", () => {
    expect(
      toWatchRootRelativeKey("C:\\Work\\bb", "\\\\?\\C:\\Work\\bb\\x", "win32"),
    ).toBe("x");
  });

  it("strips an extended-length prefix from the root before keying", () => {
    expect(
      toWatchRootRelativeKey("\\\\?\\C:\\Work\\bb", "C:\\Work\\bb\\x", "win32"),
    ).toBe("x");
  });

  it("returns an empty key when the candidate equals an extended-length root", () => {
    expect(
      toWatchRootRelativeKey("C:\\Work\\bb", "\\\\?\\C:\\Work\\bb", "win32"),
    ).toBe("");
  });

  it("dedupes windows update events that differ only by case, keeping the first", () => {
    const changes = dedupeWatchPathChanges(
      [
        { path: "C:\\W\\a.ts", type: "update" },
        { path: "c:\\w\\A.TS", type: "update" },
      ],
      "win32",
    );
    expect(changes).toEqual([{ path: "C:\\W\\a.ts", type: "update" }]);
  });

  it("keeps distinct change types for the same case-folded path", () => {
    const changes = dedupeWatchPathChanges(
      [
        { path: "C:\\work\\repo\\FILE.ts", type: "update" },
        { path: "c:\\WORK\\repo\\file.ts", type: "create" },
      ],
      "win32",
    );
    expect(changes).toHaveLength(2);
  });

  it("joins a windows-absolute directory with backslashes", () => {
    expect(joinWatchedEntry("C:\\dir", "x")).toBe("C:\\dir\\x");
  });
});

describe("watch event paths on posix", () => {
  it("resolves relatives and normalizes absolute events", () => {
    expect(normalizeWatchEventPath("/work/repo", "src/file.ts", "linux")).toBe(
      "/work/repo/src/file.ts",
    );
    expect(
      normalizeWatchEventPath("/work/repo", "/work/repo/a/../b.ts", "linux"),
    ).toBe("/work/repo/b.ts");
  });

  it("treats a windows-shaped extended-length prefix as an ordinary relative segment", () => {
    expect(normalizeWatchEventPath("/work/bb", "\\\\?\\x", "linux")).toBe(
      "/work/bb/\\\\?\\x",
    );
  });

  it("is case-sensitive and rejects siblings that differ only by case", () => {
    expect(isWatchPathWithinRoot("/work/bb", "/work/BB/a.ts", "linux")).toBe(
      false,
    );
  });

  it("returns the input array unchanged, by reference, on posix", () => {
    const changes = [
      { path: "/work/repo/FILE.ts", type: "update" },
      { path: "/work/repo/FILE.ts", type: "update" },
    ];
    const result = dedupeWatchPathChanges(changes, "linux");
    expect(result).toBe(changes);
    expect(result).toHaveLength(2);
  });

  it("detects extended-length windows paths only by prefix", () => {
    expect(isExtendedLengthWindowsPath("\\\\?\\C:\\x")).toBe(true);
    expect(isExtendedLengthWindowsPath("\\\\.\\C:\\x")).toBe(true);
    expect(isExtendedLengthWindowsPath("C:\\x")).toBe(false);
    expect(isExtendedLengthWindowsPath("\\\\server\\share")).toBe(false);
  });

  it("joins a posix-absolute directory with forward slashes", () => {
    expect(joinWatchedEntry("/dir", "x")).toBe("/dir/x");
  });
});
