$ErrorActionPreference = "Stop"

function Import-RequiredUserEnvironmentVariable([string]$Name) {
    $value = [Environment]::GetEnvironmentVariable($Name, "User")
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Missing Windows user environment variable: $Name"
    }
    Set-Item -Path "Env:$Name" -Value $value.Trim().Trim('"').Trim("'")
}

@("DEEPSEEK_API_KEY", "FIRECRAWL_API_KEY", "HERE_API_KEY") | ForEach-Object {
    Import-RequiredUserEnvironmentVariable $_
}

$env:PI_RUNTIME_ENABLED = "true"
$env:RE_PROJECT_ROOT = (Resolve-Path "$PSScriptRoot\..").Path
$env:RE_STORAGE_DIR = ".real-estate-store"
$env:RE_MAP_PROVIDER = "here"
$env:RE_GEO_DISTANCE_MODE = "DRIVE"
$env:RE_DETAIL_ENRICH_LIMIT = "20"
$env:RE_FEATURE_SEARCH_LIMIT = "20"
$env:RE_SCHOOL_ENRICH_LIMIT = "20"
$env:RE_REALTOR_SCHOOL_DETAIL_ENABLED = "true"
$env:RE_GEO_ENRICH_LIMIT = "20"
$env:RE_CCSD_FIRECRAWL_FALLBACK = "false"
$env:RE_INTERACT_FALLBACK_ENABLED = "true"
$env:RE_INTERACT_FALLBACK_LIMIT = "20"

$tsx = Join-Path $PSScriptRoot "node_modules\.bin\tsx.cmd"
if (-not (Test-Path $tsx)) { throw "tsx is not installed. Run npm install first." }
& $tsx watch src/index.ts
