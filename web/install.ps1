# SSH Portal bridge installer for Windows.
#   $env:SSH_PORTAL_REPO='<owner>/<repo>'; irm https://<you>.github.io/<repo>/install.ps1 | iex
# Downloads the standalone bridge from the repository's latest GitHub release,
# installs it for the current user, starts it, and sets it to start at login.
# No administrator rights needed.
$ErrorActionPreference = 'Stop'
$repo = $env:SSH_PORTAL_REPO
if (-not $repo) { throw 'Set $env:SSH_PORTAL_REPO to <owner>/<repo> first.' }

$url = "https://github.com/$repo/releases/latest/download/ssh-portal-bridge-windows-x64.exe"
$tmp = Join-Path $env:TEMP 'ssh-portal-bridge-setup.exe'
Write-Host 'Downloading SSH Portal bridge...'
$ProgressPreference = 'SilentlyContinue'   # much faster downloads in Windows PowerShell
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
Unblock-File $tmp
& $tmp --install
Remove-Item $tmp -ErrorAction SilentlyContinue
