param([string]$Installer, [string]$FixtureDirectory, [switch]$DenyTask, [switch]$DenyAcl, [switch]$FolderOnly, [int]$BystanderPid, [string]$JunctionTarget, [string]$JoinCode, [string]$HostId, [string]$Server, [string]$MachineCode, [string]$HostDaemonPort)
$ErrorActionPreference = 'Stop'
function Write-FixtureJson {
  param([string]$LiteralPath, [Parameter(ValueFromPipeline = $true)][string]$Value)
  process { [System.IO.File]::WriteAllText($LiteralPath, $Value, (New-Object System.Text.UTF8Encoding($false))) }
}
function Start-Process {
  [CmdletBinding()]
  param($FilePath, $ArgumentList, [switch]$NoNewWindow, [switch]$Wait, [switch]$PassThru)
  $result = Microsoft.PowerShell.Management\Start-Process @PSBoundParameters
  if ($BystanderPid -gt 0 -and $ArgumentList.Contains('node:child_process')) { $null = $result.Handle; $result.WaitForExit(); [System.IO.File]::WriteAllText((Join-Path $env:BB_DATA_DIR 'install-supervisor.pid'), (@{ pid = $BystanderPid; startTime = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json)) }
  $result
}
function Get-Acl {
  param($LiteralPath)
  if ($DenyAcl -and (Split-Path -Leaf $LiteralPath) -like 'config.json.*.tmp') {
    [System.IO.FileInfo]$file = Get-Item -LiteralPath $LiteralPath
    [System.IO.File]::WriteAllText((Join-Path $FixtureDirectory 'failed-acl-length'), "$($file.Length)")
    throw 'ACL privacy setup denied'
  }
  Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath
}
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, $Uri, $Headers, $OutFile, [switch]$PassThru, $TimeoutSec, $MaximumRedirection)
  Microsoft.PowerShell.Utility\Invoke-WebRequest -UseBasicParsing -Uri ($env:BB_FIXTURE_ORIGIN + ([uri]$Uri).AbsolutePath) -Headers $Headers -OutFile $OutFile -PassThru -TimeoutSec $TimeoutSec -MaximumRedirection $MaximumRedirection
}
function Invoke-RestMethod {
  param($Uri, $Method = 'Get', $ContentType, $Body, $TimeoutSec)
  if (([uri]$Uri).AbsolutePath -eq '/api/connect/redeem-machine') {
    @{ uri = $Uri; body = $Body } | ConvertTo-Json | Write-FixtureJson -LiteralPath (Join-Path $FixtureDirectory 'redeem.json')
    Microsoft.PowerShell.Utility\Invoke-RestMethod -Uri ($env:BB_FIXTURE_ORIGIN + '/api/connect/redeem-machine') -Method $Method -ContentType $ContentType -Body $Body -TimeoutSec $TimeoutSec
  } else { Microsoft.PowerShell.Utility\Invoke-RestMethod -Uri $Uri -TimeoutSec $TimeoutSec }
}
function New-ScheduledTaskAction { param($Execute, $Argument) @{ Execute = $Execute; Arguments = $Argument } }
function Get-ScheduledTask {
  param($TaskName)
  $path = Join-Path $FixtureDirectory 'task.json'
  if (Test-Path -LiteralPath $path) { $task = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json; @{ Actions = @($task.Action) } }
}
function Get-ItemProperty {
  param($Path, $Name)
  $record = Join-Path $FixtureDirectory 'run.json'
  if (Test-Path -LiteralPath $record) { $run = Get-Content -LiteralPath $record -Raw -Encoding UTF8 | ConvertFrom-Json; $value = New-Object PSObject; $value | Add-Member -NotePropertyName $Name -NotePropertyValue $run.Value; $value }
}
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User) @{ User = $User } }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) @{ UserId = $UserId; RunLevel = $RunLevel } }
function New-ScheduledTaskSettingsSet { param([switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, $ExecutionTimeLimit) @{} }
function Register-ScheduledTask {
  param($TaskName, $Action, $Trigger, $Principal, $Settings, [switch]$Force)
  if ($DenyTask) { throw 'Task registration denied' }
  @{ TaskName = $TaskName; Action = $Action; Principal = $Principal } | ConvertTo-Json -Depth 8 | Write-FixtureJson -LiteralPath (Join-Path $FixtureDirectory 'task.json')
}
function Unregister-ScheduledTask { param($TaskName, [switch]$Confirm) Remove-Item -LiteralPath (Join-Path $FixtureDirectory 'task.json') -ErrorAction SilentlyContinue }
function New-ItemProperty {
  param($Path, $Name, $Value, $PropertyType, [switch]$Force)
  if (-not (Test-Path -LiteralPath (Join-Path $FixtureDirectory 'run-key'))) { throw 'Run key does not exist' }
  @{ Name = $Name; Value = $Value } | ConvertTo-Json | Write-FixtureJson -LiteralPath (Join-Path $FixtureDirectory 'run.json')
}
function Remove-ItemProperty { param($Path, $Name) Remove-Item -LiteralPath (Join-Path $FixtureDirectory 'run.json') -ErrorAction SilentlyContinue }
function Test-Path {
  param($LiteralPath, $Path, $PathType)
  if ($Path -eq 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run') { return (Microsoft.PowerShell.Management\Test-Path -LiteralPath (Join-Path $FixtureDirectory 'run-key')) }
  $query = @{}
  if ($LiteralPath) { $query.LiteralPath = $LiteralPath } else { $query.Path = $Path }
  if ($PathType) { $query.PathType = $PathType }
  Microsoft.PowerShell.Management\Test-Path @query
}
function New-Item {
  param($Path, [switch]$Force)
  if ($Path -ne 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run') { throw 'Unexpected fixture registry key' }
  [System.IO.File]::WriteAllText((Join-Path $FixtureDirectory 'run-key'), '')
}
if ($FolderOnly) {
  [System.IO.Directory]::CreateDirectory($env:BB_DATA_DIR) | Out-Null
  $initialAcl = Get-Acl -LiteralPath $env:BB_DATA_DIR
  $initialAcl.SetAccessRuleProtection($true, $false)
  $initialAcl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow')))
  Microsoft.PowerShell.Security\Set-Acl -LiteralPath $env:BB_DATA_DIR -AclObject $initialAcl
}
$beforeData = $env:BB_DATA_DIR
$beforePrefix = $env:BB_APP_NPM_PREFIX
$beforeJunctionAcl = if ($JunctionTarget) { (Get-Acl -LiteralPath $JunctionTarget).Sddl } else { '' }
$installerParams = @{ JoinCode = $JoinCode; HostId = $HostId; Server = $Server }
if ($MachineCode) { $installerParams.MachineCode = $MachineCode }
if ($HostDaemonPort) { $installerParams.HostDaemonPort = $HostDaemonPort }
$global:LASTEXITCODE = 0
try { & $Installer @installerParams; $status = $LASTEXITCODE }
finally {
  if ($JunctionTarget) { @{ before = $beforeJunctionAcl; after = (Get-Acl -LiteralPath $JunctionTarget).Sddl } | ConvertTo-Json | Write-FixtureJson -LiteralPath (Join-Path $FixtureDirectory 'junction-acl.json') }
  @{ data = ($beforeData -eq $env:BB_DATA_DIR); prefix = ($beforePrefix -eq $env:BB_APP_NPM_PREFIX) } | ConvertTo-Json | Write-FixtureJson -LiteralPath (Join-Path $FixtureDirectory 'environment.json')
  $config = Join-Path $env:BB_DATA_DIR 'config.json'
  if (Test-Path -LiteralPath $config) {
    $acl = Get-Acl -LiteralPath $config
    @{ protected = $acl.AreAccessRulesProtected; rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }); user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } | ConvertTo-Json | Write-FixtureJson -LiteralPath (Join-Path $FixtureDirectory 'acl.json')
  }
}
exit $status
