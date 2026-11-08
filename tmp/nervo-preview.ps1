$ErrorActionPreference = 'Stop'
$frontRoot = 'C:\Projetos\Nervo\frontend'
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Command','npm run dev') -WorkingDirectory $frontRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $frontRoot 'preview.log') -RedirectStandardError (Join-Path $frontRoot 'preview-error.log') -PassThru
Write-Output "Frontend iniciado: PID $($process.Id). http://127.0.0.1:5177"
