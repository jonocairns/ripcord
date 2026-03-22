param(
  [ValidateSet("enable", "disable", "status")]
  [string]$Action = "status",

  [string]$WslIp,

  [string]$WindowsListenIp = "0.0.0.0"
)

$Rules = @(
  @{
    Name = "Expo Metro 8081"
    ListenPort = 8081
    ConnectPort = 8081
  },
  @{
    Name = "Sharkord 4991"
    ListenPort = 4991
    ConnectPort = 4991
  },
  @{
    Name = "Sharkord WebRTC 40000"
    ListenPort = 40000
    ConnectPort = 40000
  }
)

function Assert-Admin {
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)

  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session."
  }
}

function Assert-WslIp {
  if ([string]::IsNullOrWhiteSpace($WslIp)) {
    throw "Provide -WslIp when using -Action enable."
  }
}

function Show-Status {
  Write-Host ""
  Write-Host "Portproxy rules"
  netsh interface portproxy show all

  Write-Host ""
  Write-Host "Firewall rules"

  foreach ($rule in $Rules) {
    $firewallRule = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue

    if ($null -eq $firewallRule) {
      Write-Host "$($rule.Name): missing"
      continue
    }

    $firewallRule | Select-Object DisplayName, Enabled, Direction, Action
  }
}

function Enable-Rules {
  Assert-Admin
  Assert-WslIp

  foreach ($rule in $Rules) {
    $listenPort = [string]$rule.ListenPort
    $connectPort = [string]$rule.ConnectPort

    netsh interface portproxy delete v4tov4 listenaddress=$WindowsListenIp listenport=$listenPort | Out-Null

    netsh interface portproxy add v4tov4 `
      listenaddress=$WindowsListenIp `
      listenport=$listenPort `
      connectaddress=$WslIp `
      connectport=$connectPort

    $existingRule = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue

    if ($null -eq $existingRule) {
      New-NetFirewallRule `
        -DisplayName $rule.Name `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $listenPort | Out-Null
    }
  }

  Show-Status
}

function Disable-Rules {
  Assert-Admin

  foreach ($rule in $Rules) {
    $listenPort = [string]$rule.ListenPort

    netsh interface portproxy delete v4tov4 listenaddress=$WindowsListenIp listenport=$listenPort | Out-Null
    Remove-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
  }

  Show-Status
}

switch ($Action) {
  "enable" {
    Enable-Rules
  }
  "disable" {
    Disable-Rules
  }
  "status" {
    Show-Status
  }
}
