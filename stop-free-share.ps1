$ErrorActionPreference = "Continue"

function Find-Tailscale {
  $command = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $defaultPath = "C:\Program Files\Tailscale\tailscale.exe"
  if (Test-Path $defaultPath) { return $defaultPath }

  return $null
}

Write-Host ""
Write-Host "Stopping finance system public sharing..."

$tailscale = Find-Tailscale
if ($tailscale) {
  & $tailscale funnel --https=443 off
  Write-Host "Public sharing is off."
} else {
  Write-Host "Tailscale is not installed. Skipping Funnel shutdown."
}

$listeners = netstat -ano | Select-String "127\.0\.0\.1:8765\s+0\.0\.0\.0:0\s+LISTENING"
$pids = $listeners | ForEach-Object { ($_ -split "\s+")[-1] } | Sort-Object -Unique
foreach ($pidValue in $pids) {
  try {
    Stop-Process -Id ([int]$pidValue) -Force
    Write-Host "Local finance system service stopped."
  } catch {
    Write-Host "Could not stop process ${pidValue}. Please close the related window manually."
  }
}

if (-not $pids) {
  Write-Host "No running local finance system service was found."
}
