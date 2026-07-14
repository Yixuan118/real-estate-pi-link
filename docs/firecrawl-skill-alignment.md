## Firecrawl Real Estate Scraper Skill Reference

**Source:** [MCPMarket - Firecrawl Real Estate Scraper](https://mcpmarket.com/zh/tools/skills/firecrawl-real-estate-scraper)

## Purpose

This document records how the project aligns with and references the Firecrawl Real Estate Scraper skill provided by the mentor.

## Alignment Overview

| Aspect | Skill | This Project |
|--------|-------|-------------|
| Data source | Zillow, Redfin, Realtor.com, Trulia URLs | Realtor.com search pages |
| Extraction method | Firecrawl AI scrape | Firecrawl API scrape |
| Output format | Structured JSON with property schema | Property interface in types.ts |
| Validation | Schema validation | Runtime Pi agent validation via /collab-full |
| Fallback | Error handling | Demo database fallback |

## Property Schema Mapping

| Field | Skill Output | Project Property Interface |
|-------|-------------|--------------------------|
| Price | price | price: number |
| Bedrooms | bedrooms | bedrooms: number |
| Bathrooms | bathrooms | bathrooms: number |
| Square footage | sqft | sqft: number |
| Address / Location | address | location: string |
| Features / Amenities | features[] | features: string[] |
| Listing URL | url | url: string |
| Image URL | imageUrl | imageUrl: string |
| Listing date | listedAt | listedAt: string |
| Data source | source | source: string |

## Implementation Files

- `backend/src/skills/firecrawl-skill.ts` - Firecrawl scraping and parsing logic
- `backend/src/agents/scraper-agent.ts` - Agent that coordinates scraping
- `backend/src/core/types.ts` - Property data schema definition
