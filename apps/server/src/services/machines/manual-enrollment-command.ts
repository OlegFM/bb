import type { EnrollmentBootstrap } from "./enrollments.js";

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function manualEnrollmentCommand(
  bootstrap: EnrollmentBootstrap,
): string {
  const header = `X-BB-Enrollment: ${bootstrap.credential}`;
  const installerUrl = new URL("/install.sh", bootstrap.serverUrl).href;
  return `curl -fsSL -H ${quote(header)} ${quote(installerUrl)} | sh`;
}

function quotePowerShell(value: string): string {
  return "'" + value.replaceAll(/['\u2018-\u201b]/gu, "$&$&") + "'";
}

export function manualWindowsEnrollmentCommand(
  bootstrap: EnrollmentBootstrap,
): string {
  const installerUrl = new URL("/install.ps1", bootstrap.serverUrl).href;
  return [
    '$bbInstaller = Join-Path $env:TEMP ("bb-install-" + [guid]::NewGuid().ToString("N") + ".ps1")',
    "try {",
    `  Invoke-WebRequest -UseBasicParsing -Uri ${quotePowerShell(installerUrl)} -Headers @{'X-BB-Enrollment'=${quotePowerShell(bootstrap.credential)}} -OutFile $bbInstaller`,
    '  & "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $bbInstaller',
    '  if ($LASTEXITCODE -ne 0) { throw "Machine installer failed" }',
    "} finally {",
    "  Remove-Item -LiteralPath $bbInstaller -Force -ErrorAction SilentlyContinue",
    "}",
  ].join("\n");
}

export function enrolledInstallerScript(
  script: string,
  bootstrap: EnrollmentBootstrap,
): string {
  return `export BB_ENROLLMENT=${quote(JSON.stringify(bootstrap))}\nset -- --bootstrap-env BB_ENROLLMENT\n${script}`;
}

export function enrolledPowerShellInstallerScript(
  script: string,
  bootstrap: EnrollmentBootstrap,
): string {
  const parameterBlock = /^param\(\r?\n[\s\S]*?\r?\n\)\r?\n/u.exec(script)?.[0];
  if (parameterBlock === undefined) {
    throw new Error("PowerShell installer parameter block is missing");
  }
  const bootstrapJson = JSON.stringify(bootstrap).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${parameterBlock}$env:BB_ENROLLMENT = ${quotePowerShell(bootstrapJson)}\n$BootstrapEnv = 'BB_ENROLLMENT'\n${script.slice(parameterBlock.length)}`;
}
