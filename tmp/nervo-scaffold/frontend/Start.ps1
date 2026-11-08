$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (!(Test-Path -LiteralPath 'node_modules')) { npm ci; if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependências.' } }
    npm run dev
} finally { Pop-Location }
