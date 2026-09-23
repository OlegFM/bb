import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace.js";

type ReaddirFixture = {
  root: string | null;
  nested: string | null;
  entries: Dirent[];
  reads: string[];
};

const fixture = vi.hoisted((): ReaddirFixture => ({
  root: null,
  nested: null,
  entries: [],
  reads: [],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("node:fs/promises") & { default: typeof fs }
  >();
  return {
    ...actual,
    default: {
      ...actual.default,
      readdir: async (dir: string, options: { withFileTypes: true }) => {
        fixture.reads.push(dir);
        if (dir === fixture.root) {
          return [{ name: "many", isDirectory: () => true }];
        }
        if (dir === fixture.nested) {
          return fixture.entries;
        }
        return actual.default.readdir(dir, options);
      },
    },
  };
});

afterEach(() => {
  fixture.root = null;
  fixture.nested = null;
  fixture.entries = [];
  fixture.reads = [];
});

it("does not overflow the call stack merging a large subdirectory", async () => {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "bb-workspace-large-"),
  );
  try {
    fixture.root = folder;
    fixture.nested = path.join(folder, "many");
    const fileCount = 150_000;
    fixture.entries = Array.from(
      { length: fileCount },
      (_, index) =>
        ({ name: `f${index}.txt`, isDirectory: () => false }) as Dirent,
    );

    const files = await new Workspace(folder).listFiles();

    expect(fixture.reads).toEqual([folder, fixture.nested]);
    expect(files).toHaveLength(fileCount);
    expect(files).toContain("many/f0.txt");
    expect(files).toContain(`many/f${fileCount - 1}.txt`);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
