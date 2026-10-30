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
try {
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
} catch {
  if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
    throw "The bridge download wasn't found ($url). Either the repository $repo is private (release downloads only work for public repositories), or no release has been published yet (run the 'Release bridge' workflow in the repository's Actions tab)."
  }
  throw "Couldn't download the bridge from $url : $($_.Exception.Message)"
}
Unblock-File $tmp
& $tmp --install
Remove-Item $tmp -ErrorAction SilentlyContinue
