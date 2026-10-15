$ErrorActionPreference = 'Stop'
$installerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$installerFile = Join-Path $installerRoot 'exam-installer.mjs'
try {
    $installerHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8769/health' -TimeoutSec 2
    if ($installerHealth.service -eq 'fzugk-exam-installer') {
        Write-Output '考试助手安装入口：http://127.0.0.1:8769/install/exam'
        exit 0
    }
    throw '8769 端口已被其他服务使用'
} catch {
    if ($_.Exception.Message -eq '8769 端口已被其他服务使用') { throw }
}
$nodeRuntime = (Get-Command node -ErrorAction Stop).Source
Start-Process -FilePath $nodeRuntime -ArgumentList ('"' + $installerFile + '"') -WorkingDirectory $installerRoot -WindowStyle Hidden
for ($installerAttempt = 0; $installerAttempt -lt 25; $installerAttempt++) {
    try {
        $installerHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8769/health' -TimeoutSec 2
        if ($installerHealth.service -eq 'fzugk-exam-installer') {
            Write-Output '考试助手安装入口：http://127.0.0.1:8769/install/exam'
            exit 0
        }
    } catch {}
    Start-Sleep -Milliseconds 200
}
throw '安装入口启动失败，请检查 Node.js 与 8769 端口'
