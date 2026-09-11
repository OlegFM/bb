import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const runsDir = resolve(process.argv[2] ?? join(process.cwd(), ".turbo", "runs"));
const latest = readdirSync(runsDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => join(runsDir, name))
  .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];

if (latest === undefined) {
  throw new Error(`No Turbo run summaries under ${runsDir}`);
}

const summary = JSON.parse(readFileSync(latest, "utf8"));
const rows = summary.tasks
  .filter((task) => task.task === "test")
  .map((task) => {
    const exitCode = task.execution?.exitCode;
    const state = exitCode === 0 ? "pass" : exitCode === undefined ? "skipped" : `fail (${exitCode})`;
    return `| ${task.package} | ${state} |`;
  })
  .sort();

process.stdout.write(
  ["| package | test task |", "|---|---|", ...rows, "", `Source: ${latest}`, ""].join("\n"),
);
