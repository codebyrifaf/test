#Requires -RunAsAdministrator
[CmdletBinding(SupportsShouldProcess)]
param([switch]$Undo)

$ErrorActionPreference = 'Stop'
$relayRuleName = 'TCP Query User{0AE1F769-4D40-4227-B62E-85BEB6D11AE6}C:\users\user\appdata\local\nvm\v24.16.0\node.exe'
$relayProgram = 'C:\Users\USER\AppData\Local\nvm\v24.16.0\node.exe'
$relayBackupDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) '.verification'
$relayBackupPath = Join-Path $relayBackupDirectory 'relay-lan-firewall-backup.clixml'

# Target the one observed TCP rule. Leave UDP and other applications untouched.
$relayRule = Get-NetFirewallRule -Name $relayRuleName
$relayApplication = $relayRule | Get-NetFirewallApplicationFilter
if ($relayApplication.Program -ine $relayProgram) {
    throw 'The Node firewall rule changed. Inspect it again before applying this fix.'
}

if ($Undo) {
    if (-not (Test-Path -LiteralPath $relayBackupPath)) {
        throw 'No original firewall settings were saved by this script.'
    }
    $relayOriginal = Import-Clixml -LiteralPath $relayBackupPath
    if ($relayOriginal.Name -ne $relayRuleName) { throw 'The backup belongs to another rule.' }
    if ($PSCmdlet.ShouldProcess($relayRuleName, 'Restore the saved original firewall settings')) {
        Set-NetFirewallRule @relayOriginal
        Write-Output 'Original Node TCP firewall settings restored.'
    }
    return
}

$relayAddress = Get-NetIPAddress -InterfaceAlias 'Wi-Fi' -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -eq '192.168.1.138' -and $_.PrefixLength -eq 24 }
if (-not $relayAddress) {
    throw 'The Wi-Fi address or subnet changed. Inspect the network before updating this exception.'
}
$relayPorts = $relayRule | Get-NetFirewallPortFilter
$relayAddresses = $relayRule | Get-NetFirewallAddressFilter
$relayInterfaces = $relayRule | Get-NetFirewallInterfaceFilter

if ($PSCmdlet.ShouldProcess($relayRuleName, 'Allow TCP 3000 for this Node program on Wi-Fi from 192.168.1.0/24')) {
    if (-not (Test-Path -LiteralPath $relayBackupPath)) {
        New-Item -ItemType Directory -Path $relayBackupDirectory -Force | Out-Null
        @{
            Name = $relayRule.Name
            Enabled = $relayRule.Enabled.ToString()
            Action = $relayRule.Action.ToString()
            Protocol = $relayPorts.Protocol.ToString()
            LocalPort = [string[]]$relayPorts.LocalPort
            RemoteAddress = [string[]]$relayAddresses.RemoteAddress
            LocalAddress = [string[]]$relayAddresses.LocalAddress
            InterfaceAlias = [string[]]$relayInterfaces.InterfaceAlias
        } | Export-Clixml -LiteralPath $relayBackupPath
    }

    # Convert the observed broad TCP block to a scoped allow. A separate allow
    # alone would not work because Windows gives explicit block rules priority.
    # Other traffic remains subject to the existing Windows firewall policy.
    Set-NetFirewallRule -Name $relayRuleName -Enabled True -Action Allow `
        -Protocol TCP -LocalPort 3000 -RemoteAddress '192.168.1.0/24' `
        -LocalAddress '192.168.1.138' -InterfaceAlias 'Wi-Fi'

    Write-Output 'Relay TCP port 3000 is allowed from the local Wi-Fi subnet.'
    Write-Output 'Keep the Relay server running. On the Mac open http://192.168.1.138:3000'
    Write-Output 'To restore the original rule, run this script again with -Undo.'
}
