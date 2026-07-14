$env:DEEPSEEK_API_KEY="YOUR_DEEPSEEK_API_KEY"
$env:FIRECRAWL_API_KEY="YOUR_FIRECRAWL_API_KEY"
$env:WS_PORT="3742"
$env:RE_STORAGE_DIR=".real-estate-store"
Set-Location "$PSScriptRoot\backend"
Write-Host "Starting with DeepSeek + Firecrawl APIs..."
npx tsx src/index.ts
