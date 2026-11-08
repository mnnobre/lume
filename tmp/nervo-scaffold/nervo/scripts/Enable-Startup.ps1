$ErrorActionPreference = 'Stop'
$executable = Join-Path (Split-Path $PSScriptRoot -Parent) 'target\release\nervo.exe'
if (!(Test-Path -LiteralPath $executable)) { throw 'Execute scripts\Start.ps1 -Build antes.' }
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name 'Nervo' -Value ('"' + $executable + '"') -PropertyType String -Force | Out-Null
Write-Output 'Nervo configurado para iniciar no login deste usuário. O frontend não será iniciado.'
