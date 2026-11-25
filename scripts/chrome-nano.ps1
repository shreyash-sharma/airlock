# Launch Chrome with a dedicated profile and remote debugging, for AIRLOCK browser checks.
#   powershell -File scripts/chrome-nano.ps1 [-Profile <folder>] [-Port 9222]
# One-time setup inside that Chrome profile (chrome://flags), then relaunch:
#   #prompt-api-for-gemini-nano            = Enabled
#   #optimization-guide-on-device-model    = Enabled BypassPerfRequirement   (only if the hardware check fails)
# The Gemini Nano model needs about 22 GB free on the drive that holds the profile, so keep the profile
# on a roomy drive. TMP and TEMP are pointed there too so downloads do not touch a small system drive.
param(
  [string]$Profile = "$env:LOCALAPPDATA\airlock-chrome-profile",
  [int]$Port = 9222,
  [string]$Url = "http://127.0.0.1:5173/"
)
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { throw "Chrome not found at $chrome" }
New-Item -ItemType Directory -Force $Profile | Out-Null
$tmp = Join-Path (Split-Path $Profile -Parent) "chrome-nano-tmp"
New-Item -ItemType Directory -Force $tmp | Out-Null
$env:TMP = $tmp
$env:TEMP = $tmp
Start-Process $chrome -ArgumentList "--user-data-dir=$Profile", "--remote-debugging-port=$Port", "--remote-allow-origins=*", "--no-first-run", $Url
Write-Host "Chrome started with profile $Profile and debugging on port $Port. Start the app with: npm run dev"
