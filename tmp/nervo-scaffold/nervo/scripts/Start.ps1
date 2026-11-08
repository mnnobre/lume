param([switch]$Build)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$executable = Join-Path $projectRoot 'target\release\nervo.exe'
if ($Build -or !(Test-Path -LiteralPath $executable)) {
    Push-Location $projectRoot
    try { cargo build --release --locked; if ($LASTEXITCODE -ne 0) { throw 'Falha na compilação.' } } finally { Pop-Location }
}
$dataRoot = if ($env:NERVO_DATA_DIR) { $env:NERVO_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'Nervo' }
$tokenPath = Join-Path $dataRoot 'access-token'
if (Test-Path -LiteralPath $tokenPath) {
    try { $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim(); $health = Invoke-RestMethod 'http://127.0.0.1:47821/api/health' -Headers @{Authorization="Bearer $token"} -TimeoutSec 2; if ($health.name -eq 'Nervo') { Write-Output "Nervo já está ativo (PID $($health.pid))."; exit 0 } } catch {}
}
$process = Start-Process -FilePath $executable -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 100
    if (Test-Path -LiteralPath $tokenPath) {
        try { $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim(); $health = Invoke-RestMethod 'http://127.0.0.1:47821/api/health' -Headers @{Authorization="Bearer $token"} -TimeoutSec 1; if ($health.name -eq 'Nervo') { Write-Output "Nervo iniciado (PID $($health.pid)). MCP: http://127.0.0.1:47821/mcp"; exit 0 } } catch {}
    }
    if ($process.HasExited) { throw "O backend encerrou com código $($process.ExitCode). Execute cargo run para diagnóstico." }
}
throw 'Backend não respondeu no prazo esperado.'
