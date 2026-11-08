param([int]$Seconds = 60)
$ErrorActionPreference = 'Stop'
$dataRoot = if ($env:NERVO_DATA_DIR) { $env:NERVO_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'Nervo' }
$token = (Get-Content -LiteralPath (Join-Path $dataRoot 'access-token') -Raw).Trim()
$headers = @{ Authorization = "Bearer $token" }
$healthBefore = Invoke-RestMethod 'http://127.0.0.1:47821/api/health' -Headers $headers -TimeoutSec 5
$settingsBefore = Invoke-RestMethod 'http://127.0.0.1:47821/api/settings' -Headers $headers -TimeoutSec 5
$logical = [Environment]::ProcessorCount
$targets = @(@{ label='Nervo backend'; process_id=[int]$healthBefore.pid })
try {
    $owners = @(Get-NetTCPConnection -LocalPort 5177 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($owner in $owners) { $targets += @{label='Servidor Vite do painel';process_id=[int]$owner} }
} catch { Write-Output 'Não foi possível identificar o processo do servidor do painel.' }
$connections = @(Get-NetTCPConnection -LocalPort 47821 -State Established -ErrorAction SilentlyContinue).Count
$journal = Join-Path (Join-Path $dataRoot 'memory') 'journal'
function JournalBytes {
    if (!(Test-Path -LiteralPath $journal)) { return 0 }
    return [long]((Get-ChildItem -LiteralPath $journal -Filter '*.md' -File -Recurse | Measure-Object -Property Length -Sum).Sum)
}
$journalBefore = JournalBytes
$watch = [Diagnostics.Stopwatch]::StartNew()
$startedAt = [DateTime]::UtcNow.ToString('o')
$samples = [Collections.Generic.List[object]]::new()
$initial = @{}
$last = @{}
foreach ($target in $targets) {
    $proc = Get-Process -Id $target.process_id
    $initial[$target.process_id] = @{cpu=$proc.TotalProcessorTime.TotalSeconds;time=$watch.Elapsed.TotalSeconds}
    $last[$target.process_id] = $initial[$target.process_id]
}
Write-Output "Medição iniciada: coleta=$($healthBefore.collector_interval_ms) ms; $logical processadores lógicos; $connections conexões HTTP estabelecidas. Duração: $Seconds s."
for ($i=0; $i -lt $Seconds; $i++) {
    Start-Sleep -Milliseconds 1000
    foreach ($target in $targets) {
        $proc = Get-Process -Id $target.process_id
        $now = $watch.Elapsed.TotalSeconds
        $cpu = $proc.TotalProcessorTime.TotalSeconds
        $previous = $last[$target.process_id]
        $sample = [pscustomobject]@{
            elapsed_s=[math]::Round($now,3); process=$target.label; process_id=$target.process_id
            cpu_percent_total=100*($cpu-$previous.cpu)/($now-$previous.time)/$logical
            private_mib=$proc.PrivateMemorySize64/1MB; resident_mib=$proc.WorkingSet64/1MB
            threads=$proc.Threads.Count; handles=$proc.HandleCount
        }
        $samples.Add($sample)
        $last[$target.process_id]=@{cpu=$cpu;time=$now}
    }
    if ($i -eq 29) { Write-Output '30 segundos medidos. Coleta continua sem alterar configurações.' }
}
$healthAfter = Invoke-RestMethod 'http://127.0.0.1:47821/api/health' -Headers $headers -TimeoutSec 5
$journalAfter = JournalBytes
$summaries = foreach ($target in $targets) {
    $rows = @($samples | Where-Object process_id -eq $target.process_id)
    $cpuStats = $rows | Measure-Object cpu_percent_total -Minimum -Maximum -Average
    $privateStats = $rows | Measure-Object private_mib -Minimum -Maximum -Average
    $residentStats = $rows | Measure-Object resident_mib -Minimum -Maximum -Average
    $first = $initial[$target.process_id]; $final = $last[$target.process_id]
    $duration = $final.time-$first.time
    [pscustomobject]@{
        process=$target.label; process_id=$target.process_id; duration_s=[math]::Round($duration,3)
        cpu_average_percent_total=[math]::Round(100*($final.cpu-$first.cpu)/$duration/$logical,4)
        cpu_peak_1s_percent_total=[math]::Round($cpuStats.Maximum,4)
        cpu_seconds=[math]::Round($final.cpu-$first.cpu,6)
        private_mib_min=[math]::Round($privateStats.Minimum,3);private_mib_max=[math]::Round($privateStats.Maximum,3)
        private_mib_start=[math]::Round($rows[0].private_mib,3);private_mib_end=[math]::Round($rows[-1].private_mib,3)
        resident_mib_min=[math]::Round($residentStats.Minimum,3);resident_mib_max=[math]::Round($residentStats.Maximum,3)
        thread_count_min=($rows|Measure-Object threads -Minimum).Minimum;thread_count_max=($rows|Measure-Object threads -Maximum).Maximum
    }
}
$report = [ordered]@{
    started_utc=$startedAt; finished_utc=[DateTime]::UtcNow.ToString('o'); logical_processors=$logical
    settings=$settingsBefore.current; settings_revision_after=$healthAfter.settings_revision
    cpu_basis='Cumulative process CPU time / elapsed wall time / logical processors. Peak uses approximately one-second samples.'
    processes=@($summaries)
    history=[ordered]@{batches_delta=$healthAfter.history.batches-$healthBefore.history.batches;persisted_events_delta=$healthAfter.history.persisted_events-$healthBefore.history.persisted_events;published_markdown_bytes_delta=$journalAfter-$journalBefore;pending_bytes_before=$healthBefore.history.pending_bytes;pending_bytes_after=$healthAfter.history.pending_bytes;dropped_delta=$healthAfter.history.dropped_events-$healthBefore.history.dropped_events;last_error=$healthAfter.history.last_error}
    limitations=@('Browser rendering and Codex process are not isolated or included.','Markdown byte delta measures logical published file sizes, not physical disk traffic.','The observer runs as a separate PowerShell process and is excluded.','One-minute observation, not a controlled baseline comparison or guarantee of future load.','Configured collection interval verified; browser live-mode preference supplied by user.')
}
$outputDir='C:\Projetos\Gerenciador\output'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$stem='nervo-250ms-'+[DateTime]::Now.ToString('yyyyMMdd-HHmmss')
$jsonPath=Join-Path $outputDir ($stem+'.json')
$csvPath=Join-Path $outputDir ($stem+'.csv')
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8
$samples | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding UTF8
$report | ConvertTo-Json -Depth 8
Write-Output "REPORT: $jsonPath"
Write-Output "SAMPLES: $csvPath"
