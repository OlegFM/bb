import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

export function windowsSystemToolPath(env, name) {
  return join(env.SystemRoot ?? "C:\\Windows", "System32", name);
}

export function taskkillTree(pid) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      windowsSystemToolPath(process.env, "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    child.once("error", () => resolvePromise());
    child.once("exit", () => resolvePromise());
  });
}

export function taskkillTreeSync(pid) {
  try {
    spawnSync(
      windowsSystemToolPath(process.env, "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { stdio: "ignore" },
    );
  } catch {}
}
