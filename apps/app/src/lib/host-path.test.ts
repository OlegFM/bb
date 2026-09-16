import { describe, expect, it } from "vitest";
import {
  hostPathBasename,
  hostPathSegments,
  isWindowsAbsolutePath,
} from "./host-path";

describe("host paths", () => {
  it("recognises drive-absolute and UNC paths as Windows paths", () => {
    expect(isWindowsAbsolutePath("C:\\Users\\olege\\notes.md")).toBe(true);
    expect(isWindowsAbsolutePath("c:/Users/olege/notes.md")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\notes.md")).toBe(true);
    expect(isWindowsAbsolutePath("/home/olege/notes.md")).toBe(false);
    expect(isWindowsAbsolutePath("src/notes.md")).toBe(false);
    expect(isWindowsAbsolutePath("C:notes.md")).toBe(false);
  });

  it("splits Windows paths on either separator", () => {
    expect(hostPathSegments("C:\\Users\\olege\\src\\app.ts")).toEqual([
      "C:",
      "Users",
      "olege",
      "src",
      "app.ts",
    ]);
    expect(hostPathSegments("C:/Users/olege/src/app.ts")).toEqual([
      "C:",
      "Users",
      "olege",
      "src",
      "app.ts",
    ]);
  });

  it("splits every other path on forward slashes exactly as before", () => {
    expect(hostPathSegments("/home/olege/src/app.ts")).toEqual([
      "",
      "home",
      "olege",
      "src",
      "app.ts",
    ]);
    expect(hostPathSegments("src/weird\\name.ts")).toEqual([
      "src",
      "weird\\name.ts",
    ]);
  });

  it("returns the last segment as the file name", () => {
    expect(hostPathBasename("C:\\Users\\olege\\notes.md")).toBe("notes.md");
    expect(hostPathBasename("/home/olege/notes.md")).toBe("notes.md");
    expect(hostPathBasename("notes.md")).toBe("notes.md");
    expect(hostPathBasename("")).toBe("");
  });
});
