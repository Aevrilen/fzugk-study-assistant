[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$serviceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = if ([string]::IsNullOrWhiteSpace($env:FZUGK_CONFIG_PATH)) {
    Join-Path $serviceRoot 'config.json'
} else {
    [IO.Path]::GetFullPath($env:FZUGK_CONFIG_PATH)
}

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "找不到配置文件：$configPath"
}

Write-Host 'DeepSeek API Key 本机安全配置'
Write-Host '请粘贴 Key 后按 Enter。输入内容不会显示，也不会写入终端日志。'
$secureKey = Read-Host 'DeepSeek API Key' -AsSecureString
$keyPointer = [IntPtr]::Zero
$plainKey = $null

try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    if ([string]::IsNullOrWhiteSpace($plainKey) -or $plainKey.Length -lt 20 -or $plainKey -match '\s') {
        throw 'API Key 格式无效：长度至少为 20 个字符，且不能包含空白字符。'
    }

    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $config.openai) {
        $config | Add-Member -MemberType NoteProperty -Name openai -Value ([pscustomobject]@{})
    }

    $backupRoot = Join-Path $serviceRoot 'data\config-backups'
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    $backupPath = Join-Path $backupRoot ("config.before-deepseek-key.{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Copy-Item -LiteralPath $configPath -Destination $backupPath

    $config.openai.apiKey = $plainKey
    $config.openai.baseUrl = 'https://api.deepseek.com'
    $config.openai.model = 'deepseek-flash'
    $config.openai.webSearch = $false
    $config.openai.maxOutputTokens = 300
    $config.transcription.enabled = $false
    $config.vision.enabled = $false
    $config.limits.materialTopK = 3
    $config.limits.dailyAiRequests = 200
    if ($null -eq $config.limits.dedupeWindowMs) {
        $config.limits | Add-Member -MemberType NoteProperty -Name dedupeWindowMs -Value 900000
    } else {
        $config.limits.dedupeWindowMs = 900000
    }

    $temporaryPath = "$configPath.$PID.tmp"
    $json = $config | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($temporaryPath, "$json`n", [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    & $icacls $configPath '/inheritance:r' '/grant:r' "${identity}:(F)" 'SYSTEM:(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '配置已写入，但无法限制文件访问权限。' }
    & $icacls $backupPath '/inheritance:r' '/grant:r' "${identity}:(F)" 'SYSTEM:(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '配置已写入，但无法限制备份文件访问权限。' }

    Write-Host ''
    Write-Host '配置成功：DeepSeek Key 已写入本机配置。' -ForegroundColor Green
    Write-Host 'Key 未被打印。现在可以关闭此终端并让学习助手重启服务。'
} finally {
    if ($keyPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    }
    $plainKey = $null
    if ($null -ne $secureKey) { $secureKey.Dispose() }
}
