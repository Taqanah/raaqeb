# Raaqeb's installer for Windows. Run in
# PowerShell as Administrator:
#
#   irm https://raaqeb.dev/install.ps1 | iex
#
# It downloads the latest stable release's binary and SHA256SUMS from
# https://github.com/Taqanah/raaqeb/releases, both from one release. Two
# variables change that: RAAQEB_VERSION, such as 1.2.3-beta.1, names the
# release to install (a pre-release is never the latest), and
# RAAQEB_DOWNLOAD_URL, which wins over it, is the folder holding the
# binaries and SHA256SUMS, a URL or a local folder. It picks the binary for
# this machine, checks it against SHA256SUMS, installs it as
# C:\Program Files\Raaqeb\raaqeb.exe,
# creates C:\ProgramData\Raaqeb, owned by the Administrators and open to
# them and SYSTEM, with Local Service reading it and writing only in its data
# directory, data, and the env file .env in it, and registers the
# Raaqeb task: the binary itself, run as Local Service from that folder,
# started at boot and again within a minute whenever it stops. It starts the
# task on 127.0.0.1:3000 and prints the next step. Running it again upgrades
# the binary in place and keeps the data and the env file.

# One script block, so a download cut short is a parse error and runs nothing.
& {
  Set-StrictMode -Version 3
  $ErrorActionPreference = 'Stop'
  # Invoke-WebRequest is many times slower while it draws its progress bar.
  $ProgressPreference = 'SilentlyContinue'

  function Fail([string] $message) {
    throw "raaqeb install: $message"
  }

  function Say([string] $message) {
    Write-Host "raaqeb install: $message"
  }

  $admin = [Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail 'run this in PowerShell as Administrator'
  }

  # The machine's own architecture, which an x64 PowerShell emulated on arm64 does not report (Bun's install.ps1).
  $machine = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment').PROCESSOR_ARCHITECTURE
  $arch = switch ($machine) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { Fail "Raaqeb has no binary for this machine ($machine); it runs on x64 and arm64" }
  }
  $file = "raaqeb-windows-$arch.exe"

  $dir = Join-Path $env:ProgramFiles 'Raaqeb'
  $bin = Join-Path $dir 'raaqeb.exe'
  $root = Join-Path $env:ProgramData 'Raaqeb'
  $data = Join-Path $root 'data'
  $envFile = Join-Path $root '.env'
  $task = 'Raaqeb'

  # A folder another account made before the install may hold a planted .env
  # or install key, which no access list makes trustworthy: refused, not taken over.
  if (Test-Path -LiteralPath $root) {
    $owner = (Get-Acl -LiteralPath $root).GetOwner([Security.Principal.SecurityIdentifier]).Value
    $trusted = @('S-1-5-32-544', 'S-1-5-18', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    if ($trusted -notcontains $owner) {
      Fail "$root exists and its owner ($owner) is not the Administrators, SYSTEM or you, so its files cannot be trusted; look inside, remove it, and run this again"
    }
  }

  # The folder the binaries and SHA256SUMS come from: RAAQEB_DOWNLOAD_URL, else the release
  # RAAQEB_VERSION names, else the latest, so both files come from one release. The latest
  # is read from the redirect of /latest, which is not followed: GitHub's API would count
  # against a rate limit, a redirect does not.
  $releases = 'https://github.com/Taqanah/raaqeb/releases'
  $hint = ''
  $url = "$env:RAAQEB_DOWNLOAD_URL".TrimEnd('/', '\')
  if ($url -eq '') {
    $version = "$env:RAAQEB_VERSION" -replace '^v', ''
    if ("$env:RAAQEB_VERSION" -ne '') {
      if ($version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') {
        Fail 'RAAQEB_VERSION must be a version such as 1.2.3 or 1.2.3-beta.1'
      }
      $tag = "v$version"
      $hint = " (is $env:RAAQEB_VERSION a release of Raaqeb?)"
    } else {
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      $request = [Net.HttpWebRequest]::Create("$releases/latest")
      $request.AllowAutoRedirect = $false
      $request.Timeout = 30000
      try {
        $response = $request.GetResponse()
      } catch [Net.WebException] {
        if ($_.Exception.Response) {
          Fail "$releases has no release yet; set `$env:RAAQEB_VERSION to a version, or `$env:RAAQEB_DOWNLOAD_URL to a folder holding the binaries and SHA256SUMS"
        }
        Fail "could not reach $releases/latest; check the network, or set `$env:RAAQEB_DOWNLOAD_URL to a folder holding the binaries and SHA256SUMS"
      }
      try {
        $location = $response.Headers['Location']
      } finally {
        $response.Close()
      }
      # A repository with no release sends /latest to its releases list.
      if ("$location" -notmatch '/releases/tag/([^/?#]+)$') {
        Fail "$releases has no release yet; set `$env:RAAQEB_VERSION to a version, or `$env:RAAQEB_DOWNLOAD_URL to a folder holding the binaries and SHA256SUMS"
      }
      $tag = $Matches[1]
    }
    $url = "$releases/download/$tag"
  }

  # A URL is downloaded; a local folder is copied from.
  function Fetch([string] $name, [string] $to) {
    if ($url -match '^https?://') {
      # Windows PowerShell 5.1 may offer TLS 1.0 alone, which GitHub refuses.
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "$url/$name" -OutFile $to
      } catch {
        Fail "could not download $url/$name$hint"
      }
    } else {
      try {
        Copy-Item -LiteralPath (Join-Path $url $name) -Destination $to
      } catch {
        Fail "could not copy $(Join-Path $url $name)"
      }
    }
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("raaqeb-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Say "downloading $file from $url"
    Fetch 'SHA256SUMS' (Join-Path $tmp 'SHA256SUMS')
    Fetch $file (Join-Path $tmp $file)

    # The line naming the whole file, so no binary passes on another's sum.
    $want = $null
    foreach ($line in Get-Content -LiteralPath (Join-Path $tmp 'SHA256SUMS')) {
      if ($line -match "^([0-9a-f]{64})  $([regex]::Escape($file))$") {
        $want = $Matches[1]
      }
    }
    if ($null -eq $want) {
      Fail "SHA256SUMS lists no $file"
    }
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $tmp $file)).Hash.ToLowerInvariant()
    if ($got -ne $want) {
      Fail "$file does not match its checksum in SHA256SUMS"
    }

    # A running binary cannot be replaced: the task is held off and stopped first.
    $held = [bool] (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)
    if ($held) {
      Disable-ScheduledTask -TaskName $task | Out-Null
      Stop-ScheduledTask -TaskName $task
      Get-Process -Name raaqeb -ErrorAction SilentlyContinue | Wait-Process -Timeout 30 -ErrorAction SilentlyContinue
    }
    try {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      Copy-Item -LiteralPath (Join-Path $tmp $file) -Destination $bin -Force
    } catch {
      # The old binary is still in place: it serves again rather than staying down.
      if ($held) {
        Enable-ScheduledTask -TaskName $task | Out-Null
        Start-ScheduledTask -TaskName $task
      }
      Fail "could not replace $bin, so the old one runs again: $($_.Exception.Message)"
    }
    Say "installed $bin"
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  # By SID, since Windows translates the accounts' names: SYSTEM, Administrators, Local Service.
  # Local Service reads the folder and .env and writes only in data, so it cannot change its own boot settings.
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  icacls $root /setowner '*S-1-5-32-544' /T /C | Out-Null
  $limited = $LASTEXITCODE -eq 0
  icacls $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
  $limited = $limited -and $LASTEXITCODE -eq 0
  # Every file under it takes the folder's list alone, whatever entries it carried.
  if (Get-ChildItem -LiteralPath $root -Force) {
    icacls "$root\*" /reset /T /C | Out-Null
    $limited = $limited -and $LASTEXITCODE -eq 0
  }
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  icacls $data /grant '*S-1-5-19:(OI)(CI)M' | Out-Null
  if (-not ($limited -and $LASTEXITCODE -eq 0)) {
    Fail "could not limit who may open $root"
  }
  if (-not (Test-Path -LiteralPath $envFile)) {
    # UTF-8 with no byte order mark, which Bun's .env reader would take as text.
    [IO.File]::WriteAllText($envFile, @'
# Raaqeb's boot settings on this machine, each explained at
# https://raaqeb.dev/en/docs/operate/boot-settings. Raaqeb reads
# this file from its working folder, C:\ProgramData\Raaqeb, which also holds
# its data directory, data. Remove the # before a line to set it, then
# restart the task. Write a $ in a value as \$.
#
# The bind address; 0.0.0.0 listens on every interface.
# RAAQEB_HOST=127.0.0.1
#
# The port.
# RAAQEB_PORT=3000
#
# The proxies whose forwarded headers are believed; a proxy on this machine
# connects from 127.0.0.1 or ::1. Set here, it locks the field on the
# general settings page.
# RAAQEB_TRUSTED_PROXIES=127.0.0.1,::1
#
# A Postgres database, in place of the onboarding page's choice.
# DATABASE_URL=postgres://user:password@host:5432/raaqeb
#
# The install key; when unset it is generated into data\config.json. Keep a
# copy: without it, stored credentials cannot be opened.
# RAAQEB_SECRET_KEY=
#
# Better Auth's secret in its versioned form; stored in the database when unset.
# BETTER_AUTH_SECRETS=

'@)
  }

  # Task Scheduler runs the binary itself, so no wrapper process: a boot
  # start, and a start every minute that does nothing while one runs, which
  # brings it back within a minute of any stop. Its stop is a hard kill.
  $localService = ([Security.Principal.SecurityIdentifier] 'S-1-5-19').Translate([Security.Principal.NTAccount]).Value
  $action = New-ScheduledTaskAction -Execute $bin -Argument 'serve' -WorkingDirectory $root
  $boot = New-ScheduledTaskTrigger -AtStartup
  $again = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Priority 4
  $principal = New-ScheduledTaskPrincipal -UserId $localService -LogonType ServiceAccount
  Register-ScheduledTask -TaskName $task -Description 'Raaqeb monitoring and status pages' -Action $action -Trigger $boot, $again -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $task

  # Up to five minutes: an upgrade snapshots and migrates the database before it listens.
  Push-Location $root
  try {
    $healthy = $false
    for ($tries = 0; $tries -lt 300 -and -not $healthy; $tries++) {
      & $bin health 2>&1 | Out-Null
      $healthy = $LASTEXITCODE -eq 0
      if (-not $healthy) {
        Start-Sleep -Seconds 1
      }
    }
  } finally {
    Pop-Location
  }
  if (-not $healthy) {
    Fail "Raaqeb did not answer /health within five minutes; run it by hand to read its log: cd $root; & '$bin' serve"
  }

  Say 'Raaqeb is running and answers at http://127.0.0.1:3000, unless .env names another address.'
  Say 'Next: put a reverse proxy in front of it (https://raaqeb.dev/en/docs/operate/reverse-proxy),'
  Say "or set RAAQEB_HOST=0.0.0.0 in $envFile, allow the port through Windows Firewall, and restart the task."
  Say 'Then open its address in a browser to finish setup.'
}
