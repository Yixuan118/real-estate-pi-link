import { SearchCriteria, defaultSearchCriteria, ConversationEntry } from "./types";

// DeepSeek / OpenAI compatible LLM service
// The LLM acts as an intelligent real estate assistant (sub-agent pattern)

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "YOUR_DEEPSEEK_API_KEY";
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.RE_OPENAI_KEY || "";
const MODEL = process.env.RE_LLM_MODEL || "deepseek-chat";
const API_BASE = process.env.RE_LLM_BASE_URL || "https://api.deepseek.com";
const API_KEY = DEEPSEEK_KEY || OPENAI_KEY;

interface LLMExtraction {
  reasoning: string;
  updatedCriteria: Partial<SearchCriteria>;
  responseToUser: string;
}

export async function extractCriteriaFromMessage(
  currentCriteria: SearchCriteria,
  userMessage: string,
  conversationHistory: string[],
): Promise<{ criteria: SearchCriteria; response: string }> {
  const candidateCriteria: Partial<SearchCriteria> = {};
  let responseText = "";

  if (API_KEY) {
    try {
      const result = await callLLM(currentCriteria, userMessage, conversationHistory);
      if (result) {
        if (result.updatedCriteria.location) candidateCriteria.location = result.updatedCriteria.location;
        if (result.updatedCriteria.minPrice !== undefined) candidateCriteria.minPrice = result.updatedCriteria.minPrice;
        if (result.updatedCriteria.maxPrice !== undefined) candidateCriteria.maxPrice = result.updatedCriteria.maxPrice;
        if (result.updatedCriteria.minBedrooms !== undefined) candidateCriteria.minBedrooms = result.updatedCriteria.minBedrooms;
        if (result.updatedCriteria.minBathrooms !== undefined) candidateCriteria.minBathrooms = result.updatedCriteria.minBathrooms;
        if (result.updatedCriteria.propertyType) candidateCriteria.propertyType = result.updatedCriteria.propertyType;
        if (result.updatedCriteria.exteriorMaterials?.length) {
          candidateCriteria.exteriorMaterials = result.updatedCriteria.exteriorMaterials;
        }
        if (result.updatedCriteria.communityFeatures?.length) {
          candidateCriteria.communityFeatures = result.updatedCriteria.communityFeatures;
        }
        if (result.updatedCriteria.distanceConstraints?.length) {
          candidateCriteria.distanceConstraints = result.updatedCriteria.distanceConstraints;
        }
        if (result.updatedCriteria.schoolMinRating !== undefined) {
          candidateCriteria.schoolMinRating = result.updatedCriteria.schoolMinRating;
        }
        if (result.updatedCriteria.highwayAccess) {
          candidateCriteria.highwayAccess = result.updatedCriteria.highwayAccess;
        }
        if (result.updatedCriteria.mustHave?.length) {
          candidateCriteria.mustHave = [...new Set([...(currentCriteria.mustHave || []), ...result.updatedCriteria.mustHave])];
        } else {
          candidateCriteria.mustHave = currentCriteria.mustHave;
        }
        responseText = result.responseToUser;
      }
    } catch (err) {
      console.warn("[LLM] API error, fallback:", err instanceof Error ? err.message : String(err));
    }
  }

  if (!responseText) {
    const extracted = regexExtract(userMessage, currentCriteria);
    Object.assign(candidateCriteria, extracted.criteria);
    responseText = extracted.response;
  }

  const merged: SearchCriteria = {
    ...currentCriteria,
    ...candidateCriteria,
    mustHave: [...new Set([...(currentCriteria.mustHave || []), ...((candidateCriteria as any).mustHave || [])])],
    exteriorMaterials: candidateCriteria.exteriorMaterials || currentCriteria.exteriorMaterials,
    communityFeatures: candidateCriteria.communityFeatures || currentCriteria.communityFeatures,
    distanceConstraints: candidateCriteria.distanceConstraints || currentCriteria.distanceConstraints,
    schoolMinRating: candidateCriteria.schoolMinRating !== undefined ? candidateCriteria.schoolMinRating : currentCriteria.schoolMinRating,
    highwayAccess: candidateCriteria.highwayAccess || currentCriteria.highwayAccess,
    updatedAt: new Date().toISOString(),
  };

  return { criteria: merged, response: responseText };
}

async function callLLM(current: SearchCriteria, userMessage: string, history: string[]): Promise<LLMExtraction | null> {
  const systemPrompt = `You are an intelligent real estate search assistant.
 
 Current criteria:
 ${JSON.stringify(current, null, 2)}
 
 Return JSON with:
 1. "reasoning": brief analysis
 2. "updatedCriteria": partial criteria updates (only changed fields)
    - location, maxPrice, minPrice, minBedrooms, minBathrooms, propertyType, mustHave, exteriorMaterials, communityFeatures, distanceConstraints, schoolMinRating, highwayAccess
 3. "responseToUser": friendly natural response confirming what you understood
 
 Rules:
 - Extract location from text like "Seattle", "New York"
 - **IMPORTANT: Always output location names in English** (e.g., "Seattle" not "瑗块泤鍥?, "New York" not "绾界害")
 - **CRITICAL: Never include price-related words ("priced", "under", "million", "budget", "k", "thousand") in the location field**
 - Extract maxPrice from "under 1M" -> 1000000, "budget 500k" -> 500000, "priced under 1 million" -> 1000000
 - **Always output maxPrice in absolute dollar amounts** (e.g., $1M → 1000000, $500k → 500000, never "1" without unit conversion)
 - Extract minBedrooms from "3 bed" -> 3
 - Extract features from "pool", "garage", "garden", "view"
- Extract exteriorMaterials from "brick", "stone", "stucco" (e.g. "brick walls" -> ["brick"])
- Extract communityFeatures from "lake", "pond", "pool", "golf", "tennis" (e.g. "community lake" -> ["lake"])
- Extract schoolMinRating: "school rating >= 8" -> 8, "good schools" -> 7
- Extract distanceConstraints from "within X miles of Y" (known: UGA lat=33.9480 lng=-83.3773)
- Extract highwayAccess from "along GA-316", "near highway X", "exit within X miles"
 - Respond in the user's language
 - Be conversational and helpful, like a knowledgeable real estate agent
 - If user is just greeting or chatting, respond naturally without changing criteria
 - **ALWAYS include location** ? if UGA/Univ of Georgia mentioned, set location to "Athens, GA"
 - When user mentions GA-316 or highway 316, set location to "Athens, GA" (near Atlanta)
`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-8).map((h) => ({ role: "user" as const, content: h })),
    { role: "user", content: userMessage },
  ];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(API_BASE + "/chat/completions", {
      signal: controller.signal,
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY },
      body: JSON.stringify({
        model: MODEL,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.3,
        max_tokens: 1024,
      }),
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error("LLM API error " + res.status + ": " + (await res.text()).substring(0, 200));
    const data = await res.json();
    const content: string = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as LLMExtraction;
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn("[LLM] API call failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// Regex fallback
function regexExtract(input: string, current: SearchCriteria): { criteria: Partial<SearchCriteria>; response: string } {
  const lower = input.toLowerCase();
  const criteria: Partial<SearchCriteria> & { mustHave?: string[] } = {};
  const changes: string[] = [];

  const commonCities = ["seattle", "new york", "san francisco", "los angeles", "bellevue", "redmond", "chicago", "boston", "austin", "denver", "miami", "dallas", "portland", "washington", "san diego"];
  // Find location first, then strip price-related words that may follow it
  let rawLocation: string | null = null;
  for (const city of commonCities) {
    if (lower.includes(city)) {
      rawLocation = city;
      break;
    }
  }
  if (rawLocation) {
    // Strip any trailing price-related noise (e.g. "new york priced" → "new york")
    const cleaned = rawLocation.replace(/\s+(priced|under|budget|max|million|thousand|k).*/i, "").trim();
    criteria.location = cleaned.split(" ").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    changes.push("Looking in " + criteria.location);
  }

  const underMatch = lower.match(/(?:under|priced under|budget|max)\s*\$?(\d+(?:\.\d+)?)\s*(m|k|million|thousand|mil)?/i);
  if (underMatch) { criteria.maxPrice = parsePrice(underMatch[1], underMatch[2]); changes.push("Max price: $" + criteria.maxPrice!.toLocaleString()); }

  const bedMatch = lower.match(/(?:\d+)\s*(?:bed|br|bedroom)/i);
  if (bedMatch) { criteria.minBedrooms = parseInt(bedMatch[0].match(/\d+/)[0]); changes.push("At least " + criteria.minBedrooms + " bed"); }

  const features = ["pool", "garage", "parking", "garden", "view", "balcony", "fireplace", "gym", "brick", "stone", "lake", "pond", "golf"];
  const newFeats: string[] = [];
  for (const f of features) { if (lower.includes(f) && !(current.mustHave || []).includes(f) && !newFeats.includes(f)) newFeats.push(f); }
  if (newFeats.length > 0) { criteria.mustHave = [...(current.mustHave || []), ...newFeats]; changes.push("Features: " + newFeats.join(", ")); }

  const response = changes.length > 0
    ? "Got it! " + changes.join(". ") + ". I will search for matching properties."
    : "Hi! I am your real estate assistant. Tell me about your ideal home!";
  return { criteria, response };
}

function parsePrice(s: string, suffix?: string): number {
  const n = parseFloat(s.replace(/[$,]/g, ""));
  if (suffix) { const sfx = suffix.toLowerCase(); if (sfx === "m" || sfx === "million") return n * 1000000; if (sfx === "k") return n * 1000; }
  return n;
}
