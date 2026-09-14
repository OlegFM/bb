import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirHostPath,
  moveHostPath,
  removeHostPath,
} from "./path-mutations.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-path-mutations-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("confined host path mutations", () => {
  it("creates, moves, and removes paths beneath the declared root", async () => {
    const root = await makeRoot();
    const folder = path.join(root, "projects");
    await expect(
      mkdirHostPath({
        type: "host.mkdir",
        path: folder,
        rootPath: root,
        recursive: false,
      }),
    ).resolves.toEqual({ ok: true });
    const source = path.join(folder, "draft.md");
    const destination = path.join(folder, "plan.md");
    await fs.writeFile(source, "# Plan");
    await expect(
      moveHostPath({
        type: "host.move_path",
        sourcePath: source,
        destinationPath: destination,
        rootPath: root,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("# Plan");
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: destination,
        rootPath: root,
        recursive: false,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.stat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates missing parent directories when recursive is enabled", async () => {
    const root = await makeRoot();
    const nested = path.join(root, "projects", "archive", "2026");
    await expect(
      mkdirHostPath({
        type: "host.mkdir",
        path: nested,
        rootPath: root,
        recursive: true,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.stat(nested)).resolves.toMatchObject({});
  });

  it("removes empty directories non-recursively and requires recursive for non-empty directories", async () => {
    const root = await makeRoot();
    const empty = path.join(root, "empty");
    await fs.mkdir(empty);
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: empty,
        rootPath: root,
        recursive: false,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.stat(empty)).rejects.toMatchObject({ code: "ENOENT" });

    const nonEmpty = path.join(root, "non-empty");
    await fs.mkdir(nonEmpty);
    await fs.writeFile(path.join(nonEmpty, "note.md"), "# Note");
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: nonEmpty,
        rootPath: root,
        recursive: false,
      }),
    ).rejects.toThrow();
    await expect(fs.stat(nonEmpty)).resolves.toMatchObject({});
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: nonEmpty,
        rootPath: root,
        recursive: true,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.stat(nonEmpty)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlink escapes and refuses to remove the declared root", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const link = path.join(root, "outside");
    await fs.symlink(outside, link);
    const escaped = path.join(link, "secret.md");
    await fs.writeFile(path.join(outside, "secret.md"), "secret");

    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: escaped,
        rootPath: root,
        recursive: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: root,
        rootPath: root,
        recursive: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  describe.runIf(process.platform === "win32")("junctions", () => {
    it("refuses to remove a file reached through a junction that leaves the root", async () => {
      const root = await makeRoot();
      const outside = await makeRoot();
      const link = path.join(root, "outside");
      await fs.symlink(outside, link, "junction");
      await fs.writeFile(path.join(outside, "secret.md"), "secret");

      await expect(
        removeHostPath({
          type: "host.remove_path",
          path: path.join(link, "secret.md"),
          rootPath: root,
          recursive: false,
        }),
      ).rejects.toMatchObject({ code: "invalid_path" });
      await expect(
        fs.readFile(path.join(outside, "secret.md"), "utf8"),
      ).resolves.toBe("secret");
    });

    it("refuses to move a junction and leaves its target untouched", async () => {
      const root = await makeRoot();
      const outside = await makeRoot();
      const link = path.join(root, "outside");
      await fs.symlink(outside, link, "junction");
      await fs.writeFile(path.join(outside, "secret.md"), "secret");

      const info = await fs.lstat(link);
      expect(info.isSymbolicLink()).toBe(true);
      expect(info.isDirectory()).toBe(false);

      await expect(
        moveHostPath({
          type: "host.move_path",
          sourcePath: link,
          destinationPath: path.join(root, "moved"),
          rootPath: root,
        }),
      ).rejects.toMatchObject({ code: "invalid_path" });
      await expect(fs.readdir(outside)).resolves.toEqual(["secret.md"]);
      await expect(fs.readdir(root)).resolves.toEqual(["outside"]);
    });

    it("refuses a junction substituted for a working directory and removes only the resolved path when the junction stays inside the root", async () => {
      const root = await makeRoot();
      const outside = await makeRoot();
      await fs.writeFile(path.join(outside, "keep.md"), "keep");
      await fs.writeFile(path.join(outside, "target.md"), "target");
      const substituted = path.join(root, "workdir");
      await fs.symlink(outside, substituted, "junction");

      await expect(
        removeHostPath({
          type: "host.remove_path",
          path: path.join(substituted, "target.md"),
          rootPath: root,
          recursive: false,
        }),
      ).rejects.toMatchObject({ code: "invalid_path" });
      await expect(fs.readdir(outside)).resolves.toEqual([
        "keep.md",
        "target.md",
      ]);

      const inside = path.join(root, "real");
      await fs.mkdir(inside);
      await fs.writeFile(path.join(inside, "keep.md"), "keep");
      await fs.writeFile(path.join(inside, "target.md"), "target");
      const insideLink = path.join(root, "insidelink");
      await fs.symlink(inside, insideLink, "junction");

      await expect(
        removeHostPath({
          type: "host.remove_path",
          path: path.join(insideLink, "target.md"),
          rootPath: root,
          recursive: false,
        }),
      ).resolves.toEqual({ ok: true });
      await expect(fs.readdir(inside)).resolves.toEqual(["keep.md"]);
      expect((await fs.lstat(insideLink)).isSymbolicLink()).toBe(true);
    });
  });

  it("does not overwrite a move destination", async () => {
    const root = await makeRoot();
    const source = path.join(root, "source.md");
    const destination = path.join(root, "destination.md");
    await fs.writeFile(source, "source");
    await fs.writeFile(destination, "destination");

    await expect(
      moveHostPath({
        type: "host.move_path",
        sourcePath: source,
        destinationPath: destination,
        rootPath: root,
      }),
    ).rejects.toMatchObject({ code: "path_exists" });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("destination");
  });
});
