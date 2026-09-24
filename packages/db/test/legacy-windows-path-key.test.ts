import { afterAll, describe, expect, it } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { createConnection, migrate } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = resolve(here, "../drizzle");
const scratch = mkdtempSync(join(tmpdir(), "bb-windows-path-key-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function migrationFolder(name: string, legacy: boolean): string {
  const folder = join(scratch, name);
  const meta = join(folder, "meta");
  const journal = JSON.parse(
    readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8"),
  ) as {
    entries: Array<{
      idx: number;
      version: string;
      when: number;
      tag: string;
      breakpoints: boolean;
    }>;
  };
  const entries = journal.entries.slice(0, legacy ? 117 : 131);
  for (const entry of entries) {
    const source = join(drizzleDir, `${entry.tag}.sql`);
    const target = join(folder, `${entry.tag}.sql`);
    if (entry.idx === 0) {
      mkdirSync(meta, { recursive: true });
    }
    copyFileSync(source, target);
  }
  if (legacy) {
    entries.push({
      idx: 117,
      version: "6",
      when: 1789261268513,
      tag: "0117_path_key",
      breakpoints: true,
    });
    copyFileSync(
      join(here, "fixtures/legacy-0117_path_key.sql"),
      join(folder, "0117_path_key.sql"),
    );
  }
  writeFileSync(
    join(meta, "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  return folder;
}

function preparedDatabase(name: string, legacy: boolean) {
  const db = createConnection(join(scratch, `${name}.sqlite`));
  db.$client.exec(
    "CREATE TEMP TABLE bb_migration_local_host (id TEXT PRIMARY KEY)",
  );
  drizzleMigrate(db, {
    migrationsFolder: migrationFolder(`${name}-migrations`, legacy),
  });
  db.$client.exec(`
    INSERT INTO hosts (id, name, type, created_at, updated_at)
    VALUES ('host_win', 'Windows', 'persistent', 1000, 1000);
    INSERT INTO projects (id, name, sort_key, created_at, updated_at)
    VALUES ('project_win', 'Windows', 'a0', 1000, 1000);
  `);
  return db;
}

function seedPathRows(
  db: ReturnType<typeof createConnection>,
  legacy: boolean,
): void {
  db.$client.exec(`
    INSERT INTO environments (id, project_id, host_id, path, ${legacy ? "path_key," : ""} status, created_at, updated_at)
    VALUES ('environment_win', 'project_win', 'host_win', 'C:\\Repo', ${legacy ? "'c:/repo'," : ""} 'ready', 1000, 1000);
    INSERT INTO project_sources (id, project_id, type, host_id, path, ${legacy ? "path_key," : ""} is_default, created_at, updated_at)
    VALUES ('source_win', 'project_win', 'local_path', 'host_win', 'C:\\Repo', ${legacy ? "'c:/repo'," : ""} 1, 1000, 1000);
  `);
}

describe("Windows path-key migration history", () => {
  it("upgrades an upstream 0130 database with path-key backfill", () => {
    const db = preparedDatabase("upstream-0130", false);
    try {
      seedPathRows(db, false);
      migrate(db);
      const row = db.$client
        .prepare(
          "SELECT path_key AS pathKey FROM environments WHERE id = 'environment_win'",
        )
        .get();
      expect(row).toEqual({ pathKey: "C:\\Repo" });
      expect(
        db.$client
          .prepare(
            "SELECT path_key AS pathKey FROM project_sources WHERE id = 'source_win'",
          )
          .get(),
      ).toEqual({ pathKey: "C:\\Repo" });
    } finally {
      db.$client.close();
    }
  });

  it("upgrades exact legacy Windows 0117 and retains canonical keys", () => {
    const db = preparedDatabase("legacy-0117", true);
    try {
      seedPathRows(db, true);
      migrate(db);
      expect(
        db.$client
          .prepare(
            "SELECT path_key AS pathKey FROM environments WHERE id = 'environment_win'",
          )
          .get(),
      ).toEqual({ pathKey: "c:/repo" });
      expect(
        db.$client
          .prepare(
            "SELECT path_key AS pathKey FROM project_sources WHERE id = 'source_win'",
          )
          .get(),
      ).toEqual({ pathKey: "c:/repo" });
      const timestamps = db.$client
        .prepare(
          "SELECT created_at AS createdAt FROM __drizzle_migrations WHERE created_at >= 1789081162875 ORDER BY created_at",
        )
        .all() as Array<{ createdAt: number }>;
      expect(timestamps.some((row) => row.createdAt === 1789261268513)).toBe(
        false,
      );
      expect(timestamps.some((row) => row.createdAt === 1789081162875)).toBe(
        true,
      );
      expect(timestamps.some((row) => row.createdAt === 1790189317552)).toBe(
        true,
      );
    } finally {
      db.$client.close();
    }
  });

  it("rolls back legacy repair when upstream migration fails", () => {
    const db = preparedDatabase("legacy-rollback", true);
    try {
      seedPathRows(db, true);
      db.$client.exec(
        "CREATE TABLE environment_hook_operations (id text PRIMARY KEY)",
      );
      const priorLedger = db.$client
        .prepare(
          "SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at",
        )
        .all();
      expect(() => migrate(db)).toThrow(
        /environment_hook_operations.*already exists/u,
      );
      expect(
        db.$client
          .prepare(
            "SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at",
          )
          .all(),
      ).toEqual(priorLedger);
      expect(
        db.$client
          .prepare(
            "SELECT path_key AS pathKey FROM environments WHERE id = 'environment_win'",
          )
          .get(),
      ).toEqual({ pathKey: "c:/repo" });
      expect(
        db.$client
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'environments_live_path_key_idx'",
          )
          .get(),
      ).toBeDefined();
      expect(
        db.$client
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_model_catalogs'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      db.$client.close();
    }
  });
});
