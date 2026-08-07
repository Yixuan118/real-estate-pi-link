import { firecrawlSkill } from "../skills/firecrawl-skill";
import { SearchCriteria, Property } from "../core/types";
import * as readline from "node:readline";
import { schoolRatingService } from "../services/school-rating-service";
import { officialSchoolAssignmentService } from "../services/official-school-assignment-service";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line: string) => {
  try {
    const msg = JSON.parse(line);
    await handleMessage(msg);
  } catch (err) {
    // Ignore malformed messages
  }
});

process.on("uncaughtException", () => {});

async function handleMessage(msg: any) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      sendResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "real-estate-monitor", version: "1.0.0" },
      });
      break;

    case "notifications/initialized":
      break;

    case "tools/list":
      sendResponse(id, {
        tools: [
          {
            name: "search_properties",
            description:
              "Search real estate properties by location, price, bedrooms. Uses Firecrawl to scrape Realtor.com.",
            inputSchema: {
              type: "object",
              properties: {
                location: { type: "string", description: "City to search (e.g., Seattle, New York)" },
                maxPrice: { type: "number", description: "Maximum price in USD" },
                exactBedrooms: { type: "number", description: "Exact bedroom count" },
                minBedrooms: { type: "number", description: "Minimum bedrooms" },
                minBathrooms: { type: "number", description: "Minimum bathrooms" },
                propertyType: { type: "string", description: "Property type: house, condo, townhouse" },
                mustHave: { type: "array", items: { type: "string" }, description: "Required features" },
                exteriorMaterials: { type: "array", items: { type: "string" }, description: "Required exterior materials; brick means verified all-sides brick" },
                communityFeatures: { type: "array", items: { type: "string" }, description: "Required community amenities such as lake or pond" },
                distanceConstraints: {
                  type: "array",
                  description: "Maximum straight-line or listing-reported distances",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" }, maxMiles: { type: "number" },
                      category: { type: "string", enum: ["grocery", "university", "other"] },
                      lat: { type: "number" }, lng: { type: "number" },
                    },
                    required: ["name", "maxMiles"],
                  },
                },
                schoolMinRating: { type: "number", minimum: 1, maximum: 10, description: "Minimum 1-10 rating for Realtor-listed K-12 schools" },
                schoolAtLeastOneRating: { type: "number", minimum: 1, maximum: 10, description: "Additional threshold that at least one K-12 school must reach" },
                schoolAssignmentRequired: { type: "boolean", description: "Require schools assigned by an official attendance-zone locator, not merely nearby schools" },
              },
              required: ["location"],
            },
          },
          {
            name: "lookup_school_rating",
            description: "Look up source-backed 1-10 school ratings through targeted Realtor.com search. Nearby/assigned relationship is reported separately.",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "School name" },
                location: { type: "string", description: "City and state used to disambiguate the school" },
              },
              required: ["name"],
            },
          },
          {
            name: "lookup_school_assignment",
            description: "Resolve US Census/NCES school districts and, where configured, exact official attendance-zone assignments for a coordinate.",
            inputSchema: {
              type: "object",
              properties: {
                latitude: { type: "number" }, longitude: { type: "number" }, address: { type: "string" },
              },
              required: ["latitude", "longitude"],
            },
          },
        ],
      });
      break;

    case "tools/call":
      if (params?.name === "search_properties") {
        await handleSearchProperties(id, params.arguments || {});
      } else if (params?.name === "lookup_school_rating") {
        await handleSchoolRating(id, params.arguments || {});
      } else if (params?.name === "lookup_school_assignment") {
        await handleSchoolAssignment(id, params.arguments || {});
      } else {
        sendError(id, -32601, "Tool not found: " + (params?.name || "unknown"));
      }
      break;

    default:
      break;
  }
}

async function handleSearchProperties(id: any, args: any) {
  try {
    const criteria: SearchCriteria = {
      location: args.location || "",
      maxPrice: args.maxPrice,
      exactBedrooms: args.exactBedrooms,
      minBedrooms: args.minBedrooms,
      minBathrooms: args.minBathrooms,
      propertyType: args.propertyType,
      mustHave: args.mustHave || [],
      exteriorMaterials: args.exteriorMaterials,
      communityFeatures: args.communityFeatures,
      distanceConstraints: args.distanceConstraints,
      schoolMinRating: args.schoolMinRating,
      schoolAtLeastOneRating: args.schoolAtLeastOneRating,
      schoolAssignmentRequired: args.schoolAssignmentRequired,
      updatedAt: new Date().toISOString(),
    };

    const result = await firecrawlSkill.searchProperties(criteria);

    sendResponse(id, {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              source: result.source,
              totalCount: result.totalCount,
              error: result.error,
              properties: result.properties.map((p: Property) => ({
                id: p.id,
                title: p.title,
                price: p.price,
                bedrooms: p.bedrooms,
                bathrooms: p.bathrooms,
                fullBathrooms: p.fullBathrooms,
                halfBathrooms: p.halfBathrooms,
                sqftSource: p.sqftSource,
                sqft: p.sqft,
                location: p.location,
                features: p.features,
                exteriorMaterials: p.exteriorMaterials,
                exteriorCoverage: p.exteriorCoverage,
                communityFeatures: p.communityFeatures,
                schools: p.schools,
                schoolDistricts: p.schoolDistricts,
                nearbyPlaces: p.nearbyPlaces,
                distanceEvaluations: p.distanceEvaluations,
                latitude: p.latitude,
                longitude: p.longitude,
                coordinateSource: p.coordinateSource,
                evidenceDiagnostics: p.evidenceDiagnostics,
                criteriaMatch: p.criteriaMatch,
              })),
            },
            null,
            2
          ),
        },
      ],
    });
  } catch (err: any) {
    sendError(id, -32603, err.message || "Internal error");
  }
}

async function handleSchoolRating(id: any, args: any) {
  try {
    if (!String(args.name || "").trim()) return sendError(id, -32602, "School name is required");
    const schools = await schoolRatingService.lookupSchool(String(args.name), args.location ? String(args.location) : undefined);
    sendResponse(id, { content: [{ type: "text", text: JSON.stringify({ schools, warning: "Realtor nearby-school evidence does not verify attendance assignment." }, null, 2) }] });
  } catch (err: any) {
    sendError(id, -32603, err.message || "School rating lookup failed");
  }
}

async function handleSchoolAssignment(id: any, args: any) {
  try {
    const latitude = Number(args.latitude), longitude = Number(args.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return sendError(id, -32602, "Valid latitude and longitude are required");
    const property: Property = {
      id: "school-assignment-lookup", title: String(args.address || `${latitude},${longitude}`), price: 0,
      bedrooms: 0, bathrooms: 0, sqft: 0, location: "", features: [], url: "", listedAt: new Date().toISOString(),
      source: "MCP", latitude, longitude,
    };
    const result = await officialSchoolAssignmentService.enrichProperty(property);
    sendResponse(id, { content: [{ type: "text", text: JSON.stringify({ districts: result.schoolDistricts || [], assignedSchools: (result.schools || []).filter((school) => school.relationship === "assigned"), diagnostics: result.evidenceDiagnostics || [] }, null, 2) }] });
  } catch (err: any) {
    sendError(id, -32603, err.message || "School assignment lookup failed");
  }
}

function sendResponse(id: any, result: any) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id: any, code: number, message: string) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
  );
}
