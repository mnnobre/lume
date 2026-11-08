$ErrorActionPreference='Stop'
$dataRoot=if($env:NERVO_DATA_DIR){$env:NERVO_DATA_DIR}else{Join-Path $env:LOCALAPPDATA 'Nervo'}
$token=(Get-Content -LiteralPath (Join-Path $dataRoot 'access-token') -Raw).Trim()
$headers=@{Authorization="Bearer $token"}
Invoke-RestMethod 'http://127.0.0.1:47821/api/health' -Headers $headers | ConvertTo-Json -Depth 5
Invoke-RestMethod 'http://127.0.0.1:47821/api/settings' -Headers $headers | ConvertTo-Json -Depth 5
