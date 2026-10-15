[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$taskName = 'FZUGK Study Assistant Local Service'
$serviceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$startScript = Join-Path $serviceRoot 'start-service.ps1'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder 'FZUGK Study Assistant Local Service.lnk'

if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
    throw "Start script not found: $startScript"
}

$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
$action = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$method = 'ScheduledTask'
$state = 'Unknown'
$lastTaskResult = $null
try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Starts the local DeepSeek study assistant service at user logon. The service listens on 127.0.0.1 only.' -Force | Out-Null
    if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
    Start-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 2
    $task = Get-ScheduledTask -TaskName $taskName
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    $state = [string]$task.State
    $lastTaskResult = $info.LastTaskResult
} catch {
    if ($_.Exception.Message -notmatch 'Access is denied|0x80070005') { throw }
    $method = 'StartupShortcut'
}

if ($method -eq 'StartupShortcut') {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $windowsPowerShell
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $serviceRoot
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Starts the local DeepSeek study assistant service at user logon.'
    $shortcut.Save()
    Start-Process -FilePath $windowsPowerShell -ArgumentList $arguments -WorkingDirectory $serviceRoot -WindowStyle Hidden
    Start-Sleep -Seconds 2
    $state = if (Test-Path -LiteralPath $shortcutPath) { 'Installed' } else { 'Failed' }
}

[PSCustomObject]@{
    Installed = $true
    Method = $method
    TaskName = $taskName
    User = $identity
    State = $state
    LastTaskResult = $lastTaskResult
    StartScript = $startScript
    Shortcut = if ($method -eq 'StartupShortcut') { $shortcutPath } else { $null }
} | ConvertTo-Json
