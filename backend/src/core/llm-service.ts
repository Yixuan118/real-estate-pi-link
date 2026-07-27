import { SearchCriteria, defaultSearchCriteria, ConversationEntry } from "./types";

import { normalizeDistanceConstraint } from "./property-matcher";
import { DEFAULT_LLM_MODEL } from "../config";

// DeepSeek / OpenAI compatible LLM service
// The LLM acts as an intelligent real estate assistant (sub-agent pattern)

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.RE_OPENAI_KEY || "";
const MODEL = process.env.RE_LLM_MODEL || DEFAULT_LLM_MODEL;
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
          candidateCriteria.distanceConstraints = result.updatedCriteria.distanceConstraints
            .map(normalizeDistanceConstraint)
            .filter((item): item is NonNullable<typeof item> => item !== null);
        }
        if (result.updatedCriteria.schoolMinRating !== undefined) {
          candidateCriteria.schoolMinRating = result.updatedCriteria.schoolMinRating;
        }
        if (result.updatedCriteria.schoolAtLeastOneRating !== undefined) {
          candidateCriteria.schoolAtLeastOneRating = result.updatedCriteria.schoolAtLeastOneRating;
        }
        if (result.updatedCriteria.schoolAssignmentRequired !== undefined) {
          candidateCriteria.schoolAssignmentRequired = result.updatedCriteria.schoolAssignmentRequired;
        }
        if (result.updatedCriteria.schoolAlternativePolicy) {
          candidateCriteria.schoolAlternativePolicy = result.updatedCriteria.schoolAlternativePolicy;
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

  const deterministic = regexExtract(userMessage, currentCriteria);
  if (!responseText) {
    Object.assign(candidateCriteria, deterministic.criteria);
    responseText = deterministic.response;
  } else {
    candidateCriteria.location ||= deterministic.criteria.location;
    candidateCriteria.exteriorMaterials ||= deterministic.criteria.exteriorMaterials;
    candidateCriteria.communityFeatures ||= deterministic.criteria.communityFeatures;
    candidateCriteria.highwayAccess ||= deterministic.criteria.highwayAccess;
    if (candidateCriteria.schoolMinRating === undefined) candidateCriteria.schoolMinRating = deterministic.criteria.schoolMinRating;
    if (candidateCriteria.schoolAtLeastOneRating === undefined) candidateCriteria.schoolAtLeastOneRating = deterministic.criteria.schoolAtLeastOneRating;
    if (candidateCriteria.schoolAssignmentRequired === undefined) candidateCriteria.schoolAssignmentRequired = deterministic.criteria.schoolAssignmentRequired;
    candidateCriteria.schoolAlternativePolicy ||= deterministic.criteria.schoolAlternativePolicy;
    const modelDistances = candidateCriteria.distanceConstraints || [];
    const fallbackDistances = deterministic.criteria.distanceConstraints || [];
    const combinedDistances = [...modelDistances];
    for (const constraint of fallbackDistances) {
      if (!combinedDistances.some((existing) => existing.name.toLowerCase() === constraint.name.toLowerCase()
        || existing.category === constraint.category)) {
        combinedDistances.push(constraint);
      }
    }
    if (combinedDistances.length > 0) candidateCriteria.distanceConstraints = combinedDistances;
  }

  const structuredFeatures = new Set([
    ...(candidateCriteria.exteriorMaterials || []),
    ...(candidateCriteria.communityFeatures || []),
  ].map((item) => item.toLowerCase()));
  if (candidateCriteria.mustHave) {
    candidateCriteria.mustHave = candidateCriteria.mustHave.filter((item) =>
      !structuredFeatures.has(item.toLowerCase()) && !isSchoolRatingRequirement(item));
  }

  const merged: SearchCriteria = {
    ...currentCriteria,
    ...candidateCriteria,
    mustHave: [...new Set([...(currentCriteria.mustHave || []), ...((candidateCriteria as any).mustHave || [])])]
      .filter((item) => !isSchoolRatingRequirement(item)),
    exteriorMaterials: candidateCriteria.exteriorMaterials || currentCriteria.exteriorMaterials,
    communityFeatures: candidateCriteria.communityFeatures || currentCriteria.communityFeatures,
    distanceConstraints: candidateCriteria.distanceConstraints || currentCriteria.distanceConstraints,
    schoolMinRating: candidateCriteria.schoolMinRating !== undefined ? candidateCriteria.schoolMinRating : currentCriteria.schoolMinRating,
    schoolAtLeastOneRating: candidateCriteria.schoolAtLeastOneRating !== undefined
      ? candidateCriteria.schoolAtLeastOneRating : currentCriteria.schoolAtLeastOneRating,
    schoolAssignmentRequired: candidateCriteria.schoolAssignmentRequired !== undefined ? candidateCriteria.schoolAssignmentRequired : currentCriteria.schoolAssignmentRequired,
    schoolAlternativePolicy: candidateCriteria.schoolAlternativePolicy || currentCriteria.schoolAlternativePolicy || "any-eligible-option",
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
    - location, maxPrice, minPrice, minBedrooms, minBathrooms, propertyType, mustHave, exteriorMaterials, communityFeatures, distanceConstraints, schoolMinRating, schoolAtLeastOneRating, schoolAssignmentRequired, schoolAlternativePolicy, highwayAccess
 3. "responseToUser": friendly natural response confirming what you understood
 
 Rules:
 - Extract location from text like "Seattle", "New York"
 - **IMPORTANT: Always output location names in English** (e.g., "Seattle" not "瑗块泤鍥?, "New York" not "绾界害")
 - **CRITICAL: Never include price-related words ("priced", "under", "million", "budget", "k", "thousand") in the location field**
 - Extract maxPrice from "under 1M" -> 1000000, "budget 500k" -> 500000, "priced under 1 million" -> 1000000
 - **Always output maxPrice in absolute dollar amounts** (e.g., $1M → 1000000, $500k → 500000, never "1" without unit conversion)
 - Extract minBedrooms from "3 bed" -> 3
- Extract features from "pool", "garage", "garden", "view"
- Put every requested fact that could be verified from a listing detail page and is not represented by a dedicated field above into mustHave as a concise phrase. Never silently discard an unfamiliar requirement.
- Extract exteriorMaterials from "four-sided brick", "brick on all four sides", or Chinese "四面砖墙" -> ["brick"]. Do not reduce this to a generic mustHave feature.
- Extract communityFeatures from "lake", "pond", "pool", "golf", "tennis" (e.g. "community lake" -> ["lake"])
- Extract schoolMinRating: "school rating >= 8" -> 8, "good schools" -> 7
- For compound rules such as "all schools >= 5 and at least one >= 8", set schoolMinRating=5 and schoolAtLeastOneRating=8. Never put a school-rating rule in mustHave.
- Set schoolAssignmentRequired=true for assigned/zoned schools or Chinese "所在的学校/划片学校/对口学校". Nearby schools alone are insufficient in this mode.
- If an official locator returns a placement pool instead of one unique school, normally use schoolAlternativePolicy="any-eligible-option": the grade level qualifies when at least one official option meets the requested score. Use "strict-unique-assignment" only when the user explicitly requires a uniquely assigned school.
- Resolve mildly ambiguous natural language using the most useful ordinary real-estate interpretation. Preserve hard numeric limits, do not silently weaken explicit requirements, and state any material assumption in responseToUser.
- Extract distanceConstraints as {name,maxMiles,category,lat?,lng?} from "within X miles of Y".
- For supermarket/grocery constraints use category="grocery" and do not invent coordinates.
- Known destination: UGA / University of Georgia => {name:"UGA",category:"university",lat:33.9480,lng:-83.3773}.
- Extract highwayAccess from "along GA-316", "near highway X", "exit within X miles" as {highwayName,maxMiles}.
 - Respond in the user's language
 - Be conversational and helpful, like a knowledgeable real estate agent
 - If user is just greeting or chatting, respond naturally without changing criteria
 - **ALWAYS include location** ? if UGA/Univ of Georgia mentioned, set location to "Athens, GA"
 - Do not infer Athens solely from GA-316; preserve an existing or explicitly stated city because GA-316 spans multiple counties.
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
    const data: any = await res.json();
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
export function regexExtract(input: string, current: SearchCriteria): { criteria: Partial<SearchCriteria>; response: string } {
  const normalizedInput = normalizeChineseNumbers(input);
  const lower = normalizedInput.toLowerCase();
  const criteria: Partial<SearchCriteria> & { mustHave?: string[] } = {};
  const changes: string[] = [];

  const commonCities = ["seattle", "new york", "san francisco", "los angeles", "bellevue", "redmond", "chicago", "boston", "austin", "denver", "miami", "dallas", "portland", "washington", "san diego", "athens"];
  // Find location first, then strip price-related words that may follow it
  let rawLocation: string | null = null;
  const explicitLocationMatch = normalizedInput.match(
    /\b(?:in|near|around)\s+([A-Za-z][A-Za-z .'-]{1,50}?),\s*([A-Za-z][A-Za-z .'-]{0,30}?)(?=\s+(?:with|under|over|below|above|priced|for|that|having|at\s+least|\d+\s*(?:bed|br|bath))|[.!?]|$)/i,
  ) || normalizedInput.match(/^\s*([A-Za-z][A-Za-z .'-]{1,50}?),\s*([A-Za-z][A-Za-z .'-]{0,30})\s*$/i);
  if (explicitLocationMatch) {
    const region = explicitLocationMatch[2].trim();
    criteria.location = `${explicitLocationMatch[1].trim()}, ${/^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : region}`;
    changes.push("Looking in " + criteria.location);
  }
  const genericLocationMatch = normalizedInput.match(
    /\b(?:in|near|around)\s+([A-Za-z][A-Za-z .'-]{1,50}?)(?=\s+(?:with|under|over|below|above|priced|for|that|having|at\s+least|\d+\s*(?:bed|br|bath))|[,.!?]|$)/i,
  );
  if (!criteria.location && genericLocationMatch) {
    criteria.location = genericLocationMatch[1].trim().split(/\s+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
    changes.push("Looking in " + criteria.location);
  }
  for (const city of commonCities) {
    if (!criteria.location && lower.includes(city)) {
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
  if (/\b(?:uga|university of georgia)\b/i.test(normalizedInput) || /佐治亚大学/i.test(normalizedInput)) {
    criteria.location = "Athens, GA";
    if (!changes.some((change) => change.startsWith("Looking in"))) changes.push("Looking in Athens, GA");
  }

  const underMatch = lower.match(/(?:under|priced under|budget|max)\s*\$?(\d+(?:\.\d+)?)\s*(m|k|million|thousand|mil)?/i);
  if (underMatch) { criteria.maxPrice = parsePrice(underMatch[1], underMatch[2]); changes.push("Max price: $" + criteria.maxPrice!.toLocaleString()); }

  const bedMatch = lower.match(/(?:\d+)\s*(?:bed|br|bedroom)/i);
  if (bedMatch) { criteria.minBedrooms = parseInt(bedMatch[0].match(/\d+/)?.[0] || "0"); changes.push("At least " + criteria.minBedrooms + " bed"); }

  const fourSidedBrick = /\b(?:four[- ]sided|4[- ]sided|all[- ]brick|brick (?:walls? )?on (?:all|four) sides)\b/i.test(normalizedInput)
    || /(?:四|4)面(?:外?墙)?(?:都?是)?砖|全砖外墙/.test(normalizedInput);
  if (fourSidedBrick) {
    criteria.exteriorMaterials = ["brick"];
    changes.push("Exterior: brick on all four sides");
  }

  if (/\b(?:community|neighborhood|subdivision)\b[^.，。]{0,30}\b(?:lake|pond)\b/i.test(normalizedInput)
      || /(?:小区|社区)[^，。]{0,20}(?:有湖|湖泊|池塘)/.test(normalizedInput)) {
    criteria.communityFeatures = [/pond|池塘/i.test(normalizedInput) ? "pond" : "lake"];
    changes.push("Community feature: lake");
  }

  const distanceConstraints = [];
  const groceryMatch = normalizedInput.match(/(?:supermarket|large grocery store|grocery store|超市|大型食品店)[^\d]{0,60}(?:不超过|within|under|no more than)?\s*(\d+(?:\.\d+)?)\s*(?:英里|miles?|mi)/i)
    || normalizedInput.match(/(?:within|under|no more than|不超过)\s*(\d+(?:\.\d+)?)\s*(?:英里|miles?|mi)[^，。]{0,30}(?:supermarket|large grocery store|grocery store|超市|大型食品店)/i);
  if (groceryMatch) distanceConstraints.push(normalizeDistanceConstraint({ name: "supermarket or large grocery store", maxMiles: Number(groceryMatch[1]), category: "grocery" }));
  const ugaMatch = normalizedInput.match(/(?:uga|university of georgia|佐治亚大学)[^\d]{0,25}(?:不超过|within|under|no more than)?\s*(\d+(?:\.\d+)?)\s*(?:英里|miles?|mi)/i)
    || normalizedInput.match(/(?:within|under|no more than|不超过)\s*(\d+(?:\.\d+)?)\s*(?:英里|miles?|mi)[^，。]{0,30}(?:uga|university of georgia|佐治亚大学)/i);
  if (ugaMatch) distanceConstraints.push(normalizeDistanceConstraint({ name: "UGA", maxMiles: Number(ugaMatch[1]), category: "university" }));
  const normalizedDistances = distanceConstraints.filter((item): item is NonNullable<typeof item> => item !== null);
  if (normalizedDistances.length) {
    criteria.distanceConstraints = normalizedDistances;
    changes.push("Distance limits: " + normalizedDistances.map((item) => `${item.name} ≤ ${item.maxMiles} miles`).join(", "));
  }

  const highwayMatch = normalizedInput.match(/\b(?:GA|SR|Georgia(?: State Route)?)[- ]?316\b|(?:佐治亚|乔治亚)\s*316\s*(?:号)?(?:公路)?/i);
  if (highwayMatch) {
    const exitDistanceMatch = normalizedInput.match(/(?:最近(?:的)?\s*)?(?:出口|入口)[^\d]{0,35}(?:不超过|小于|少于|within|under|no more than)?\s*(\d+(?:\.\d+)?)\s*(?:英里|miles?|mi)/i)
      || normalizedInput.match(/(?:within|under|no more than|不超过|小于|少于)\s*(\d+(?:\.\d+)?)\s*(?:英里|miles?|mi)[^，。]{0,35}(?:出口|入口|exit|access)/i)
      || normalizedInput.match(/(?:nearest\s+)?(?:exit|access)[^\d]{0,35}(?:within|under|no more than)?\s*(\d+(?:\.\d+)?)\s*(?:miles?|mi)/i);
    if (exitDistanceMatch) {
      criteria.highwayAccess = { highwayName: "GA-316", maxMiles: Number(exitDistanceMatch[1]) };
      changes.push(`GA-316 access ≤ ${exitDistanceMatch[1]} miles driving`);
    }
  }

  const compoundSchoolMatch = normalizedInput.match(/\bschools?\b[^.\d]{0,50}(?:at least|>=)\s*(\d{1,2})(?:\s*\/\s*10)?[^.]{0,80}\bat least one(?:\s+school)?\b[^.\d]{0,30}(?:rated?|scored?)?\s*(?:(?:at least|>=)\s*)?(\d{1,2})(?:\s*\/\s*10)?/i)
    || normalizedInput.match(/(?:评分)?(?:均|全部)\s*(?:不低于|至少|>=)\s*(\d{1,2})[^。]{0,60}(?:其中)?(?:至少[一1]所|其中[一1]所)\s*(?:评分)?\s*(?:不低于|至少|>=)\s*(\d{1,2})/i)
    || normalizedInput.match(/(?:all\s+)?schools?[^.\d]{0,30}(?:at least|>=)\s*(\d{1,2})[^.]{0,60}(?:at least one|one school)[^.\d]{0,20}(?:at least|>=)\s*(\d{1,2})/i);
  if (compoundSchoolMatch) {
    const minimum = Number(compoundSchoolMatch[1]);
    const atLeastOne = Number(compoundSchoolMatch[2]);
    if (minimum >= 1 && minimum <= 10 && atLeastOne >= minimum && atLeastOne <= 10) {
      criteria.schoolMinRating = minimum;
      criteria.schoolAtLeastOneRating = atLeastOne;
      criteria.schoolAssignmentRequired = /所在(?:的)?|划片|对口|assigned|zoned/i.test(normalizedInput);
      criteria.schoolAlternativePolicy = current.schoolAlternativePolicy || "any-eligible-option";
      changes.push(`K-12 ratings all ≥ ${minimum}/10 and at least one ≥ ${atLeastOne}/10`);
    }
  }

  const schoolRatingMatch = normalizedInput.match(/(?:k\s*[-–]?\s*12\s*)?(?:school|schools|学校)[^\d，。]{0,35}(?:rating|score|评分|打分)[^\d，。]{0,20}(?:至少|不低于|以上|>=|over|at least)?\s*(\d{1,2})/i)
    || normalizedInput.match(/(?:rating|score|评分|打分)[^\d，。]{0,20}(?:至少|不低于|以上|>=|over|at least)?\s*(\d{1,2})[^，。]{0,25}(?:school|schools|学校)/i);
  if (schoolRatingMatch && !compoundSchoolMatch) {
    const rating = Number(schoolRatingMatch[1]);
    if (rating >= 1 && rating <= 10) {
      criteria.schoolMinRating = rating;
      criteria.schoolAssignmentRequired = /所在(?:的)?|划片|对口|assigned|zoned/i.test(normalizedInput);
      changes.push(`Realtor-listed K-12 school ratings ≥ ${rating}/10`);
    }
  }

  if (/(?:只要|任意|任何)(?:候选|可能|其中)?(?:有)?(?:一|1)所[^，。]{0,20}(\d{1,2})\s*分?(?:以上|或以上|不低于|>=)/i.test(normalizedInput)
      || /any (?:one )?(?:possible |candidate )?school[^.]{0,20}(?:at least|>=)\s*(\d{1,2})/i.test(normalizedInput)) {
    criteria.schoolAlternativePolicy = "any-eligible-option";
    changes.push("For a non-unique official school placement pool, any qualifying option is acceptable");
  }

  const features = ["pool", "garage", "parking", "garden", "view", "balcony", "fireplace", "gym", "stone", "golf"];
  const newFeats: string[] = [];
  for (const f of features) { if (lower.includes(f) && !(current.mustHave || []).includes(f) && !newFeats.includes(f)) newFeats.push(f); }
  if (newFeats.length > 0) { criteria.mustHave = [...(current.mustHave || []), ...newFeats]; changes.push("Features: " + newFeats.join(", ")); }

  const response = changes.length > 0
    ? "Got it! " + changes.join(". ") + ". I will search for matching properties."
    : "Hi! I am your real estate assistant. Tell me about your ideal home!";
  return { criteria, response };
}

function isSchoolRatingRequirement(value: string): boolean {
  return /school.*rating|rating.*school|学校.*评分|评分.*学校|至少一所.*(?:评分|不低于)|at least one school/i.test(value);
}

function normalizeChineseNumbers(value: string): string {
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  return value.replace(/[零一二两三四五六七八九十]+/g, (token) => {
    if (!token.includes("十")) return token.split("").map((character) => digits[character]).join("");
    const [tens, ones] = token.split("十");
    return String((tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0));
  });
}

function parsePrice(s: string, suffix?: string): number {
  const n = parseFloat(s.replace(/[$,]/g, ""));
  if (suffix) { const sfx = suffix.toLowerCase(); if (sfx === "m" || sfx === "million") return n * 1000000; if (sfx === "k") return n * 1000; }
  return n;
}
