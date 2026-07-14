# Pi Runtime Demo

**Date:** 2026-07-09

## Input

```
/collab I am looking for a 3-bedroom house in Seattle under 1 million
```

## Observed Activity Feed

```
PiRuntime ⏳: Calling Pi collaborating agents for collaborative analysis...
CriterionEvaluator: All 5 properties are located in Seattle.
CriterionEvaluator: All properties are under $1,000,000.
CriterionEvaluator: All properties have at least 3 bedrooms.
Ranker: Sorted first by exact 3-bedroom match (preferred), then by ascending price.
PiRuntime ✅: Pi collaborating agents analysis complete
```

## What Happened

1. Frontend sends `/collab` message to WebSocket bridge
2. OrchestratorAgent detects `/collab` prefix
3. MemoryAgent extracts criteria: `location=Seattle, maxPrice=1000000, minBedrooms=3`
4. ScraperAgent searches Realtor.com via Firecrawl and finds 5 matching properties
5. PiRuntimeService spawns Pi CLI with the property data via stdin
6. Pi analyzes the data using CriterionEvaluator and Ranker roles
7. Pi returns structured JSON with `agent_activity` and `ranked_property_ids`
8. Frontend displays agent activity in real-time

## Key Files

| File | Role |
|------|------|
| `AGENTS.md` | Pi collaboration instructions (runtime roles, output schema) |
| `backend/src/runtime/pi-runtime-service.ts` | Spawns Pi, passes data via stdin, parses JSON response |
| `backend/src/agents/orchestrator-agent.ts` | Detects `/collab` prefix, calls PiRuntimeService |
| `backend/scripts/run-pi-runtime.cmd` | Wrapper script with hardcoded Pi arguments |

## Configuration

To enable Pi runtime mode:

```powershell
$env:PI_RUNTIME_ENABLED="true"
```

**Prerequisites:** Pi CLI installed globally + collaborating-agents extension.

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install npm:@baochunli/pi-collaborating-agents
```
