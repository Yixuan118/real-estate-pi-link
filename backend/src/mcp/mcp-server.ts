import { firecrawlSkill } from "../skills/firecrawl-skill";
import { SearchCriteria, Property } from "../core/types";
import * as readline from "node:readline";

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
                minBedrooms: { type: "number", description: "Minimum bedrooms" },
                minBathrooms: { type: "number", description: "Minimum bathrooms" },
                propertyType: { type: "string", description: "Property type: house, condo, townhouse" },
                mustHave: { type: "array", items: { type: "string" }, description: "Required features" },
              },
              required: ["location"],
            },
          },
        ],
      });
      break;

    case "tools/call":
      if (params?.name === "search_properties") {
        await handleSearchProperties(id, params.arguments || {});
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
      minBedrooms: args.minBedrooms,
      minBathrooms: args.minBathrooms,
      propertyType: args.propertyType,
      mustHave: args.mustHave || [],
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
                sqft: p.sqft,
                location: p.location,
                features: p.features,
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

function sendResponse(id: any, result: any) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id: any, code: number, message: string) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
  );
}
