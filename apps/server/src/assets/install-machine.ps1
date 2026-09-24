param(
  [string]$BootstrapEnv,
  [string]$HostDaemonPort,
  [Alias('h')][switch]$Help
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$completed = $false
$joinProcess = $null
$reservation = $null
$reservationCreated = $false
$lock = $null
$download = $null
$oldData = $env:BB_DATA_DIR
$oldPrefix = $env:BB_APP_NPM_PREFIX

function Quote-Literal([string]$Value) { "'" + [regex]::Replace($Value, "['\u2018-\u201b]", '$0$0') + "'" }

function Quote-Native([string]$Value) {
  '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Require-LocalPath([string]$Value) {
  if ($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value -match '[\x00-\x1f"%]' -or $Value.Substring(2).Contains(':')) { throw 'Data must use an absolute drive-local path without device paths, streams, quotes, percent signs or control characters.' }
  $full = [System.IO.Path]::GetFullPath($Value)
  if ($full.TrimEnd('\', '/') -eq [System.IO.Path]::GetPathRoot($full).TrimEnd('\', '/')) { throw 'Drive-root data paths are unsupported.' }
  $current = $full
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      if ((Get-Item -LiteralPath $current -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Data paths through reparse points are unsupported.' }
    }
    $current = [System.IO.Path]::GetDirectoryName($current)
  }
  $full.TrimEnd('\')
}

function Set-PrivateAcl([string]$Path, [bool]$Directory) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = Get-Acl -LiteralPath $Path
  $currentRules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  if ($acl.AreAccessRulesProtected -and $currentRules.Count -eq 1 -and $currentRules[0].IdentityReference.Value -eq $sid.Value -and $currentRules[0].AccessControlType -eq 'Allow' -and $currentRules[0].FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and (-not $Directory -or ($currentRules[0].InheritanceFlags -eq $inheritance -and $currentRules[0].PropagationFlags -eq 'None'))) { return }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($existing in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) { if ($existing.IdentityReference.Value -ne $sid.Value) { $acl.RemoveAccessRuleAll($existing) } }
  if ($Directory) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  } else {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetAccessRule($rule)
  $item = Get-Item -LiteralPath $Path -Force
  if ($PSVersionTable.PSEdition -eq 'Core') { [System.IO.FileSystemAclExtensions]::SetAccessControl($item, $acl) }
  else { $item.SetAccessControl($acl) }
  $actual = Get-Acl -LiteralPath $Path
  $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or ($Directory -and ($rules[0].InheritanceFlags -ne $inheritance -or $rules[0].PropagationFlags -ne 'None'))) { throw "Could not verify user-only ACL for $Path. Use an NTFS volume." }
}

function Write-Private([string]$Path, [string]$Value) {
  $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  $stream = $null
  try {
    $stream = [System.IO.File]::Open($temporary, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    Set-PrivateAcl $temporary $false
    $bytes = $utf8.GetBytes($Value)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null
    Move-Item -LiteralPath $temporary -Destination $Path -Force
    Set-PrivateAcl $Path $false
  } finally { if ($stream) { $stream.Dispose() }; if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Native([string[]]$Arguments) {
  $process = Start-Process -FilePath $node -ArgumentList (($Arguments | ForEach-Object { Quote-Native $_ }) -join ' ') -NoNewWindow -PassThru
  $null = $process.Handle
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw "Node command failed with exit $($process.ExitCode)." }
}

function Matches-Status([int]$Port, [bool]$Connected) {
  try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -TimeoutSec 2
    $remote = [uri]$status.serverUrl
    return ($status.hostId -ceq $HostId -and $remote.AbsoluteUri.TrimEnd('/') -ceq $origin -and (-not $Connected -or $status.connected -eq $true))
  } catch { return $false }
}

function Port-Free([int]$Port) {
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
  try { $listener.Start(); return $true } catch { return $false } finally { $listener.Stop() }
}

function Claim-Port([int]$Port) {
  $path = Join-Path $registry "$Port"
  try {
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $bytes = $utf8.GetBytes($data); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    Set-PrivateAcl $path $false
    $script:reservation = $path
    $script:reservationCreated = $true
    return $true
  } catch [System.IO.IOException] {
    if ((Test-Path -LiteralPath $path) -and [System.IO.File]::ReadAllText($path) -ceq $data) { $script:reservation = $path; $script:reservationCreated = $false; return $true }
    return $false
  }
}

function Release-Port {
  if ($reservation -and (Test-Path -LiteralPath $reservation) -and [System.IO.File]::ReadAllText($reservation) -ceq $data) { Remove-Item -LiteralPath $reservation -Force }
  $script:reservation = $null
  $script:reservationCreated = $false
}

function Valid-Port([string]$Value) { $Value -match '^[1-9][0-9]{0,4}$' -and [int]$Value -le 65535 -and [int]$Value -ne 38887 }

function Supervisor-Active {
  $path = Join-Path $data 'supervisor.lock'
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  try {
    $probe = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $probe.Dispose()
    return $false
  } catch [System.IO.IOException] { return $true }
}

function Stop-OwnedTree([System.Diagnostics.Process]$Process) {
  if ($Process.HasExited) { return }
  $null = $Process.Handle
  $owned = New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
  function Collect-Children([System.Diagnostics.Process]$Parent) {
    $start = $Parent.StartTime.ToUniversalTime()
    foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($Parent.Id)")) {
      try {
        $held = [System.Diagnostics.Process]::GetProcessById([int]$child.ProcessId)
        $null = $held.Handle
        if ($held.StartTime.ToUniversalTime() -ge $start -and [Math]::Abs(($held.StartTime.ToUniversalTime() - $child.CreationDate.ToUniversalTime()).TotalMilliseconds) -lt 1) { $owned.Add($held); Collect-Children $held }
      } catch [System.ArgumentException] {} catch [System.InvalidOperationException] {}
    }
  }
  Collect-Children $Process
  if (-not $Process.HasExited) { $Process.Kill(); $Process.WaitForExit(5000) | Out-Null }
  foreach ($child in $owned) { if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit(5000) | Out-Null } }
}

function Wait-Connected {
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ((Test-Path -LiteralPath $authPath) -and (Matches-Status $port $true)) {
      $auth = [System.IO.File]::ReadAllText($authPath) | ConvertFrom-Json
      if ($auth.hostId -ceq $HostId) { return }
    }
    if ($joinProcess -and $joinProcess.HasExited) { throw "Host daemon exited before connecting. See $data\logs\host-daemon.log and $data\logs\supervisor.log." }
    Start-Sleep -Milliseconds 500
  }
  throw "Timed out waiting for host $HostId to connect to $origin. See $data\logs."
}

try {
  if ($Help) { Write-Output 'Usage: install.ps1 -BootstrapEnv <NAME> [-HostDaemonPort <1-65535, except Desktop 38887>]'; exit 0 }
  if ($BootstrapEnv -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw 'BootstrapEnv must name an environment variable.' }
  $bootstrapRaw = [Environment]::GetEnvironmentVariable($BootstrapEnv, 'Process')
  if (-not $bootstrapRaw) { throw 'Bootstrap environment variable is empty.' }
  try { $bootstrap = $bootstrapRaw | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Invalid machine enrollment bootstrap.' }
  if ($bootstrap.hostId -isnot [string] -or $bootstrap.serverUrl -isnot [string] -or $bootstrap.credential -isnot [string] -or $bootstrap.expiresAt -isnot [long] -and $bootstrap.expiresAt -isnot [double]) { throw 'Invalid machine enrollment bootstrap.' }
  $HostId = [string]$bootstrap.hostId
  $Server = [string]$bootstrap.serverUrl
  if ($HostId -notmatch '^[A-Za-z0-9._-]+$' -or -not $bootstrap.credential -or [double]$bootstrap.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { throw 'Invalid or expired machine enrollment bootstrap.' }
  $url = $null
  if (-not [uri]::TryCreate($Server, [UriKind]::Absolute, [ref]$url) -or $url.Scheme -notin @('http', 'https') -or $url.UserInfo -or $url.Query -or $url.Fragment -or $url.AbsolutePath -ne '/' -or $url.HostNameType -eq 'Unknown') { throw 'Server must be an HTTP(S) URL origin without credentials, path, query or fragment.' }
  $origin = $url.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
  if ($HostDaemonPort -and -not (Valid-Port $HostDaemonPort)) { throw 'HostDaemonPort must be an integer between 1 and 65535, except Desktop port 38887.' }
  $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
  Native @('-e', 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<19)){console.error("Node 22.19 or newer is required");process.exit(1)}')
  $userRoot = Require-LocalPath $env:USERPROFILE
  $hash = [System.Security.Cryptography.SHA256]::Create()
  try { $slug = ([BitConverter]::ToString($hash.ComputeHash($utf8.GetBytes($origin)))).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
  $data = if ($oldData) { Require-LocalPath $oldData } else { Require-LocalPath (Join-Path $userRoot ".bb-machines\$slug") }
  [System.IO.Directory]::CreateDirectory($data) | Out-Null
  Set-PrivateAcl $data $true
  $lock = [System.IO.File]::Open((Join-Path $data 'install.lock'), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  [System.IO.Directory]::CreateDirectory((Join-Path $data 'logs')) | Out-Null
  $prefix = Join-Path $data 'npm'
  $authPath = Join-Path $data 'auth.json'
  $configPath = Join-Path $data 'config.json'
  if (Test-Path -LiteralPath $authPath) {
    Set-PrivateAcl $authPath $false
    $auth = [System.IO.File]::ReadAllText($authPath) | ConvertFrom-Json
    if ($auth.hostId -cne $HostId -or -not (Test-Path -LiteralPath $configPath)) { throw 'Data contains an incompatible enrollment for a different host.' }
    Set-PrivateAcl $configPath $false
    $config = [System.IO.File]::ReadAllText($configPath) | ConvertFrom-Json
    if (([uri]$config.serverUrl).AbsoluteUri.TrimEnd('/') -cne $origin) { throw 'Data contains an incompatible enrollment for a different server.' }
  } elseif (Test-Path -LiteralPath $configPath) {
    Set-PrivateAcl $configPath $false
    $config = [System.IO.File]::ReadAllText($configPath) | ConvertFrom-Json
    if ($config.serverUrl -and ([uri]$config.serverUrl).AbsoluteUri.TrimEnd('/') -cne $origin) { throw 'Data contains configuration for a different server.' }
  }
  $registry = Require-LocalPath (Join-Path $userRoot '.bb-machines\host-daemon-ports')
  [System.IO.Directory]::CreateDirectory($registry) | Out-Null
  Set-PrivateAcl $registry $true
  $portPath = Join-Path $data 'host-daemon-port'
  $stored = if (Test-Path -LiteralPath $portPath) { [System.IO.File]::ReadAllText($portPath).Trim() } else { '' }
  if ((Supervisor-Active) -and ($HostDaemonPort -and $HostDaemonPort -cne $stored -or -not (Valid-Port $stored))) { throw 'Stop the live supervisor before changing daemon ports or repairing port metadata.' }
  $port = 0
  $preferred = if ($HostDaemonPort) { $HostDaemonPort } else { $stored }
  if ($preferred -and (Valid-Port $preferred) -and (Claim-Port ([int]$preferred))) {
    if ((Port-Free ([int]$preferred)) -or (Matches-Status ([int]$preferred) $false)) { $port = [int]$preferred }
    else {
      if (Supervisor-Active) { throw 'An unrelated listener holds the live supervisor port. Preserve its metadata and stop the verified supervisor before repairing.' }
      Release-Port
      if ($HostDaemonPort) { throw 'Requested daemon port is already in use by an unrelated listener.' }
    }
  } elseif ($HostDaemonPort) { throw 'Requested daemon port is reserved by another enrollment.' }
  if (-not $port) {
    if (Supervisor-Active) { throw 'The live supervisor cannot retain its port reservation. Preserve its metadata and stop the verified supervisor before repairing.' }
    for ($candidate = 38888; $candidate -le 65535; $candidate++) {
      if (Claim-Port $candidate) {
        if (Port-Free $candidate) { $port = $candidate; break }
        Release-Port
      }
    }
  }
  if (-not $port) { throw 'No available daemon port.' }
  Write-Private $portPath "$port"
  if ((Valid-Port $stored) -and [int]$stored -ne $port) {
    $previousReservation = Join-Path $registry $stored
    if ((Test-Path -LiteralPath $previousReservation) -and [System.IO.File]::ReadAllText($previousReservation) -ceq $data) { Remove-Item -LiteralPath $previousReservation -Force }
  }
  $packageRoot = Join-Path $prefix 'node_modules\bb-app'
  $entry = Join-Path $packageRoot 'dist\bb-app.js'
  $digestPath = Join-Path $data 'host-artifact.sha256'
  $complete = (Test-Path -LiteralPath $entry) -and (Test-Path -LiteralPath (Join-Path $packageRoot 'dist\bb.js')) -and (Test-Path -LiteralPath (Join-Path $packageRoot 'host-daemon\dist\daemon-bundle.mjs'))
  $digest = if ($complete -and (Test-Path -LiteralPath $digestPath)) { [System.IO.File]::ReadAllText($digestPath).Trim() } else { '' }
  $headers = @{}
  if ($digest -match '^[a-f0-9]{64}$') { $headers['If-None-Match'] = '"sha256-' + $digest + '"' }
  $download = Join-Path $data ('bb-app.' + [guid]::NewGuid().ToString('N') + '.tgz')
  $response = $null
  try { $response = Invoke-WebRequest -UseBasicParsing -Uri "$origin/install/bb-app.tgz" -Headers $headers -OutFile $download -PassThru -TimeoutSec 300 -MaximumRedirection 0 }
  catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 304 -and $digest -match '^[a-f0-9]{64}$') { $response = @{ StatusCode = 304 } }
    else { throw 'The server host artifact is unavailable. No registry fallback is allowed.' }
  }
  if ([int]$response.StatusCode -eq 304 -and $digest -match '^[a-f0-9]{64}$') { Write-Output 'The identical server host artifact is already installed.' }
  elseif ([int]$response.StatusCode -eq 200) {
    $expected = [string]$response.Headers['x-bb-artifact-sha256']
    if ($expected -notmatch '^[a-fA-F0-9]{64}$') { throw 'The server host artifact is missing its required SHA-256 header.' }
    $actual = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $expected.ToLowerInvariant()) { throw 'The server host artifact failed SHA-256 verification.' }
    if ((Supervisor-Active) -and (-not $complete -or $digest -notmatch '^[a-f0-9]{64}$' -or $actual -cne $digest)) { throw 'A live supervisor owns this npm prefix. Stop its verified instance before changing or repairing the host artifact.' }
    if ($digest -match '^[a-f0-9]{64}$' -and $actual -cne $digest -and ((Supervisor-Active) -or (Matches-Status $port $false))) { throw 'A different host artifact is running. Stop this enrollment using its verified supervisor before updating.' }
    $npmEntry = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmEntry)) {
      $npmCommand = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source
      $npmEntry = Join-Path (Split-Path -Parent $npmCommand) 'node_modules\npm\bin\npm-cli.js'
    }
    if (-not (Test-Path -LiteralPath $npmEntry)) { throw 'Cannot find npm JavaScript entry. Install npm alongside Node.' }
    if (Test-Path -LiteralPath $digestPath) { Remove-Item -LiteralPath $digestPath -Force }
    Native @($npmEntry, 'install', '-g', '--allow-scripts=better-sqlite3,node-pty,@parcel/watcher', '--prefix', $prefix, $download)
    if (-not (Test-Path -LiteralPath $entry) -or -not (Test-Path -LiteralPath (Join-Path $packageRoot 'dist\bb.js')) -or -not (Test-Path -LiteralPath (Join-Path $packageRoot 'host-daemon\dist\daemon-bundle.mjs'))) { throw 'npm installed an incomplete host artifact.' }
    Native @('-e', 'const p=process.argv[1];try{require(p+"/node_modules/node-pty");require(p+"/node_modules/@parcel/watcher")}catch(e){console.error("Host native add-ons failed to load: "+e.message);process.exit(1)}', $packageRoot)
    Write-Private $digestPath $actual
  } else { throw 'Unexpected server host artifact response.' }
  $env:BB_DATA_DIR = $data
  $env:BB_APP_NPM_PREFIX = $prefix
  if (-not (Test-Path -LiteralPath $authPath)) {
    Native @((Join-Path $packageRoot 'dist\bb.js'), 'machine', 'enroll', '--bootstrap-env', $BootstrapEnv)
  }
  [Environment]::SetEnvironmentVariable($BootstrapEnv, $null, 'Process')
  $launcherPath = Join-Path $data 'start-host-daemon.ps1'
  $launcher = @"
param([string]`$BootstrapRunId)
`$ErrorActionPreference = 'Stop'
`$previousData = `$env:BB_DATA_DIR
`$previousPrefix = `$env:BB_APP_NPM_PREFIX
`$guard = `$null
try {
  `$env:BB_DATA_DIR = $(Quote-Literal $data)
  `$env:BB_APP_NPM_PREFIX = $(Quote-Literal $prefix)
  `$guard = [System.IO.File]::Open($(Quote-Literal (Join-Path $data 'supervisor.lock')), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  `$identity = @{ pid = `$PID; startTime = ([System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o')); runId = `$BootstrapRunId }
  [System.IO.File]::WriteAllText($(Quote-Literal (Join-Path $data 'supervisor.json')), (`$identity | ConvertTo-Json), (New-Object System.Text.UTF8Encoding(`$false)))
  while (`$true) {
    `$arguments = @($(Quote-Literal $entry), 'host-daemon')
    `$arguments += @('--auto-update', '--host-daemon-port', '$port', '--server-url', $(Quote-Literal $origin))
    `$previousErrors = `$ErrorActionPreference
    try {
      `$ErrorActionPreference = 'Continue'
      & $(Quote-Literal $node) @arguments *>> $(Quote-Literal (Join-Path $data 'logs\host-daemon.log'))
    } finally { `$ErrorActionPreference = `$previousErrors }
    if (-not (Test-Path -LiteralPath $(Quote-Literal $authPath))) { throw 'Enrollment failed before credentials were saved.' }
    Start-Sleep -Seconds 2
  }
} catch {
  [System.IO.File]::AppendAllText($(Quote-Literal (Join-Path $data 'logs\supervisor.log')), (`$_.Exception.Message + [Environment]::NewLine))
  throw
} finally {
  `$env:BB_DATA_DIR = `$previousData
  `$env:BB_APP_NPM_PREFIX = `$previousPrefix
  if (`$guard) { `$guard.Dispose() }
}
"@
  if (Supervisor-Active) {
    if (-not (Test-Path -LiteralPath $launcherPath) -or [System.IO.File]::ReadAllText($launcherPath) -cne $launcher) { throw 'A live supervisor uses a different launcher. Stop its verified instance before updating.' }
    Set-PrivateAcl $launcherPath $false
  } else { Write-Private $launcherPath ([string][char]0xfeff + $launcher) }
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $stopPath = Join-Path $data 'stop-host-daemon.ps1'
  $stopScript = @"
`$ErrorActionPreference = 'Stop'
function Stop-OwnedTree {
$((Get-Item Function:Stop-OwnedTree).ScriptBlock.ToString())
}
`$recordPath = $(Quote-Literal (Join-Path $data 'supervisor.json'))
if (-not (Test-Path -LiteralPath `$recordPath)) { throw 'No supervisor identity record. Inspect the matching daemon manually.' }
  `$record = [System.IO.File]::ReadAllText(`$recordPath) | ConvertFrom-Json
if ((`$record.pid -isnot [int] -and `$record.pid -isnot [long]) -or `$record.pid -le 0 -or `$record.pid -gt [int]::MaxValue -or (`$record.startTime -isnot [string] -and `$record.startTime -isnot [DateTime])) { throw 'Invalid supervisor identity record.' }
try { `$held = [System.Diagnostics.Process]::GetProcessById([int]`$record.pid) } catch [System.ArgumentException] { exit 0 }
`$null = `$held.Handle
`$expectedStart = if (`$record.startTime -is [DateTime]) { `$record.startTime.ToUniversalTime() } else { [DateTime]::Parse(`$record.startTime, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }
if (`$held.Path -ine $(Quote-Literal $powershell) -or `$held.StartTime.ToUniversalTime() -ne `$expectedStart) { throw 'Supervisor identity mismatch; no process was stopped.' }
Stop-OwnedTree `$held
"@
  Write-Private $stopPath ([string][char]0xfeff + $stopScript)
  $serviceName = 'bb-host-daemon-' + $slug
  $launchArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (Quote-Native $launcherPath)
  $runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $runValue = (Quote-Native $powershell) + ' ' + $launchArgs
  if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    $existingTasks = @(Get-ScheduledTask -TaskName $serviceName -ErrorAction SilentlyContinue)
    foreach ($existingTask in $existingTasks) {
      $existingActions = @($existingTask.Actions)
      if ($existingActions.Count -ne 1 -or $existingActions[0].Execute -ine $powershell -or $existingActions[0].Arguments -cne $launchArgs) { throw 'Scheduled Task belongs to another enrollment. Preserve its data and choose the matching BB_DATA_DIR.' }
    }
  }
  $existingRun = Get-ItemProperty -Path $runPath -Name $serviceName -ErrorAction SilentlyContinue
  if ($existingRun -and $existingRun.PSObject.Properties[$serviceName] -and $existingRun.PSObject.Properties[$serviceName].Value -cne $runValue) { throw 'HKCU Run belongs to another enrollment. Preserve its data and choose the matching BB_DATA_DIR.' }
  if (-not (Supervisor-Active) -and -not (Matches-Status $port $false)) {
    $spawnedAt = [DateTime]::UtcNow
    $runId = [guid]::NewGuid().ToString('N')
    $pidPath = Join-Path $data 'install-supervisor.pid'
    $startupPath = Join-Path $data ('start.' + $runId + '.ps1')
    $startup = @"
param([string]`$RunIdentity)
`$ErrorActionPreference = 'Stop'
function Quote-Native {
$((Get-Item Function:Quote-Native).ScriptBlock.ToString())
}
`$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $(Quote-Literal $launcherPath), '-BootstrapRunId', `$RunIdentity)
`$process = Start-Process -FilePath $(Quote-Literal $powershell) -ArgumentList ((`$arguments | ForEach-Object { Quote-Native `$_ }) -join ' ') -WindowStyle Hidden -PassThru
`$record = @{ pid = `$process.Id; startTime = `$process.StartTime.ToUniversalTime().ToString('o') }
[System.IO.File]::WriteAllText($(Quote-Literal $pidPath), (`$record | ConvertTo-Json), (New-Object System.Text.UTF8Encoding(`$false)))
"@
    Write-Private $startupPath ([string][char]0xfeff + $startup)
    $startupArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $startupPath, '-RunIdentity', $runId)
    try { Native (@('-e', 'const fs=require("node:fs"),{spawn}=require("node:child_process");const [exe,log,...args]=process.argv.slice(1);const fd=fs.openSync(log,"a");const child=spawn(exe,args,{windowsHide:true,stdio:["ignore",fd,fd]});child.once("error",e=>{console.error(e.message);process.exitCode=1});child.once("exit",code=>{process.exitCode=code===null?1:code});', $powershell, (Join-Path $data 'logs\supervisor.log')) + $startupArgs) }
    finally { if (Test-Path -LiteralPath $startupPath) { Remove-Item -LiteralPath $startupPath -Force } }
    $spawnRecord = [System.IO.File]::ReadAllText($pidPath) | ConvertFrom-Json
    if (($spawnRecord.pid -isnot [int] -and $spawnRecord.pid -isnot [long]) -or $spawnRecord.pid -le 0 -or $spawnRecord.pid -gt [int]::MaxValue) { throw 'New supervisor process identity could not be verified.' }
    $spawnedPid = [int]$spawnRecord.pid
    $candidate = [System.Diagnostics.Process]::GetProcessById($spawnedPid)
    $null = $candidate.Handle
    if ($candidate.Path -ine $powershell -or $candidate.StartTime.ToUniversalTime() -lt $spawnedAt -or $candidate.StartTime.ToUniversalTime() -ne ([DateTime]$spawnRecord.startTime).ToUniversalTime()) { throw 'New supervisor process identity could not be verified.' }
    $identityDeadline = [DateTime]::UtcNow.AddSeconds(10)
    $identityVerified = $false
    while ([DateTime]::UtcNow -lt $identityDeadline -and -not $candidate.HasExited) {
      $recordPath = Join-Path $data 'supervisor.json'
      if ((Supervisor-Active) -and (Test-Path -LiteralPath $recordPath)) {
        $record = [System.IO.File]::ReadAllText($recordPath) | ConvertFrom-Json
        if ($record.runId -ceq $runId -and $record.pid -eq $candidate.Id -and ([DateTime]$record.startTime).ToUniversalTime() -eq $candidate.StartTime.ToUniversalTime()) { $identityVerified = $true; break }
      }
      Start-Sleep -Milliseconds 100
    }
    if (-not $identityVerified) { throw 'New supervisor identity record could not be verified; no unowned process will be stopped.' }
    $joinProcess = $candidate
  }
  Wait-Connected
  Set-PrivateAcl $authPath $false
  Set-PrivateAcl $configPath $false
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $taskRegistered = $false
  try {
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $launchArgs
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $serviceName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    $taskRegistered = $true
  } catch { Write-Output 'Scheduled Task registration denied; using HKCU Run.' }
  if ($taskRegistered) { Remove-ItemProperty -Path $runPath -Name $serviceName -ErrorAction SilentlyContinue }
  else {
    Unregister-ScheduledTask -TaskName $serviceName -Confirm:$false -ErrorAction SilentlyContinue
    if (-not (Test-Path -Path $runPath)) { New-Item -Path $runPath -Force | Out-Null }
    New-ItemProperty -Path $runPath -Name $serviceName -Value $runValue -PropertyType String -Force | Out-Null
  }
  $completed = $true
  Write-Output "Host ready: $HostId at $origin`nDaemon: http://127.0.0.1:$port`nData: $data`nLauncher: $launcherPath`nService: $serviceName`nLogs: $data\logs\host-daemon.log; $data\logs\supervisor.log"
  Write-Output ('Uninstall startup: Unregister-ScheduledTask -TaskName ' + (Quote-Literal $serviceName) + ' -Confirm:$false -ErrorAction SilentlyContinue; Remove-ItemProperty -Path ' + (Quote-Literal $runPath) + ' -Name ' + (Quote-Literal $serviceName) + ' -ErrorAction SilentlyContinue')
  Write-Output ('Stop verified supervisor and descendants: & ' + (Quote-Literal $powershell) + ' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-Literal $stopPath))
  Write-Output ('Remove enrollment data after stopping: Remove-Item -LiteralPath ' + (Quote-Literal $data) + ' -Recurse -Force; Remove-Item -LiteralPath ' + (Quote-Literal $reservation) + ' -Force')
} catch {
  Write-Error ($_.Exception.Message + "`n" + $_.ScriptStackTrace) -ErrorAction Continue
  exit 1
} finally {
  if ($BootstrapEnv -match '^[A-Za-z_][A-Za-z0-9_]*$') { [Environment]::SetEnvironmentVariable($BootstrapEnv, $null, 'Process') }
  $env:BB_DATA_DIR = $oldData
  $env:BB_APP_NPM_PREFIX = $oldPrefix
  if (-not $completed -and $joinProcess -and -not $joinProcess.HasExited) { Stop-OwnedTree $joinProcess }
  if (-not $completed -and $reservationCreated) { Release-Port }
  if ($download -and (Test-Path -LiteralPath $download)) { Remove-Item -LiteralPath $download -Force }
  if ($lock) { $lock.Dispose() }
}
