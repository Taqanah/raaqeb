# Raaqeb's smoke test on Windows, run by hand on a real Windows
# machine in PowerShell. From the folder holding raaqeb-windows-x64.exe or
# raaqeb-windows-arm64.exe, SHA256SUMS and install.ps1:
#
#   powershell -ExecutionPolicy Bypass -File .\smoke-windows.ps1
#       the binary alone
#   powershell -ExecutionPolicy Bypass -File .\smoke-windows.ps1 -Install
#       as Administrator: then the installer, its task and its uninstall,
#       which leaves nothing behind
#
# Every check prints PASS or FAIL; the last line is the result to paste back.
param([switch] $Install)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$script:passed = 0
$script:failed = 0

function Check([string] $name, [scriptblock] $test) {
  $ok = $false
  $detail = ''
  try {
    $ok = [bool] (& $test)
  } catch {
    $detail = " ($($_.Exception.Message))"
  }
  if ($ok) {
    $script:passed++
    Write-Host "PASS $name"
  } else {
    $script:failed++
    Write-Host "FAIL $name$detail"
  }
}

function Info([string] $message) {
  Write-Host "INFO $message"
}

# The HTTP status of a GET, redirects not followed; curl.exe ships with Windows 10 1803 and later.
function StatusOf([string] $url) {
  curl.exe -s -o NUL -w '%{http_code}' $url
}

# Waits up to the seconds given for /health at the port to answer 200.
function WaitHealth([int] $port, [int] $seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if ((StatusOf "http://127.0.0.1:$port/health") -eq '200') {
      return $true
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function FreePort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = $listener.LocalEndpoint.Port
  $listener.Stop()
  return $port
}

# Ctrl+C to serve alone: a helper in a hidden console of its own attaches to
# serve's console, ignores the event itself and sends it there, so neither
# this script nor the console it runs in receives it.
function SendCtrlC([int] $id) {
  $helper = @"
Add-Type -Namespace RaaqebSmoke -Name Console -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool FreeConsole(); [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint id); [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add); [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint group);'
[RaaqebSmoke.Console]::FreeConsole() | Out-Null
if (-not [RaaqebSmoke.Console]::AttachConsole($id)) { exit 2 }
[RaaqebSmoke.Console]::SetConsoleCtrlHandler([IntPtr]::Zero, `$true) | Out-Null
[RaaqebSmoke.Console]::GenerateConsoleCtrlEvent(0, 0) | Out-Null
Start-Sleep -Seconds 2
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($helper))
  Start-Process powershell -ArgumentList '-NoProfile', '-EncodedCommand', $encoded -WindowStyle Hidden -Wait
}

# Starts serve in a hidden console of its own, as a console program runs, with its output in files; the handle is read at once, so the exit code can be.
function StartServe([string] $exe, [string] $dir, [string] $log) {
  $process = Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Hidden -PassThru -WorkingDirectory $dir -RedirectStandardOutput "$log.out" -RedirectStandardError "$log.err"
  $null = $process.Handle
  return $process
}

$machine = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment').PROCESSOR_ARCHITECTURE
$arch = if ($machine -eq 'ARM64') { 'arm64' } else { 'x64' }
$file = "raaqeb-windows-$arch.exe"
$exe = Join-Path $PSScriptRoot $file
Info "$([Environment]::OSVersion.VersionString), $machine, PowerShell $($PSVersionTable.PSVersion), $file"

# The binary: its checksum and the Mark of the Web a browser download carries.
Check 'the binary matches SHA256SUMS' {
  $line = Get-Content (Join-Path $PSScriptRoot 'SHA256SUMS') | Where-Object { $_ -match "  $([regex]::Escape($file))$" }
  $line -and ($line.Substring(0, 64) -eq (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant())
}
if (Get-Item -LiteralPath $exe -Stream Zone.Identifier -ErrorAction SilentlyContinue) {
  Info 'the binary carries the Mark of the Web (a browser download); unblocking it'
  Unblock-File -LiteralPath $exe
} else {
  Info 'the binary carries no Mark of the Web'
}

# A free port and a data directory, named with backslashes and a drive
# letter, holding an empty SQLite file, which serve migrates, so the
# write-ahead log exists while it runs.
$port = FreePort
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('raaqeb-smoke-' + [Guid]::NewGuid())
$data = Join-Path $tmp 'data'
New-Item -ItemType Directory -Path $data | Out-Null
New-Item -ItemType File -Path (Join-Path $data 'raaqeb.sqlite') | Out-Null
$env:RAAQEB_DATA_DIR = $data
$env:RAAQEB_PORT = "$port"
$wal = Join-Path $data 'raaqeb.sqlite-wal'
$shm = Join-Path $data 'raaqeb.sqlite-shm'

$server = StartServe $exe $tmp (Join-Path $tmp 'first')
Check 'serve answers /health within 60 seconds' { WaitHealth $port 60 }
Check '/health reports the database and the scheduler ok' { (curl.exe -s "http://127.0.0.1:$port/health") -match '"ok":true' }
Check '/ sends a fresh install to onboarding' { (StatusOf "http://127.0.0.1:$port/") -eq '307' }
$page = (curl.exe -s "http://127.0.0.1:$port/onboarding") -join "`n"
Check 'the onboarding page renders in Arabic, right to left' { $page -match 'dir="rtl"' }
$asset = [regex]::Match($page, '/assets/[^"]+\.js').Value
Check 'an embedded client asset answers 200' { $asset -and (StatusOf "http://127.0.0.1:$port$asset") -eq '200' }
Check '/admin sends a fresh install to onboarding' { (StatusOf "http://127.0.0.1:$port/admin") -eq '307' }
Check 'raaqeb health exits 0' { & $exe health | Out-Null; $LASTEXITCODE -eq 0 }
Check 'the write-ahead log exists while serve runs' { Test-Path -LiteralPath $wal }

# Task Scheduler ends a task by killing it: the next start must recover.
Stop-Process -Id $server.Id -Force
$server.WaitForExit(30000) | Out-Null
Check 'a hard kill leaves the write-ahead log for the next start' { Test-Path -LiteralPath $wal }
$server = StartServe $exe $tmp (Join-Path $tmp 'second')
Check 'serve starts again after a hard kill and answers /health' { WaitHealth $port 60 }
Check 'the data the first run wrote survived the kill' { (StatusOf "http://127.0.0.1:$port/") -eq '307' }

SendCtrlC $server.Id
$stopped = $server.WaitForExit(30000)
Check 'Ctrl+C stops serve within 30 seconds' { $stopped }
if (-not $stopped) {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
Check 'Ctrl+C stops serve with exit 0' { $stopped -and $server.ExitCode -eq 0 }
Check 'serve logged its stop' { (Get-Content (Join-Path $tmp 'second.out') -Raw) -match 'raaqeb: stopping' }
Check 'the stop checkpointed the write-ahead log' { -not (Test-Path -LiteralPath $wal) }
Check 'the stop left no shared-memory file' { -not (Test-Path -LiteralPath $shm) }
Check 'the data directory holds config.json, raaqeb.sqlite and snapshots alone' {
  ((Get-ChildItem -LiteralPath $data -Force | Sort-Object Name | ForEach-Object Name) -join ' ') -eq 'config.json raaqeb.sqlite snapshots'
}
Remove-Item env:RAAQEB_DATA_DIR, env:RAAQEB_PORT
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

if ($Install) {
  $admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $bin = Join-Path $env:ProgramFiles 'Raaqeb\raaqeb.exe'
  $root = Join-Path $env:ProgramData 'Raaqeb'
  if (-not $admin) {
    Check 'the install test runs as Administrator' { $false }
  } elseif (Get-ScheduledTask -TaskName Raaqeb -ErrorAction SilentlyContinue) {
    Check 'no Raaqeb task is here before the test (uninstall it first)' { $false }
  } elseif ((StatusOf 'http://127.0.0.1:3000/') -ne '000') {
    Check 'port 3000 is free for the installed task' { $false }
  } else {
    Info 'installing; the uninstall at the end removes everything'
    $env:RAAQEB_DOWNLOAD_URL = $PSScriptRoot
    $installer = Join-Path $PSScriptRoot 'install.ps1'
    # As an operator runs it: the script's text through iex.
    powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (Get-Content -Raw -LiteralPath '$installer')"
    $installed = $LASTEXITCODE -eq 0
    Remove-Item env:RAAQEB_DOWNLOAD_URL
    Check 'install.ps1 installs and starts the task' { $installed }
    Check 'the task is running' { (Get-ScheduledTask -TaskName Raaqeb).State -eq 'Running' }
    Check 'the installed Raaqeb answers /health' { WaitHealth 3000 60 }
    Push-Location $root
    Check 'raaqeb health exits 0' { & $bin health | Out-Null; $LASTEXITCODE -eq 0 }
    Pop-Location
    $process = Get-CimInstance Win32_Process -Filter "Name='raaqeb.exe'" | Select-Object -First 1
    Check 'the task runs the binary itself as Local Service' {
      $process -and $process.ExecutablePath -eq $bin -and (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid -eq 'S-1-5-19'
    }
    Check 'C:\ProgramData\Raaqeb, which holds the data directory, is open to Local Service, SYSTEM and the Administrators alone, nothing inherited' {
      $acl = Get-Acl -LiteralPath $root
      $sids = $acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique
      $acl.AreAccessRulesProtected -and (($sids -join ' ') -eq 'S-1-5-18 S-1-5-19 S-1-5-32-544')
    }
    # Local Service's rights on a path, as one text such as 'ReadAndExecute, Synchronize'.
    function LocalServiceRights([string] $path) {
      ((Get-Acl -LiteralPath $path).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-19' } | ForEach-Object { $_.FileSystemRights.ToString() }) -join '; '
    }
    Check 'C:\ProgramData\Raaqeb is owned by the Administrators' { (Get-Acl -LiteralPath $root).GetOwner([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-32-544' }
    Check 'Local Service may read C:\ProgramData\Raaqeb and .env, never write them' {
      $folder = LocalServiceRights $root
      $dotenv = LocalServiceRights (Join-Path $root '.env')
      $folder -match 'ReadAndExecute' -and $dotenv -match 'ReadAndExecute' -and "$folder $dotenv" -notmatch 'Write|Modify|FullControl'
    }
    Check 'Local Service may write in the data directory' { (LocalServiceRights (Join-Path $root 'data')) -match 'Modify' }
    Check 'Local Service generated the install key into the data directory' { Test-Path -LiteralPath (Join-Path $root 'data\config.json') }
    Stop-Process -Id $process.ProcessId -Force
    Check 'the task starts Raaqeb again within two minutes of a kill' { WaitHealth 3000 120 }
    Check 'the new process is another one' {
      $again = Get-CimInstance Win32_Process -Filter "Name='raaqeb.exe'" | Select-Object -First 1
      $again -and $again.ProcessId -ne $process.ProcessId
    }

    # The uninstall, line for line as website/content/docs/operate/uninstall.en.mdx gives it (scripts/install.test.ts holds them equal).
    Disable-ScheduledTask Raaqeb; Stop-ScheduledTask Raaqeb; Unregister-ScheduledTask Raaqeb -Confirm:$false
    Get-Process raaqeb -ErrorAction SilentlyContinue | Wait-Process -Timeout 30
    Remove-Item -Recurse "$env:ProgramFiles\Raaqeb"
    Remove-Item -Recurse "$env:ProgramData\Raaqeb"
    Check 'after the uninstall no task is left' { -not (Get-ScheduledTask -TaskName Raaqeb -ErrorAction SilentlyContinue) }
    Check 'after the uninstall no raaqeb process runs' { -not (Get-Process -Name raaqeb -ErrorAction SilentlyContinue) }
    Check 'after the uninstall no folder is left' { -not (Test-Path (Join-Path $env:ProgramFiles 'Raaqeb')) -and -not (Test-Path $root) }
  }
}

if ($script:failed -eq 0) {
  Write-Host "RESULT: PASS ($script:passed checks)"
} else {
  Write-Host "RESULT: FAIL ($script:failed of $($script:passed + $script:failed) checks failed)"
  exit 1
}
