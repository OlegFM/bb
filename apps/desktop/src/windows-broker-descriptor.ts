import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveWindowsSystemToolPath } from "@bb/process-utils";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const aclSchema = z.object({
  aces: z.array(
    z.object({
      accessType: z.string(),
      identity: z.string(),
      inherited: z.boolean(),
      inheritanceFlags: z.string(),
      propagationFlags: z.string(),
      rights: z.string(),
    }),
  ),
  contentBase64: z.string(),
  currentSid: z.string().regex(/^S-\d+(?:-\d+)+$/u),
  ownerSid: z.string().regex(/^S-\d+(?:-\d+)+$/u),
  protected: z.boolean(),
});
type BrokerDescriptorSecurity = z.infer<typeof aclSchema>;
const WINDOWS_BROKER_DESCRIPTOR_SHARE_MODE = 5;
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class BrokerDescriptorFile {
  [StructLayout(LayoutKind.Sequential)]
  private struct FileTime {
    public uint Low;
    public uint High;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FileInformation {
    public uint Attributes;
    public FileTime CreationTime;
    public FileTime AccessTime;
    public FileTime WriteTime;
    public uint VolumeSerialNumber;
    public uint SizeHigh;
    public uint SizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(
    string path, uint access, uint share, IntPtr security,
    uint disposition, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(
    SafeFileHandle handle, out FileInformation information);

  public static FileStream Open(string path) {
    SafeFileHandle handle = CreateFileW(path, 0x80000000, ${WINDOWS_BROKER_DESCRIPTOR_SHARE_MODE}, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
    if (handle.IsInvalid) {
      int code = Marshal.GetLastWin32Error();
      handle.Dispose();
      throw new Win32Exception(code);
    }
    try {
      FileInformation information;
      if (!GetFileInformationByHandle(handle, out information)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      if ((information.Attributes & 0x410) != 0) {
        throw new InvalidDataException("Invalid desktop broker descriptor file type");
      }
      return new FileStream(handle, FileAccess.Read);
    } catch {
      handle.Dispose();
      throw;
    }
  }
}
'@
Add-Type -TypeDefinition $source
$stream = [BrokerDescriptorFile]::Open($env:BB_BROKER_DESCRIPTOR_PATH)
try {
  if ($null -ne $stream.PSObject.Methods['GetAccessControl']) {
    $acl = $stream.GetAccessControl()
  } else {
    $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($stream)
  }
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($stream.Length -gt 16384) {
    throw 'Invalid desktop broker descriptor size'
  }
  $bytes = New-Object byte[] ([int]$stream.Length)
  $offset = 0
  while ($offset -lt $bytes.Length) {
    $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
    if ($read -eq 0) { throw 'Incomplete desktop broker descriptor' }
    $offset += $read
  }
  $aces = @($rules | ForEach-Object {
    [pscustomobject]@{
      identity = $_.IdentityReference.Value
      accessType = $_.AccessControlType.ToString()
      rights = $_.FileSystemRights.ToString()
      inherited = $_.IsInherited
      inheritanceFlags = $_.InheritanceFlags.ToString()
      propagationFlags = $_.PropagationFlags.ToString()
    }
  })
  [pscustomobject]@{
    aces = $aces
    contentBase64 = [Convert]::ToBase64String($bytes)
    currentSid = $sid
    ownerSid = $owner
    protected = $acl.AreAccessRulesProtected
  } | ConvertTo-Json -Compress -Depth 4
} finally {
  $stream.Dispose()
}
`;

export function assertWindowsBrokerDescriptorSecurity(
  security: BrokerDescriptorSecurity,
): void {
  const [ace] = security.aces;
  if (
    security.ownerSid !== security.currentSid ||
    !security.protected ||
    security.aces.length !== 1 ||
    ace?.identity !== security.currentSid ||
    ace.accessType !== "Allow" ||
    ace.rights !== "FullControl" ||
    ace.inherited ||
    ace.inheritanceFlags !== "None" ||
    ace.propagationFlags !== "None"
  ) {
    throw new Error("Invalid desktop broker descriptor permissions");
  }
}

export async function readWindowsBrokerDescriptor(
  path: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      resolveWindowsSystemToolPath("WindowsPowerShell\\v1.0\\powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, BB_BROKER_DESCRIPTOR_PATH: path },
        maxBuffer: 64 * 1024,
        timeout: 15_000,
        windowsHide: true,
      },
    );
    const security = aclSchema.parse(JSON.parse(stdout));
    assertWindowsBrokerDescriptorSecurity(security);
    const encoded = security.contentBase64;
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        encoded,
      )
    ) {
      throw new Error("Invalid desktop broker descriptor output");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > 16_384)
      throw new Error("Invalid desktop broker descriptor size");
    return bytes.toString("utf8");
  } catch {
    throw new Error("Invalid desktop broker descriptor permissions or content");
  }
}
