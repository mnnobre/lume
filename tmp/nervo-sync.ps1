$ErrorActionPreference = 'Stop'
$sourceRoot = 'C:\Projetos\Gerenciador\tmp\nervo-scaffold'
$targetRoot = 'C:\Projetos\Nervo'
if ([IO.Path]::GetFullPath($targetRoot) -ne 'C:\Projetos\Nervo') { throw 'Unexpected target' }
foreach ($part in @('nervo', 'frontend')) {
    $sourcePart = Join-Path $sourceRoot $part
    $targetPart = Join-Path $targetRoot $part
    New-Item -ItemType Directory -Path $targetPart -Force | Out-Null
    Get-ChildItem -LiteralPath $sourcePart -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($sourcePart.Length + 1)
        $destination = Join-Path $targetPart $relative
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
    }
}
Write-Output 'Project sources synchronized to C:\Projetos\Nervo (no deletion).'
