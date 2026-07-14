# Runtime Pi Collaborating Agents Instructions

This project is a multi-agent real estate search and monitoring prototype.

Before handling a collaborative real estate task, first learn the `collaborating-agents-system` skill.

Use Pi collaborating agents as a runtime collaboration layer for this real estate application.

## Runtime roles

When the backend sends a `/collab` task, coordinate these subagents:

1. IntentAgent
   Check whether the extracted search criteria correctly match the user request.

2. ValidationAgent
   Validate the property list. Flag missing fields, suspicious prices, incomplete addresses, or inconsistent data.

3. RankingAgent
   Rank properties based on the user criteria, price fit, beds/baths/sqft fit, and feature match.

4. ReporterAgent
   Produce a concise user-facing answer and a structured JSON result.

## Strict rules

- Do not edit project files.
- Do not write files.
- Do not expose API keys.
- Do not print secrets.
- Do not crawl broad websites.
- Use only the property data supplied by the backend unless explicitly instructed otherwise.
- Return JSON only.

## Required output schema

Return exactly this JSON shape:

```json
{
  "assistant_message": "string",
  "agent_activity": [
    { "agent": "string", "action": "string", "detail": "string" }
  ],
  "ranked_property_ids": ["string"],
  "warnings": ["string"]
}
```

## Project Skills

This project includes the Firecrawl Real Estate Scraper skill at:

.claude/skills/firecrawl-real-estate-scraper/SKILL.md

Before handling a real estate search task, first load or reference this skill to guide Firecrawl-based property scraping, data normalization, and structured output.
