$ErrorActionPreference = "Stop"

function Find-Tailscale {
  $command = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $defaultPath = "C:\Program Files\Tailscale\tailscale.exe"
  if (Test-Path $defaultPath) { return $defaultPath }

  return $null
}

function Read-PlainPassword {
  $secure = Read-Host "Set access password for this sharing session" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Wait-ForLocalServer {
  param([int]$Port)

  for ($i = 0; $i -lt 20; $i++) {
    $client = New-Object Net.Sockets.TcpClient
    try {
      $client.Connect("127.0.0.1", $Port)
      return $true
    } catch {
      Start-Sleep -Milliseconds 500
    } finally {
      $client.Dispose()
    }
  }
  return $false
}

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8765

Write-Host ""
Write-Host "Finance System Free Fixed-URL Sharing"
Write-Host "--------------------------------"
Write-Host "This uses Tailscale Funnel. When this PC is online and this script is running, Lan can visit a fixed https://*.ts.net URL."
Write-Host ""

$tailscale = Find-Tailscale
if (-not $tailscale) {
  Write-Host "Tailscale is not installed."
  Write-Host "Enter Y to install with winget, or install manually from https://tailscale.com/download/windows and run this script again."
  $install = Read-Host "Install Tailscale now with winget? (Y/N)"
  if ($install -match "^[Yy]$") {
    winget install --id Tailscale.Tailscale -e
    $tailscale = Find-Tailscale
  }
}

if (-not $tailscale) {
  Write-Host "Tailscale is still not installed. Fixed-URL sharing cannot start yet."
  exit 1
}

try {
  & $tailscale status | Out-Null
} catch {
  Write-Host ""
  Write-Host "Tailscale login is required. A browser sign-in page may open next."
  & $tailscale up
  Write-Host "After signing in, run start-free-share.bat again."
  exit 0
}

$password = Read-PlainPassword
if ([string]::IsNullOrWhiteSpace($password)) {
  Write-Host "Access password cannot be empty."
  exit 1
}

$env:HOST = "127.0.0.1"
$env:PORT = "$port"
$env:FINANCE_USER = "zhan"
$env:FINANCE_PASSWORD = $password

Write-Host ""
Write-Host "Starting local finance system..."
Start-Process -FilePath "python" -ArgumentList "server.py" -WorkingDirectory $projectDir -WindowStyle Minimized

if (-not (Wait-ForLocalServer -Port $port)) {
  Write-Host "Local finance system did not start. Please make sure Python is installed."
  exit 1
}

Write-Host "Starting public fixed URL..."
& $tailscale funnel --bg --https=443 "127.0.0.1:${port}"

$publicUrl = ""
try {
  $status = & $tailscale status --json | ConvertFrom-Json
  if ($status.Self.DNSName) {
    $publicUrl = "https://" + $status.Self.DNSName.TrimEnd(".")
  }
} catch {
  $publicUrl = ""
}

Write-Host ""
Write-Host "Sharing is on."
Write-Host "Username: zhan"
Write-Host "Password: the password you just entered"
if ($publicUrl) {
  Write-Host "Fixed URL: $publicUrl"
  Start-Process $publicUrl
} else {
  Write-Host "The fixed URL is shown in the status below:"
  & $tailscale funnel status
}
Write-Host ""
Write-Host "Note: if this PC shuts down, loses network, or sharing is stopped, Lan cannot access the system."
Write-Host "To stop sharing, run stop-free-share.bat."
