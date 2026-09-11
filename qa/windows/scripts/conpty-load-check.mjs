import { createRequire } from "node:module";
import { resolve } from "node:path";

const requireFromHostDaemon = createRequire(
  resolve(process.cwd(), "apps", "host-daemon", "package.json"),
);
const pty = requireFromHostDaemon("node-pty");
const watcher = requireFromHostDaemon("@parcel/watcher");
const BetterSqlite3 = createRequire(
  resolve(process.cwd(), "packages", "db", "package.json"),
)("better-sqlite3");

const db = new BetterSqlite3(":memory:");
db.close();
process.stdout.write(`better-sqlite3 ok (ABI ${process.versions.modules})\n`);
process.stdout.write(`@parcel/watcher ok (${typeof watcher.subscribe})\n`);

const shell = process.platform === "win32" ? "cmd.exe" : "sh";
const args = process.platform === "win32" ? ["/d", "/c", "echo conpty-ok"] : ["-c", "echo conpty-ok"];
const child = pty.spawn(shell, args, { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
let output = "";
child.onData((chunk) => {
  output += chunk;
});
child.onExit(({ exitCode }) => {
  const ok = output.includes("conpty-ok");
  process.stdout.write(
    `node-pty ${ok ? "ok" : "FAILED"} (exit ${exitCode}, pid ${child.pid})\n`,
    () => {
      process.exit(ok ? 0 : 1);
    },
  );
});
