import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workspaceGroups = ["apps", "packages", "plugins", "tests", "examples/plugins"];

function listVitestConfigs() {
  const configs = [];
  for (const group of workspaceGroups) {
    const groupDir = join(repoRoot, group);
    let entries;
    try {
      entries = readdirSync(groupDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const packageDir = join(groupDir, entry);
      if (!statSync(packageDir).isDirectory()) continue;
      for (const file of readdirSync(packageDir)) {
        if (/^vitest(\.[\w-]+)?\.config\.(ts|mts|js|mjs)$/u.test(file)) {
          configs.push(join(packageDir, file));
        }
      }
    }
  }
  return configs;
}

describe("vitest configs", () => {
  it("never hardcode a /tmp data directory", () => {
    const offenders = listVitestConfigs().filter((configPath) =>
      /["'`]\/tmp(\/|["'`])/u.test(readFileSync(configPath, "utf8")),
    );

    expect(offenders).toEqual([]);
  });
});
