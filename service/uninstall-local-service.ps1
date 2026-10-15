[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$taskName = 'FZUGK Study Assistant Local Service'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'FZUGK Study Assistant Local Service.lnk'
$removed = $false
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    $removed = $true
}
if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    $removed = $true
}
[PSCustomObject]@{ Removed = $removed; TaskName = $taskName; Shortcut = $shortcutPath } | ConvertTo-Json
