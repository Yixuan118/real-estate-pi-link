# Firecrawl Real Estate Scraper

## Description
A skill for scraping and extracting structured real estate property data using Firecrawl AI. Designed for integration with multi-agent real estate search and monitoring systems.

## When to Use
- User asks to find/search/look for properties (houses, apartments, condos)
- User specifies criteria: location, price range, bedrooms, bathrooms, features
- User wants to monitor new listings in an area
- User needs property details for comparison or analysis

## How to Use

### 1. Search by Criteria
Call Firecrawl to scrape Realtor.com search results (Zillow blocks automated scrapers).

Build the search URL:
```
https://www.realtor.com/realestateandhomes-search/{city}_{state}
```

### 2. Extract Structured Data
Parse the scraped markdown content to extract:

- **price**: Numeric value in USD
- **bedrooms**: Integer count
- **bathrooms**: Integer or decimal count
- **sqft**: Square footage
- **address**: Street address
- **location**: City, State
- **features**: Array of strings (pool, garage, etc.)
- **url**: Source URL

### 3. Handle Failures
If Firecrawl returns no data or the response is empty:
- Log the error
- Fall back to demo database if available
- Continue with partial or cached results

## Output Schema

Each property should be returned as:

```json
{
  "id": "unique_identifier",
  "title": "Property title/address",
  "price": 850000,
  "bedrooms": 3,
  "bathrooms": 2,
  "sqft": 1800,
  "location": "Seattle, WA",
  "features": ["garage", "pool", "hardwood floors"],
  "url": "listing_url",
  "imageUrl": "image_url",
  "listedAt": "2026-07-09T00:00:00.000Z",
  "source": "realtor.com (via Firecrawl)"
}
```

## Project Integration

This project implements the Firecrawl Real Estate Scraper pattern in three layers:

| Layer | File | Purpose |
|-------|------|---------|
| Agent Instruction | `.claude/skills/firecrawl-real-estate-scraper/SKILL.md` | Guides Pi/Claude on real estate scraping workflow |
| Backend Service | `backend/src/skills/firecrawl-skill.ts` | Firecrawl API calls + markdown parsing + demo fallback |
| MCP Tool | `backend/src/mcp/mcp-server.ts` | Exposes `search_properties` MCP tool for any MCP host |
| Runtime Agent | `backend/src/runtime/pi-runtime-service.ts` | Pi collaborating agents for validation and ranking |

## Usage in This Project

### Via Web UI
```
/collab I want a 3-bedroom house in Seattle under 1M
/collab-full I want a 3-bedroom house in Seattle under 1M
```

### Via MCP
Connect any MCP host using `mcp.json` at project root.

### Via Pi CLI
```bash
pi --tool "search_properties:command=npx tsx backend/src/mcp/mcp-server.ts"
```

## API Key Configuration
```bash
export FIRECRAWL_API_KEY="your_firecrawl_key"
```

## Notes
- Zillow blocks automated scraping. The project uses Realtor.com as the primary data source.
- Firecrawl returns markdown content which is parsed into structured property objects.
- If Firecrawl fails, a demo database with 45+ properties is used as fallback.
