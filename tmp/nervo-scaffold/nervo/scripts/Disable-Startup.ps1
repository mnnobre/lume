$ErrorActionPreference = 'Stop'
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Nervo' -ErrorAction SilentlyContinue
Write-Output 'Inicialização automática do Nervo desativada.'
