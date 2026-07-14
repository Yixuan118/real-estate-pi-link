# Real Estate Monitor — Multi-Agent System

Real-time property search web app powered by a multi-agent architecture and **Pi collaborating agents**. Scrapes live data from Realtor.com via Firecrawl, then uses Pi to validate, rank, and summarize results — all streamed to the frontend via WebSocket.

## Quick Start

```powershell
cd backend
npm install
$env:FIRECRAWL_API_KEY = "your-key"
$env:DEEPSEEK_API_KEY = "your-key"
$env:PI_RUNTIME_ENABLED = "true"
$env:RE_PROJECT_ROOT = (Resolve-Path "..").Path
npx tsx src/index.ts
```
Open `frontend/index.html` in your browser.

## Usage

### Normal search
```
I want a 3-bedroom house in Seattle under 1 million with a pool
```

### Collaborative search with Pi (core feature)
Prefix with `/collab-agent-scrape` to use Pi collaborating agents:
```
/collab-agent-scrape I want a 3-bedroom house in Seattle under 1 million
```

This triggers:
1. **MemoryAgent** extracts criteria → **PiRuntime** scrapes Realtor.com via Firecrawl → **Pi CLI** spawns three subagents
2. **CriterionEvaluator** validates properties against the skill schema
3. **Ranker** sorts by bedroom count, price, and value score
4. **ReporterAgent** produces structured JSON output

## Data Sources (priority order)

| Priority | Source | Method |
|----------|--------|--------|
| 1 | Realtor.com | Firecrawl rawHtml → JSON-LD extraction (schema.org structured data) |
| 2 | Realtor.com | Firecrawl markdown → regex parsing |
| 3 | Demo database | 53 pre-built properties across 20+ cities |

## Architecture

```
User → OrchestratorAgent
         ├→ MemoryAgent (NL → criteria)
         ├→ ScraperAgent (Firecrawl)
         ├→ PiRuntime (Pi CLI → subagents)
         └→ WatcherAgent (bg monitoring)
                ↓
         WebSocket → Frontend (live activity + property cards)
```

## Pi Collaborating Agents Integration

The backend spawns Pi CLI with a prompt that references `.claude/skills/firecrawl-real-estate-scraper/SKILL.md` and instructs it to coordinate three subagents: **CriterionEvaluator**, **Ranker**, and **ReporterAgent**. Property data is passed via stdin, and Pi returns a structured JSON response with ranked results and warnings.

### Prerequisites

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install npm:@baochunli/pi-collaborating-agents
```

## Skill Alignment

This project aligns with the [Firecrawl Real Estate Scraper](https://mcpmarket.com/zh/tools/skills/firecrawl-real-estate-scraper) skill from MCPMarket. The skill's `SKILL.md` guides Pi's validation, normalization, and ranking workflow.

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `FIRECRAWL_API_KEY` | Yes | Firecrawl API key for Realtor.com scraping |
| `DEEPSEEK_API_KEY` | Yes | DeepSeek API key for MemoryAgent NL parsing |
| `PI_RUNTIME_ENABLED` | Yes (for Pi mode) | Set to `"true"` |
| `RE_PROJECT_ROOT` | Yes (for Pi mode) | Project root path |

## Project Structure

```
real-estate-monitor/
├── backend/src/
│   ├── index.ts                    # Entry point
│   ├── agents/                     # Orchestrator, Memory, Scraper, Watcher agents
│   ├── skills/firecrawl-skill.ts   # Firecrawl (JSON-LD + markdown extraction)
│   ├── runtime/pi-runtime-service.ts  # Pi CLI process manager
│   ├── bridge/websocket-server.ts  # Socket.io + HTTP server
│   ├── mcp/mcp-server.ts           # MCP search_properties tool
│   └── core/                       # Types, storage
├── frontend/index.html             # SPA with chat + activity + property cards
├── .claude/skills/firecrawl-real-estate-scraper/SKILL.md
├── start.ps1
└── README.md
```

## Troubleshooting

- **Pi runtime is disabled**: Set `$env:PI_RUNTIME_ENABLED = "true"`
- **Firecrawl returns demo data**: Check your `FIRECRAWL_API_KEY`
- **Pi not found**: Verify `cmd /c pi --version` works
- **Browser can't connect**: Ensure backend is running and refresh the frontend

---

*Built with pi-collaborating-agents + Firecrawl*
