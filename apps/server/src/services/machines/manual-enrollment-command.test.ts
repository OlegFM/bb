import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  enrolledInstallerScript,
  enrolledPowerShellInstallerScript,
  manualEnrollmentCommand,
  manualWindowsEnrollmentCommand,
} from "./manual-enrollment-command.js";
import type { EnrollmentBootstrap } from "./enrollments.js";

const bootstrap: EnrollmentBootstrap = {
  hostId: "host_test",
  credential: "short-lived-code",
  serverUrl: "https://test.getbb.app",
  expiresAt: Date.now() + 60_000,
  headers: { "x-access": "private'$value" },
};

it.skipIf(process.platform === "win32")(
  "passes the exact bootstrap and arguments to the installer without shell expansion",
  () => {
    const script = enrolledInstallerScript(
      'printf "%s\\n%s\\n%s" "$1" "$2" "$BB_ENROLLMENT"',
      bootstrap,
    );
    const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `--bootstrap-env\nBB_ENROLLMENT\n${JSON.stringify(bootstrap)}`,
    );
  },
);

it("builds the transient curl command from the enrollment bootstrap", () => {
  expect(manualEnrollmentCommand(bootstrap)).toBe(
    "curl -fsSL -H 'X-BB-Enrollment: short-lived-code' 'https://test.getbb.app/install.sh' | sh",
  );
});

it("builds a Windows command using the private installer route", () => {
  const command = manualWindowsEnrollmentCommand(bootstrap);
  expect(command).toContain("https://test.getbb.app/install.ps1");
  expect(command).toContain("X-BB-Enrollment");
  expect(command).toContain("short-lived-code");
  expect(command).toContain("Remove-Item -LiteralPath $bbInstaller");
});

it("doubles PowerShell apostrophe variants in enrollment values", () => {
  const command = manualWindowsEnrollmentCommand({
    ...bootstrap,
    credential: "private'\u2019token",
  });
  expect(command).toContain("private''\u2019\u2019token");
});

it("passes a private bundle into the PowerShell installer after its parameter block", () => {
  const script = enrolledPowerShellInstallerScript(
    "param(\n  [string]$BootstrapEnv\n)\nWrite-Output $BootstrapEnv",
    bootstrap,
  );
  expect(script).toContain(
    `$env:BB_ENROLLMENT = '${JSON.stringify(bootstrap).replaceAll("'", "''")}'`,
  );
  expect(script).toContain("$BootstrapEnv = 'BB_ENROLLMENT'");
});

it.skipIf(process.platform !== "win32")(
  "round trips a Unicode bootstrap through a BOM-less Windows PowerShell 5.1 script file",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-bootstrap-encoding-"));
    const scriptPath = join(directory, "bootstrap.ps1");
    const outputPath = join(directory, "value.txt");
    const value = "private\u2019привет😀";
    const script = enrolledPowerShellInstallerScript(
      "param(\n  [string]$BootstrapEnv\n)\n$bundle = [Environment]::GetEnvironmentVariable($BootstrapEnv, 'Process') | ConvertFrom-Json\n$utf8 = New-Object System.Text.UTF8Encoding($false)\n[System.IO.File]::WriteAllText($env:BB_OUTPUT_PATH, $bundle.headers.'x-access', $utf8)",
      { ...bootstrap, headers: { "x-access": value } },
    );
    try {
      expect(Buffer.from(script, "utf8").every((byte) => byte < 128)).toBe(
        true,
      );
      writeFileSync(scriptPath, script, "utf8");
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-File", scriptPath],
        {
          encoding: "utf8",
          env: { ...process.env, BB_OUTPUT_PATH: outputPath },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toBe(value);
    } finally {
      if (existsSync(outputPath)) unlinkSync(outputPath);
      if (existsSync(scriptPath)) unlinkSync(scriptPath);
      rmdirSync(directory);
    }
  },
);
