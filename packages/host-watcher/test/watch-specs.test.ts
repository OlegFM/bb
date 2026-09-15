import { afterEach, describe, expect, it } from "vitest";
import { collectWorkspaceStatusChanges } from "../src/watch-specs.js";

const originalPlatform = process.platform;

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

afterEach(() => {
  stubPlatform(originalPlatform);
});

describe("collectWorkspaceStatusChanges on posix", () => {
  it("dedupes repeated events for the same path into one sorted entry", () => {
    stubPlatform("linux");

    const result = collectWorkspaceStatusChanges({
      events: [
        { path: "/work/bb/a.ts", type: "update" },
        { path: "/work/bb/a.ts", type: "update" },
      ],
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
