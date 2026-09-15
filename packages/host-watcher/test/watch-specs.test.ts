import { describe, expect, it } from "vitest";
import { collectWorkspaceStatusChanges } from "../src/watch-specs.js";

describe("collectWorkspaceStatusChanges on posix", () => {
  it("dedupes repeated events for the same path into one sorted entry", () => {
    const result = collectWorkspaceStatusChanges({
      events: [
        { path: "/work/bb/a.ts", type: "update" },
        { path: "/work/bb/a.ts", type: "update" },
      ],
      platform: "linux",
      spec: {
        kind: "workspace-root",
        rootPath: "/work/bb",
      },
    });

    expect(result).toEqual({
      changedPaths: ["/work/bb/a.ts"],
      changeKinds: ["workspace-content-changed"],
    });
  });
});
