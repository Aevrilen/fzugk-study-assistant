[CmdletBinding()]
param([switch]$Foreground)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$serviceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $serviceRoot 'server.mjs'
$dataRoot = if ($env:FZUGK_DATA_DIR) { [IO.Path]::GetFullPath($env:FZUGK_DATA_DIR) } else { Join-Path $serviceRoot 'data' }
$configPath = if ($env:FZUGK_CONFIG_PATH) { [IO.Path]::GetFullPath($env:FZUGK_CONFIG_PATH) } else { Join-Path $serviceRoot 'config.json' }
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$servicePort = if ($env:FZUGK_PORT) { [int]$env:FZUGK_PORT } elseif ($config.port) { [int]$config.port } else { 8766 }
$serviceHost = if ($config.host) { [string]$config.host } else { '127.0.0.1' }
if ($serviceHost -notin @('127.0.0.1', 'localhost', '::1')) { throw 'Local service must use a loopback host.' }
$baseUrl = if ($serviceHost -eq '::1') { "http://[::1]:$servicePort" } else { "http://${serviceHost}:$servicePort" }
$localToken = if ($env:FZUGK_LOCAL_TOKEN) { $env:FZUGK_LOCAL_TOKEN } else { $config.localAccessToken }
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
$logPath = Join-Path $dataRoot 'service.log'
$stdoutPath = Join-Path $dataRoot 'service.stdout.log'
$stderrPath = Join-Path $dataRoot 'service.stderr.log'
$processPath = Join-Path $dataRoot 'service-process.json'
$nodeCommand = Get-Command node -ErrorAction Stop

function Write-ServiceEvent([string]$Message) {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Add-Content -LiteralPath $logPath -Encoding UTF8
}

if ($Foreground) {
    foreach ($taskLog in @($logPath, $stdoutPath, $stderrPath)) {
        if ((Test-Path -LiteralPath $taskLog) -and (Get-Item -LiteralPath $taskLog).Length -gt 5MB) {
            Move-Item -LiteralPath $taskLog -Destination "$taskLog.previous" -Force
        }
    }
    Write-ServiceEvent 'Starting local service with an independent hidden supervisor'
    try {
        $serviceProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList "`"$serverPath`"" -WorkingDirectory $serviceRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
        # Retain the native handle before exit so Windows PowerShell can read ExitCode.
        $serviceHandle = $serviceProcess.Handle
        @{ pid = $serviceProcess.Id; supervisorPid = $PID; port = $servicePort; startedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $processPath -Encoding UTF8
        $serviceProcess.WaitForExit()
        $serviceExit = $serviceProcess.ExitCode
        Write-ServiceEvent "Local service exited: pid=$($serviceProcess.Id), exitCode=$serviceExit"
        exit $serviceExit
    } catch {
        Write-ServiceEvent 'Local service launcher failed; inspect service.stderr.log'
        throw
    }
}

Add-Type -AssemblyName System.Net.Http
$httpHandler = New-Object System.Net.Http.HttpClientHandler
$httpHandler.UseProxy = $false
$httpClient = New-Object System.Net.Http.HttpClient($httpHandler)
$httpClient.Timeout = [TimeSpan]::FromSeconds(2)
function Read-ServiceHealth {
    $healthResponse = $httpClient.GetAsync("$baseUrl/health").GetAwaiter().GetResult()
    try {
        if (-not $healthResponse.IsSuccessStatusCode) { throw 'Local service health check failed.' }
        return ($healthResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json)
    } finally { $healthResponse.Dispose() }
}
function Assert-ServiceReady($Health) {
    if ($Health.service -ne 'fzugk-study-assistant' -or $Health.version -ne '1.2.3' -or $Health.deadlinePolicy -ne 'single-attempt') { throw 'A different or older service is running. Stop that project service before starting this version.' }
    $authRequest = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, "$baseUrl/api/auth/check")
    $authRequest.Headers.Add('X-FZUGK-Token', [string]$localToken)
    $authRequest.Content = New-Object System.Net.Http.StringContent('{}', [Text.Encoding]::UTF8, 'application/json')
    try {
        $authResponse = $httpClient.SendAsync($authRequest).GetAwaiter().GetResult()
        try { if (-not $authResponse.IsSuccessStatusCode) { throw 'Local token authentication failed.' } }
        finally { $authResponse.Dispose() }
    } finally { $authRequest.Dispose() }
}

try {
    $existingHealth = $null
    try { $existingHealth = Read-ServiceHealth } catch { }
    if ($null -ne $existingHealth) {
        Assert-ServiceReady $existingHealth
        @{ ok = $true; alreadyRunning = $true; version = $existingHealth.version; port = $servicePort; log = $logPath } | ConvertTo-Json
        exit 0
    }
    # Do not start another process if a non-HTTP or unrelated listener owns the port.
    $tcpProbe = New-Object Net.Sockets.TcpClient
    try {
        $connect = $tcpProbe.ConnectAsync($serviceHost, $servicePort)
        if ($connect.Wait(300) -and $tcpProbe.Connected) { throw 'The configured port is occupied; no service was started.' }
    } catch [AggregateException] { }
    finally { $tcpProbe.Dispose() }
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Foreground"
    $supervisor = Start-Process -FilePath $windowsPowerShell -ArgumentList $arguments -WorkingDirectory $serviceRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataRoot 'service.launcher.stdout.log') -RedirectStandardError (Join-Path $dataRoot 'service.launcher.stderr.log') -PassThru
    $readyHealth = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($supervisor.HasExited) { throw 'Service supervisor exited during startup; inspect service.launcher.stderr.log.' }
        try { $readyHealth = Read-ServiceHealth } catch { }
        if ($null -ne $readyHealth) { break }
        Start-Sleep -Milliseconds 200
    }
    if ($null -eq $readyHealth) { throw 'Service startup timed out; inspect service logs.' }
    Assert-ServiceReady $readyHealth
    Write-ServiceEvent 'Background startup passed health and local token authentication'
    @{ ok = $true; alreadyRunning = $false; version = $readyHealth.version; port = $servicePort; supervisorPid = $supervisor.Id; log = $logPath } | ConvertTo-Json
} finally {
    $httpClient.Dispose()
    $httpHandler.Dispose()
}
