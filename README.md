# Property Evidence AI

An English-language, evidence-backed real estate research application built with Pi collaborating agents. It searches live Realtor.com listings, reads relevant detail pages once, verifies map constraints with HERE or Google, validates school evidence, and ranks properties without treating missing data as satisfied.

## Instructor demo

1. Open the deployed URL or `http://localhost:3742`.
2. Click **Complex evidence search**.
3. Press **Search**.
4. Follow MemoryAgent, PiRuntime, ValidationAgent, RankingAgent, and ReporterAgent in the live activity panel.
5. Inspect the parsed criteria and the `Verified / Unknown / Failed` evidence checks on each property.
6. Expand **Listing evidence snapshot** and open the Realtor source link.

Recommended demonstration prompts:

```text
Find 3-bedroom homes in Seattle, WA under $1,000,000.
```

```text
Find homes in Athens, GA with four-sided brick, a community lake, a supermarket within 3 driving miles, UGA within 30 driving miles, and assigned K-12 schools all rated at least 5/10 with at least one rated 8/10.
```

```text
Find homes in Athens, GA within 3 driving miles of legal access to GA-316.
```

## What is verified

| Requirement | Evidence policy |
|---|---|
| Requested US market | City and state must match the listing; the application never silently defaults to Athens. |
| Four-sided brick | Requires explicit listing evidence such as `Brick 4 Side`, `four-sided brick`, or equivalent structured MLS data. A brick-front mention is insufficient. |
| Community lake | Requires the listing, HOA, subdivision, or community section to identify a lake/pond amenity. A nearby public lake is insufficient. |
| Grocery distance | HERE or Google discovers grocery POIs and verifies the driving route. Realtor neighborhood distances are retained as additional listing evidence. |
| UGA distance | The property is geocoded and routed to the configured University of Georgia coordinate. |
| GA-316 access | HERE routing measures distance to a legal point where the route joins GA-316, not distance to the road centerline. |
| K-12 ratings | Elementary, middle, and high schools displayed in the Realtor property page's Community and Schools section are accepted as property-level evidence and clearly labeled as Realtor-sourced. Official district locators remain a fallback. |
| Unknown listing facts | Missing evidence remains `unknown`; it is never promoted to a match by the LLM. |

## Complete listing-detail extraction

For any page-verifiable requirement, the search-card stage retains the candidate and reads its Realtor detail page. One detail response is reused for:

- property description and all labelled Property Details;
- Interior, Exterior, Construction, Utilities, HOA, Community, and Subdivision facts;
- Neighborhood groceries, shopping, transportation, and amenities;
- listing-agent schools, nearby school ratings, grades, and distances;
- coordinates and structured MLS/JSON data;
- generic natural-language requirements that do not yet have a dedicated field.

The normalized `listingFacts` and source URL are shown in the UI and supplied to Pi. If a required dynamic section is genuinely absent, the backend can continue the same Firecrawl browser session, expand multiple relevant controls/tabs, collect each section, and close the session. This conditional fallback is capped by search and is not used when the initial HTML is complete.

## Quick start on Windows

Store API keys in Windows user environment variables instead of committing them:

```powershell
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "your-key", "User")
[Environment]::SetEnvironmentVariable("FIRECRAWL_API_KEY", "your-key", "User")
[Environment]::SetEnvironmentVariable("HERE_API_KEY", "your-key", "User")
```

Open a new PowerShell window, then run:

```powershell
cd C:\path\to\real-estate-pi-main\backend
npm install
npm run dev
```

Open [http://localhost:3742](http://localhost:3742). The backend serves the frontend and Socket.IO from the same origin.

## Deployment on Render

The repository includes `render.yaml` and a production `Dockerfile`.

1. Push the repository to GitHub.
2. In Render, create a **Blueprint** from the repository.
3. Enter `DEEPSEEK_API_KEY`, `FIRECRAWL_API_KEY`, and `HERE_API_KEY` when prompted.
4. Wait for `/health` to pass.
5. Share the HTTPS service URL with the instructor.

Local container verification:

```powershell
docker build -t property-evidence-ai .
docker run --rm -p 10000:10000 `
  -e DEEPSEEK_API_KEY="..." `
  -e FIRECRAWL_API_KEY="..." `
  -e HERE_API_KEY="..." `
  property-evidence-ai
```

Open `http://localhost:10000`; health check: `http://localhost:10000/health`.

## Architecture

```text
Browser
  -> WebSocket Orchestrator
      -> MemoryAgent: natural language -> search criteria
      -> PiRuntime: integrated Realtor research and evidence enrichment
      -> Official school assignment adapters
      -> HERE/Google geocoding, POI search, and routing
      -> PiRuntime
          -> IntentAgent
          -> ValidationAgent
          -> RankingAgent
          -> ReporterAgent
  <- evidence checks, ranked property cards, source links
```

The deterministic `criteriaMatch` layer is authoritative for verified, failed, and unknown status. Pi explains and ranks the supplied evidence but cannot override an unknown check as satisfied.

## Cost controls

- Results and all enrichment stages are capped at 20 properties.
- A per-search Firecrawl credit budget defaults to 30, or 45 for school-evidence searches. This covers up to 20 shared detail pages plus a few conditional school-panel/profile fallbacks while retaining a hard ceiling.
- Firecrawl response-level `creditsUsed` is reconciled with the local budget.
- Realtor detail pages, school ratings, assignments, listing searches, and map calls are cached/deduplicated where appropriate.
- One detail page is reused across listing facts, community facts, nearby facilities, and school ratings.
- New-construction cards with an integer bath summary receive a cached exact-address full/half-bath check, capped at five properties by default.
- Realtor detail pages are parsed first. If a requested dynamic school section is absent, resumed Interact can run for every retained property (maximum 20); non-school dynamic expansion keeps the smaller default cap of three.
- Searches retain up to 20 candidates, including school-evidence searches. When hard filters leave fewer than 10 candidates on the first Realtor page, the backend can inspect up to two additional result pages.
- School searches read each retained Realtor detail page by default because its Community and Schools section is the best property-level source. Set `RE_REALTOR_SCHOOL_DETAIL_ENABLED=false` only as an emergency cost-control override.
- Targeted feature search runs only when the detail page did not already answer the requirement.
- Interactive expansion runs only when a requested section is missing; one session can expand multiple relevant panels.
- Background monitoring is disabled unless `RE_WATCHER_ENABLED=true`.
- Demo fallback is disabled unless `RE_ALLOW_DEMO_FALLBACK=true`.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | Yes | Natural-language criteria extraction and Pi-compatible reasoning. |
| `FIRECRAWL_API_KEY` | Yes | Realtor search/detail scraping and limited evidence fallbacks. |
| `HERE_API_KEY` | Recommended | Geocoding, grocery POI discovery, driving routes, and GA-316 access. |
| `GOOGLE_MAPS_API_KEY` | Alternative | Google geocoding, Places, and Routes provider. |
| `PI_RUNTIME_ENABLED` | Yes for collaboration | Set to `true`. |
| `RE_MAP_PROVIDER` | No | `here`, `google`, or automatic selection. |
| `RE_GEO_DISTANCE_MODE` | No | Use `DRIVE` for named destination routes. Grocery always uses driving distance. |
| `RE_DETAIL_ENRICH_LIMIT` | No | Detail pages per search; default/max `20`. |
| `RE_SCHOOL_ENRICH_LIMIT` | No | School-enriched properties; default/max `20`. |
| `RE_GEO_ENRICH_LIMIT` | No | Map-enriched properties; default `20`. |
| `RE_HIGHWAY_PROBE_CANDIDATE_LIMIT` | No | Nearby points on a named highway checked per property; default `8`, range `2-16`. |
| `RE_FIRECRAWL_REQUEST_BUDGET` | No | Per-search Firecrawl credit ceiling. Completeness floors are 30 normally and 45 for school searches; stale lower values are ignored. |
| `RE_BATHROOM_VERIFY_LIMIT` | No | Exact-address full/half-bath checks for high-risk new-construction cards; default `5`, max `10`. |
| `RE_MIN_RESULT_TARGET` | No | Minimum candidate target before bounded Realtor pagination; default `10`. |
| `RE_LISTING_PAGE_LIMIT` | No | Maximum Realtor result pages inspected to reach the target; default `3`, max `5`. |
| `RE_REALTOR_SCHOOL_DETAIL_ENABLED` | No | Realtor detail-page school extraction; default `true`. Set `false` only as an emergency cost override. |
| `RE_INTERACT_FALLBACK_ENABLED` | No | Conditional dynamic-section expansion; default `true`. |
| `RE_INTERACT_FALLBACK_LIMIT` | No | Interactive listing sessions per search; school default/max `20`, other queries default `3`. |
| `RE_WATCHER_ENABLED` | No | Opt-in periodic monitoring; default disabled. |
| `RE_ALLOW_DEMO_FALLBACK` | No | Explicit offline demo listings; default disabled. |

## School evidence limitations

Nationwide school filtering first reuses the elementary, middle, and high schools and 1–10 ratings displayed in each Realtor property page's Community and Schools section. These rows are labeled `listed for this property`, not government-certified attendance assignments. If that section is incomplete, the application can fall back to Census/NCES district evidence and configured official district locator adapters. Athens/Clarke County also includes a parser for the official CCSD Street Index. A separate broad nearby-school search is never allowed to masquerade as property-level evidence.

School ratings may change and different publishers can refresh on different schedules. Every displayed rating retains its source URL and check time.

## Zillow policy

Zillow does not provide a supported public nationwide listings API for this project and restricts automated extraction. Each property card therefore provides a user-initiated Zillow address search link, while Realtor remains the structured listing source.

## Verification

```powershell
cd backend
npm run build
npm test
node --check ..\frontend\app.js
```

The test suite covers natural-language criteria, evidence extraction, four-sided brick, community amenities, grocery/UGA routing, GA-316 access, school assignment and rating policies, Firecrawl budgets, dynamic-section completeness, caching, and the 20-property cap.

## Project structure

```text
backend/src/
  agents/                         Runtime orchestration
  bridge/websocket-server.ts      Same-origin HTTP + Socket.IO server
  core/                           Criteria, matching, reports, storage
  runtime/pi-runtime-service.ts   Pi collaboration layer
  services/                       Maps, schools, evidence, caches, budgets
  skills/firecrawl-skill.ts       Realtor search/detail enrichment
frontend/
  index.html                      English single-page interface
  app.js                          WebSocket client and evidence rendering
  style.css                       Responsive presentation
render.yaml                       Render Blueprint
Dockerfile                        Production container
```

Never commit API keys. If a key has been pasted into chat, logs, or source control, rotate it before deployment.
