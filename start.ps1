param([switch]$Dev)

function Import-UserEnvironmentVariable([string]$Name) {
    $userValue = [Environment]::GetEnvironmentVariable($Name, "User")
    if ($userValue) { Set-Item -Path "Env:$Name" -Value $userValue }
}

@("DEEPSEEK_API_KEY", "FIRECRAWL_API_KEY", "HERE_API_KEY") | ForEach-Object {
    Import-UserEnvironmentVariable $_
}

$missing = @("DEEPSEEK_API_KEY", "FIRECRAWL_API_KEY", "HERE_API_KEY") | Where-Object {
    -not (Test-Path "Env:$_") -or [string]::IsNullOrWhiteSpace((Get-Item "Env:$_").Value)
}
if ($missing.Count -gt 0) {
    Write-Error "Missing required environment variable(s): $($missing -join ', '). Set them in PowerShell before running start.ps1."
    exit 1
}

$env:WS_PORT="3742"
$env:RE_STORAGE_DIR=".real-estate-store"
$env:RE_MAP_PROVIDER="here"
$env:RE_GEO_DISTANCE_MODE="DRIVE"
$env:RE_DETAIL_ENRICH_LIMIT="20"
$env:RE_FEATURE_SEARCH_LIMIT="20"
$env:RE_SCHOOL_ENRICH_LIMIT="20"
$env:RE_SCHOOL_RESULT_LIMIT="20"
$env:RE_REALTOR_SCHOOL_DETAIL_ENABLED="true"
$env:RE_GEO_ENRICH_LIMIT="20"
$env:RE_CCSD_FIRECRAWL_FALLBACK="false"
$env:RE_INTERACT_FALLBACK_ENABLED="false"
$env:RE_INTERACT_FALLBACK_LIMIT="3"
$env:PI_RUNTIME_ENABLED="true"
$env:RE_PROJECT_ROOT=$PSScriptRoot
Set-Location "$PSScriptRoot\backend"
Write-Host "Starting real-estate-pi on http://localhost:3742 ..."
if ($Dev) {
    npm run dev
} else {
    npm start
}
