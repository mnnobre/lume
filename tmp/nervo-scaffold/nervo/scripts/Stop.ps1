$ErrorActionPreference = 'Stop'
$dataRoot = if ($env:NERVO_DATA_DIR) { $env:NERVO_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'Nervo' }
$token = (Get-Content -LiteralPath (Join-Path $dataRoot 'access-token') -Raw).Trim()
Invoke-RestMethod 'http://127.0.0.1:47821/api/shutdown' -Method Post -Headers @{Authorization="Bearer $token"} | Out-Null
Write-Output 'Encerramento solicitado. O Nervo tentará gravar o lote pendente antes de sair.'
