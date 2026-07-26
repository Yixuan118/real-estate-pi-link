import {
  ConstraintMatch,
  DistanceConstraint,
  Property,
  PropertyCriteriaMatch,
  SearchCriteria,
} from "./types";
import { extractSchoolEvidence } from "../services/school-rating-service";

const EARTH_RADIUS_MILES = 3958.8;

export const KNOWN_DESTINATIONS: Record<string, { name: string; lat: number; lng: number; category: "university" }> = {
  uga: { name: "UGA", lat: 33.948, lng: -83.3773, category: "university" },
  "university of georgia": { name: "UGA", lat: 33.948, lng: -83.3773, category: "university" },
};

export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (degrees: number) => degrees * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function normalizeDistanceConstraint(input: Partial<DistanceConstraint>): DistanceConstraint | null {
  const rawName = String(input.name || "").trim();
  const maxMiles = Number(input.maxMiles);
  if (!rawName || !Number.isFinite(maxMiles) || maxMiles <= 0) return null;

  const key = rawName.toLowerCase();
  const known = KNOWN_DESTINATIONS[key];
  const isGrocery = input.category === "grocery" || /supermarket|grocery|超市|大型食品店/i.test(rawName);
  return {
    name: known?.name || rawName,
    maxMiles,
    category: known?.category || (isGrocery ? "grocery" : input.category || "other"),
    lat: finiteNumber(input.lat) ?? known?.lat,
    lng: finiteNumber(input.lng) ?? known?.lng,
  };
}

export function extractPropertyEvidence(property: Property, content: string): Property {
  const visibleText = decodeHtml(content).replace(/\s+/g, " ").trim();
  const text = `${visibleText} ${decodeEmbeddedData(content)}`.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const exteriorMaterials = new Set(property.exteriorMaterials || []);
  const communityFeatures = new Set(property.communityFeatures || []);
  const originalCommunityWater = new Set([...communityFeatures].filter((item) => /lake|pond/i.test(item)));
  const featureEvidence = [...(property.featureEvidence || [])];
  const nearbyPlaces = [...(property.nearbyPlaces || [])];

  if (/\b(?:four[- ]sided|4[- ]sided|all[- ]brick|brick\s*4\s*sides?|brick on (?:all|four) sides|full brick exterior)\b/i.test(text)
      || /四面(?:外墙)?(?:都?是)?砖|全砖外墙/.test(text)) {
    exteriorMaterials.add("brick");
    property.exteriorCoverage = "all-sides";
  } else if (/\bbrick (?:exterior|front|accent|veneer)\b|砖墙|砖饰面/i.test(text)) {
    exteriorMaterials.add("brick");
    property.exteriorCoverage = property.exteriorCoverage || "partial";
  }

  if (/\b(?:community|neighborhood|subdivision|hoa|association|amenit(?:y|ies)|residents?|common areas?|shared)[^.;]{0,180}\b(?:lake|pond)\b/i.test(text)
      || /\b(?:lake|pond)\b[^.;]{0,180}\b(?:community|neighborhood|subdivision|hoa|association|amenit(?:y|ies)|residents?|resident access|privileges?|common areas?|shared|maintained)\b/i.test(text)
      || /\b(?:lake|pond)\s+(?:access|privileges?|amenit(?:y|ies))\b/i.test(text)
      || /\b(?:community features?|association amenities?|subdivision amenities?|neighborhood amenities?)\s*[:\-]\s*[^.;]{0,240}\b(?:lake|pond)\b/i.test(text)
      || /小区|社区/.test(text) && /湖|池塘/.test(text)) {
    communityFeatures.add(lower.includes("pond") || text.includes("池塘") ? "pond" : "lake");
  }

  // Replace the legacy page-wide guess above with field-level Realtor
  // evidence. This prevents an unrelated photo tag such as "pond" from
  // overriding an explicit "Community Features: Lake" MLS field.
  const communityWater = extractCommunityWaterEvidence(content);
  for (const existing of [...communityFeatures]) {
    if (/lake|pond/i.test(existing) && !originalCommunityWater.has(existing)) communityFeatures.delete(existing);
  }
  for (const feature of communityWater.features) communityFeatures.add(feature);
  if (communityWater.features.length && property.url) {
    const excerpt = communityWater.snippets.find((snippet) => /\b(?:lake|pond)\b/i.test(snippet));
    const existingEvidence = featureEvidence.find((item) =>
      item.criterion === "community-lake" && item.sourceUrl === property.url);
    if (existingEvidence) {
      if (!existingEvidence.excerpt && excerpt) existingEvidence.excerpt = excerpt;
    } else {
      featureEvidence.push({
        criterion: "community-lake", sourceUrl: property.url, source: "realtor-listing",
        checkedAt: new Date().toISOString(), excerpt,
      });
    }
  }

  extractNearbyDistances(text).forEach((place) => {
    if (!nearbyPlaces.some((existing) => existing.name === place.name && existing.category === place.category)) {
      nearbyPlaces.push(place);
    }
  });

  const coordinates = extractCoordinates(content);
  if (coordinates && property.latitude == null && property.longitude == null) {
    property.latitude = coordinates.lat;
    property.longitude = coordinates.lng;
  }

  const coreMetrics = extractCoreListingMetrics(text, property.title);
  const bathroomBreakdown = extractExplicitBathroomBreakdown(text);

  const schools = mergeSchoolEvidence(property.schools || [], extractSchoolEvidence(content, property.url || "", "realtor-listing"));
  const listingFacts = mergeListingFacts(property.listingFacts || {}, extractListingFacts(content));
  const listingEvidenceText = extractListingEvidenceText(content);

  return {
    ...property,
    bedrooms: coreMetrics.bedrooms ?? property.bedrooms,
    bathrooms: bathroomBreakdown?.bathrooms ?? coreMetrics.bathrooms ?? property.bathrooms,
    fullBathrooms: bathroomBreakdown?.fullBathrooms ?? coreMetrics.fullBathrooms ?? property.fullBathrooms,
    halfBathrooms: bathroomBreakdown?.halfBathrooms ?? coreMetrics.halfBathrooms ?? property.halfBathrooms,
    sqft: coreMetrics.sqft ?? property.sqft,
    sqftSource: coreMetrics.sqftSource ?? property.sqftSource,
    description: property.description || extractListingDescription(listingEvidenceText) || visibleText.slice(0, 3000),
    listingFacts,
    listingEvidenceText,
    listingEvidenceSourceUrl: property.url,
    exteriorMaterials: [...exteriorMaterials],
    exteriorCoverage: property.exteriorCoverage || "unknown",
    communityFeatures: [...communityFeatures],
    featureEvidence,
    nearbyPlaces,
    schools,
  };
}

export function extractCommunityWaterEvidence(content: string): {
  features: Array<"lake" | "pond">;
  snippets: string[];
} {
  const decoded = content
    .replace(/\\u0022|\\"/g, '"')
    .replace(/\\u0026/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/\\n|\\r|\\t/g, " ");
  const snippets: string[] = [];
  const add = (value: string) => {
    const clean = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (clean && !snippets.includes(clean)) snippets.push(clean.slice(0, 600));
  };

  // Realtor stores collapsed Property details as category/text JSON. These
  // fields are stronger than arbitrary "lake" mentions elsewhere on the page.
  const categoryPattern = /"category"\s*:\s*"(Amenities and Community Features|Homeowners Association|Waterfront and Water Access)"[\s\S]{0,2500}?"text"\s*:\s*\[([\s\S]{0,2500}?)\]/gi;
  let category: RegExpExecArray | null;
  while ((category = categoryPattern.exec(decoded)) !== null) {
    const section = category[1];
    const values = [...category[2].matchAll(/"([^"]{2,500})"/g)].map((match) => match[1]);
    for (const value of values) {
      const structuredCommunityField = /^(?:Community Features?|Association Amenities?|Association Fee Includes?|Subdivision Amenities?|Neighborhood Amenities?)\s*:/i.test(value);
      const sharedLakeAccess = section === "Waterfront and Water Access"
        && /\b(?:lake privileges?|shared(?:-private)? lake access|community (?:lake|dock)|lake access rights?)\b/i.test(value);
      if ((structuredCommunityField && /\b(?:lake|pond)\b/i.test(value)) || sharedLakeAccess) {
        add(`${section}: ${value}`);
      }
    }
  }

  // Markdown and rendered text may expose the same fields without JSON.
  const structuredPattern = /\b(?:Community Features?|Association Amenities?|Association Fee Includes?|Subdivision Amenities?|Neighborhood Amenities?)\s*:\s*[^.;\n<]{0,500}\b(?:lake|pond)\b[^.;\n<]{0,250}/gi;
  for (const match of decoded.matchAll(structuredPattern)) add(match[0]);
  const privilegesPattern = /\b(?:lake privileges?|shared(?:-private)? lake access|community (?:lake|dock)|lake access rights?)\b[^.;\n<]{0,250}/gi;
  for (const match of decoded.matchAll(privilegesPattern)) add(match[0]);

  // Prose counts only when water is explicitly tied to the neighborhood, HOA,
  // residents, common area, or shared access.
  const prosePatterns = [
    /\b(?:community|neighborhood|subdivision|hoa|association|amenit(?:y|ies)|residents?|common areas?|shared)[^.;\n<]{0,220}\b(?:lake|pond)\b[^.;\n<]{0,180}/gi,
    /\b(?:lake|pond)\b[^.;\n<]{0,220}\b(?:community|neighborhood|subdivision|hoa|association|amenit(?:y|ies)|residents?|resident access|privileges?|common areas?|shared|maintained)\b[^.;\n<]{0,120}/gi,
  ];
  for (const pattern of prosePatterns) {
    for (const match of decoded.matchAll(pattern)) add(match[0]);
  }

  const joined = snippets.join("\n");
  const features: Array<"lake" | "pond"> = [];
  if (/\blake\b/i.test(joined)) features.push("lake");
  if (/\bpond\b/i.test(joined)) features.push("pond");
  return { features, snippets };
}

export function extractCoreListingMetrics(
  content: string,
  propertyTitle = "",
): { bedrooms?: number; bathrooms?: number; fullBathrooms?: number; halfBathrooms?: number; sqft?: number; sqftSource?: Property["sqftSource"] } {
  const normalized = content.replace(/\s+/g, " ");
  const address = propertyTitle.split(",")[0].trim();
  const windows: string[] = [];
  if (address) {
    const lower = normalized.toLowerCase();
    const needle = address.toLowerCase();
    let from = 0;
    while (windows.length < 8) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      windows.push(normalized.slice(index, index + 700));
      from = index + needle.length;
    }
  }
  windows.push(normalized.slice(0, 5000));

  for (const window of windows) {
    const explicitSqft = firstMetric(window, [
      /\bLiving Area(?: Total)?\s*[:\-]?\s*([\d,]{3,})\s*(?:sq\.?\s*ft\.?|sqft|square feet)?/i,
      /\bBuilding Area Total\s*[:\-]?\s*([\d,]{3,})\s*(?:sq\.?\s*ft\.?|sqft|square feet)?/i,
      /\bAbove Grade Finished Area\s*[:\-]?\s*([\d,]{3,})\s*(?:sq\.?\s*ft\.?|sqft|square feet)?/i,
      /["'](?:livingArea|buildingArea|sqft)["']\s*:\s*["']?([\d,]{3,})/i,
      /["']floorSize["'][^}]{0,100}["']value["']\s*:\s*["']?([\d,]{3,})/i,
    ], 100, 100000);
    const fullBathrooms = firstMetric(window, [
      /\bFull Bathrooms?\s*[:\-]?\s*(\d+)\b/i,
      /\b(\d+)\s+full bathrooms?\b/i,
      /\b(\d+)\s+full baths?\b/i,
      /\b(\d+)\s+(?:ba|baths?)\b(?=.{0,60}\b\d+\s+half\s+(?:ba|baths?)\b)/i,
      /["'](?:numberOfFullBathrooms|bathroomsFull|baths_full)["']\s*:\s*(\d+)/i,
    ]);
    const halfBathrooms = firstMetric(window, [
      /\bHalf Bathrooms?\s*[:\-]?\s*(\d+)\b/i,
      /\b1\s*\/\s*2 Bathrooms?\s*[:\-]?\s*(\d+)\b/i,
      /\b(\d+)\s+(?:half|partial) bathrooms?\b/i,
      /\b(\d+)\s+half baths?\b/i,
      /\b(\d+)\s+half ba\b/i,
      /["'](?:numberOfHalfBathrooms|bathroomsHalf|baths_half)["']\s*:\s*(\d+)/i,
    ]);
    const explicitTotal = firstMetric(window, [
      /\bTotal Bathrooms?\s*[:\-]?\s*(\d+(?:\.\d+)?)\b/i,
      /["'](?:numberOfBathroomsTotal|bathroomsTotal)["']\s*:\s*(\d+(?:\.\d+)?)/i,
    ]);
    if (fullBathrooms != null && halfBathrooms != null) {
      return {
        // Realtor's consumer-facing convention represents a half bath as
        // 0.5. Some MLS feeds separately call 2 full + 1 half "3 total
        // bathrooms" because they count rooms, but the listing card says 2.5.
        bathrooms: fullBathrooms + (halfBathrooms * 0.5),
        fullBathrooms,
        halfBathrooms,
        ...(explicitSqft != null ? { sqft: explicitSqft, sqftSource: "detail-page" as const } : {}),
      };
    }

    const labelFirst = window.match(/\bbeds?\s*(\d+(?:\.\d+)?)\s+baths?\s*(\d+(?:\.\d+)?)\s+(?:sqft\s*)?(?:square\s+feet\s*)?([\d,]{3,})?/i);
    const valueFirst = window.match(/\b(\d+(?:\.\d+)?)\s*beds?\s+(\d+(?:\.\d+)?)\s*baths?\s+([\d,]{3,})\s*(?:sqft|square\s+feet)\b/i);
    const match = labelFirst || valueFirst;
    if (!match) continue;
    const bedrooms = validMetric(match[1], 0, 20);
    const bathrooms = explicitTotal ?? validMetric(match[2], 0, 20);
    const cardSqft = validMetric(match[3]?.replace(/,/g, ""), 100, 100000);
    const sqft = explicitSqft ?? cardSqft;
    if (bedrooms != null || bathrooms != null || sqft != null) {
      return {
        bedrooms, bathrooms, sqft,
        ...(sqft != null ? { sqftSource: explicitSqft != null ? "detail-page" as const : "listing-card" as const } : {}),
      };
    }
    if (explicitTotal != null || explicitSqft != null) {
      return {
        bathrooms: explicitTotal,
        sqft: explicitSqft,
        ...(explicitSqft != null ? { sqftSource: "detail-page" as const } : {}),
      };
    }
  }
  return {};
}

function extractExplicitBathroomBreakdown(content: string): {
  bathrooms: number;
  fullBathrooms: number;
  halfBathrooms: number;
} | undefined {
  const find = (patterns: RegExp[]): { value: number; index: number } | undefined => {
    for (const pattern of patterns) {
      const match = pattern.exec(content);
      const value = Number(match?.[1]);
      if (match?.index != null && Number.isInteger(value) && value >= 0 && value < 20) {
        return { value, index: match.index };
      }
    }
    return undefined;
  };
  const full = find([
    /\bFull Bathrooms?\s*[:\-]?\s*(\d+)\b/i,
    /\b(\d+)\s+full bathrooms?\b/i,
    /\b(\d+)\s+full baths?\b/i,
  ]);
  const half = find([
    /\b1\s*\/\s*2 Bathrooms?\s*[:\-]?\s*(\d+)\b/i,
    /\bHalf Bathrooms?\s*[:\-]?\s*(\d+)\b/i,
    /\b(\d+)\s+(?:half|partial) bathrooms?\b/i,
    /\b(\d+)\s+half baths?\b/i,
  ]);
  if (!full || !half || Math.abs(full.index - half.index) > 1200) return undefined;
  return {
    bathrooms: full.value + (half.value * 0.5),
    fullBathrooms: full.value,
    halfBathrooms: half.value,
  };
}

function firstMetric(content: string, patterns: RegExp[], minimum = 0, maximum = 20): number | undefined {
  for (const pattern of patterns) {
    const value = Number(String(content.match(pattern)?.[1] || "").replace(/,/g, ""));
    if (Number.isFinite(value) && value > minimum && value < maximum) return value;
  }
  return undefined;
}

function validMetric(value: unknown, minimumExclusive: number, maximum: number): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > minimumExclusive && parsed < maximum ? parsed : undefined;
}

export function assessProperty(property: Property, criteria: SearchCriteria): PropertyCriteriaMatch {
  const checks: ConstraintMatch[] = [];
  const searchable = [
    property.title, property.description, ...(property.features || []), property.listingEvidenceText,
    ...Object.entries(property.listingFacts || {}).flatMap(([label, values]) => [label, ...values]),
  ].filter(Boolean).join(" ").toLowerCase();

  if (criteria.location) {
    checks.push(propertyMatchesRequestedMarket(property, criteria.location)
      ? verified(`location: ${criteria.location}`, `Listing location is ${property.location}.`)
      : failed(`location: ${criteria.location}`, `Listing location is ${property.location || "unavailable"}, not the requested market.`));
  }

  if (criteria.minPrice != null) {
    checks.push(property.price >= criteria.minPrice
      ? verified(`price at least $${criteria.minPrice.toLocaleString("en-US")}`, `Listing price is $${property.price.toLocaleString("en-US")}.`)
      : failed(`price at least $${criteria.minPrice.toLocaleString("en-US")}`, `Listing price is $${property.price.toLocaleString("en-US")}.`));
  }

  if (criteria.maxPrice != null) {
    checks.push(property.price <= criteria.maxPrice
      ? verified(`price at most $${criteria.maxPrice.toLocaleString("en-US")}`, `Listing price is $${property.price.toLocaleString("en-US")}.`)
      : failed(`price at most $${criteria.maxPrice.toLocaleString("en-US")}`, `Listing price is $${property.price.toLocaleString("en-US")}.`));
  }

  if (criteria.minBedrooms != null) {
    checks.push(property.bedrooms <= 0
      ? unknown(`bedrooms at least ${criteria.minBedrooms}`, "The bedroom count was not available from the listing source.")
      : property.bedrooms >= criteria.minBedrooms
      ? verified(`bedrooms at least ${criteria.minBedrooms}`, `Listing has ${property.bedrooms} bedroom(s).`)
      : failed(`bedrooms at least ${criteria.minBedrooms}`, `Listing has only ${property.bedrooms} bedroom(s).`));
  }

  if (criteria.minBathrooms != null) {
    checks.push(property.bathrooms <= 0
      ? unknown(`bathrooms at least ${criteria.minBathrooms}`, "The bathroom count was not available from the listing source.")
      : property.bathrooms >= criteria.minBathrooms
      ? verified(`bathrooms at least ${criteria.minBathrooms}`, `Listing has ${property.bathrooms} bathroom(s).`)
      : failed(`bathrooms at least ${criteria.minBathrooms}`, `Listing has only ${property.bathrooms} bathroom(s).`));
  }

  if (criteria.propertyType) {
    const requestedType = normalizeText(criteria.propertyType);
    checks.push(searchable.includes(requestedType)
      ? verified(`property type: ${criteria.propertyType}`, "Property type appears in the listing data.")
      : unknown(`property type: ${criteria.propertyType}`, "Property type is not documented in the normalized listing fields."));
  }

  for (const material of criteria.exteriorMaterials || []) {
    const normalized = material.toLowerCase();
    if (normalized === "brick") {
      checks.push(property.exteriorCoverage === "all-sides"
        ? verified("all-sides brick exterior", "Listing explicitly states brick on all four sides.")
        : property.exteriorCoverage === "partial"
          ? failed("all-sides brick exterior", "Listing mentions brick, but not a four-sided/all-brick exterior.")
          : unknown("all-sides brick exterior", "No listing evidence confirms brick on all four sides."));
    } else {
      const found = (property.exteriorMaterials || []).some((value) => value.toLowerCase().includes(normalized));
      checks.push(found ? verified(`exterior: ${material}`, "Exterior material is listed.") : unknown(`exterior: ${material}`, "Exterior material is not documented."));
    }
  }

  for (const feature of criteria.communityFeatures || []) {
    const normalized = feature.toLowerCase();
    const found = (property.communityFeatures || []).some((value) => value.toLowerCase().includes(normalized));
    const nearestWater = /lake|pond/i.test(normalized) ? property.nearbyWaterBodies?.[0] : undefined;
    const communityEvidence = /lake|pond/i.test(normalized)
      ? property.featureEvidence?.find((item) => item.criterion === "community-lake") : undefined;
    const excerpt = communityEvidence?.excerpt?.replace(/\s+/g, " ").trim().slice(0, 320);
    checks.push(found
      ? verified(`community feature: ${feature}`, communityEvidence?.sourceUrl
        ? `${excerpt ? `Listing evidence: “${excerpt}” ` : `A property, HOA, or subdivision source explicitly describes a community ${feature}. `}Source: ${communityEvidence.sourceUrl}`
        : `The Realtor property evidence explicitly describes a community ${feature}.`)
      : nearestWater
        ? unknown(`community feature: ${feature}`, `${nearestWater.name} is mapped ${nearestWater.distanceMiles.toFixed(2)} straight-line miles away by ${nearestWater.source}, but proximity does not prove that it belongs to the subdivision or is accessible to residents.`)
        : unknown(`community feature: ${feature}`, `No listing, HOA, subdivision, or mapped-waterbody evidence confirms a community ${feature}.`));
  }

  for (const constraint of criteria.distanceConstraints || []) {
    const normalized = normalizeDistanceConstraint(constraint);
    if (!normalized) continue;
    const evaluation = (property.distanceEvaluations || []).find((item) =>
      item.name.toLowerCase() === normalized.name.toLowerCase()
      || item.category === normalized.category);
    if (evaluation) {
      checks.push({
        criterion: `${normalized.name} within ${normalized.maxMiles} miles`,
        status: evaluation.status,
        detail: evaluation.detail,
      });
      continue;
    }
    const distance = resolveDistance(property, normalized);
    const label = `${normalized.name} within ${normalized.maxMiles} miles`;
    if (distance == null) {
      checks.push(unknown(label, `No coordinates or listing proximity data are available for ${normalized.name}.`));
    } else if (distance <= normalized.maxMiles) {
      checks.push(verified(label, `${distance.toFixed(1)} miles (${distanceSource(property, normalized)}).`));
    } else {
      checks.push(failed(label, `${distance.toFixed(1)} miles, exceeding the ${normalized.maxMiles}-mile limit.`));
    }
  }

  if (criteria.highwayAccess) {
    const constraint = criteria.highwayAccess;
    const label = `${constraint.highwayName} legal access within ${constraint.maxMiles} miles`;
    const evaluation = property.highwayAccessEvaluation;
    if (!evaluation || evaluation.highwayName.toLowerCase() !== constraint.highwayName.toLowerCase()) {
      checks.push(unknown(label, `No HERE route evidence is available for access to ${constraint.highwayName}.`));
    } else {
      checks.push({ criterion: label, status: evaluation.status, detail: evaluation.detail });
    }
  }


  if (criteria.schoolMinRating != null || criteria.schoolAtLeastOneRating != null) {
    const threshold = Math.max(1, Math.min(10, criteria.schoolMinRating ?? 1));
    const atLeastOneThreshold = criteria.schoolAtLeastOneRating == null
      ? undefined : Math.max(threshold, Math.min(10, criteria.schoolAtLeastOneRating));
    const assignmentRequired = criteria.schoolAssignmentRequired === true;
    const alternativePolicy = criteria.schoolAlternativePolicy || "any-eligible-option";
    const eligible = (property.schools || []).filter((school) => !assignmentRequired
      || school.relationship === "assigned" || school.relationship === "assignment-option"
      || school.relationship === "listing-associated");
    const exactAssigned = eligible.filter((school) => school.relationship !== "assignment-option");
    const assignmentOptions = alternativePolicy === "any-eligible-option"
      ? eligible.filter((school) => school.relationship === "assignment-option") : [];
    const rated = eligible.filter((school) => school.rating != null);
    const baseLabel = assignmentRequired ? "K-12 schools associated with this property" : "Realtor-listed K-12 schools";
    const label = atLeastOneThreshold == null
      ? `${baseLabel} rated at least ${threshold}/10`
      : `${baseLabel}: all at least ${threshold}/10 and one at least ${atLeastOneThreshold}/10`;
    const exactRated = exactAssigned.filter((school) => school.rating != null);
    const below = exactRated.filter((school) => (school.rating as number) < threshold);
    const usableOptions = assignmentOptions.filter((school) => school.rating != null && (school.rating as number) >= threshold);
    const coveredTypes = new Set([...exactRated, ...usableOptions].map((school) => school.type));
    const completeCoverage = coveredTypes.has("k12")
      || (coveredTypes.has("elementary") && coveredTypes.has("middle") && coveredTypes.has("high"));
    const summary = rated.map((school) => `${school.name} ${school.rating}/10${school.relationship === "assignment-option" ? " (official option)" : school.relationship === "listing-associated" ? " (Realtor property page)" : ""}`).join(", ");
    const reachesHigherThreshold = atLeastOneThreshold == null || [...exactRated, ...usableOptions]
      .some((school) => (school.rating as number) >= atLeastOneThreshold);
    const optionGroups = new Map<string, typeof assignmentOptions>();
    for (const option of assignmentOptions) {
      const key = option.assignmentGroup || `${option.type}-options`;
      optionGroups.set(key, [...(optionGroups.get(key) || []), option]);
    }
    const fullyRatedUnsatisfiedGroup = [...optionGroups.values()].some((group) => {
      const expected = Math.max(...group.map((school) => school.assignmentGroupSize || group.length));
      return group.filter((school) => school.rating != null).length >= expected
        && !group.some((school) => school.rating != null && (school.rating as number) >= threshold);
    });
    if (assignmentRequired && !eligible.length) {
      const districts = (property.schoolDistricts || []).map((district) => district.name).join(", ");
      checks.push(unknown(label, districts
        ? `The district is ${districts}, but neither the Realtor property page nor an official locator returned complete elementary/middle/high evidence.`
        : "The Realtor property page did not return complete elementary/middle/high evidence, and no official assignment fallback is available."));
    } else if (below.length) {
      checks.push(failed(label, assignmentRequired
        ? `${summary}. Property-associated school evidence was found, and one or more schools are below ${threshold}/10.`
        : `${summary}. One or more Realtor-listed schools are below ${threshold}/10. These are nearby-school ratings; attendance assignment is not verified.`));
    } else if (fullyRatedUnsatisfiedGroup) {
      checks.push(failed(label, `${summary}. Every school in an official placement-option pool is below ${threshold}/10.`));
    } else if (rated.length && completeCoverage && !reachesHigherThreshold) {
      checks.push(failed(label, `${summary}. All three stages meet ${threshold}/10, but none reaches ${atLeastOneThreshold}/10.`));
    } else if (rated.length && completeCoverage) {
      const hasListingAssociated = rated.some((school) => school.relationship === "listing-associated");
      checks.push(verified(label, assignmentRequired
        ? `${summary}. ${hasListingAssociated ? "The schools and ratings are displayed for this property on its Realtor page" : "School assignment comes from an official locator and ratings are sourced through Realtor/GreatSchools"}.${assignmentOptions.length ? " For the non-unique placement pool, at least one official option meets the requirement." : ""}${atLeastOneThreshold == null ? "" : ` At least one eligible school reaches ${atLeastOneThreshold}/10.`}`
        : `${summary}. Ratings are sourced through Realtor/GreatSchools; attendance assignment is not verified.`));
    } else if (rated.length) {
      checks.push(unknown(label, `${summary}. Ratings were found, but elementary/middle/high coverage is incomplete; attendance assignment is not verified.`));
    } else {
      checks.push(unknown(label, "No source-backed 1-10 K-12 school ratings were found for this listing."));
    }
  }

  for (const mustHave of criteria.mustHave || []) {
    if ([...(criteria.exteriorMaterials || []), ...(criteria.communityFeatures || [])]
      .some((item) => item.toLowerCase() === mustHave.toLowerCase())) continue;
    const evidence = findRequirementEvidence(property, searchable, mustHave);
    checks.push(evidence
      ? verified(`feature: ${mustHave}`, `Realtor listing evidence: ${evidence}`)
      : unknown(`feature: ${mustHave}`, "Feature is not documented in the listing data."));
  }

  const failedCount = checks.filter((check) => check.status === "failed").length;
  const verifiedCount = checks.filter((check) => check.status === "verified").length;
  const overall = failedCount > 0 ? "failed" : checks.length > 0 && verifiedCount === checks.length ? "verified" : "unknown";
  const score = checks.length === 0 ? 100 : Math.max(0, Math.round((verifiedCount / checks.length) * 100 - failedCount * 20));
  return { overall, score, checks };
}

export function propertyMatchesRequestedMarket(property: Pick<Property, "title" | "location">, location: string): boolean {
  const expected = parseLocationParts(location);
  const actual = parseLocationParts(property.location || property.title);
  if (!expected.city || !actual.city || expected.city !== actual.city) return false;
  // Realtor is a US source. A candidate without a recognizable US state is
  // never allowed to satisfy a bare-city request (for example Athens, Greece).
  if (!actual.state) return false;
  if (expected.state && actual.state !== expected.state) return false;
  if (expected.zip && actual.zip !== expected.zip) return false;
  return true;
}

function parseLocationParts(location: string): { city: string; state: string; zip: string } {
  const cleaned = String(location || "")
    .replace(/\s+(?:priced|under|over|budget|max|min|million|thousand|dollars?).*$/i, "")
    .trim();
  const zip = cleaned.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1] || "";
  const parts = cleaned.split(",").map((part) => normalizeText(part)).filter(Boolean);
  if (parts.length >= 2) {
    const statePart = parts.at(-1)!.replace(/\b\d{5}(?:\s+\d{4})?\b/g, "").trim();
    return { city: parts.at(-2)!, state: normalizeUsState(statePart), zip };
  }
  const normalized = normalizeText(cleaned).replace(/\b\d{5}(?:\s+\d{4})?\b/g, "").trim();
  const stateMatch = normalized.match(/^(.*?)\s+([a-z]{2})$/);
  return stateMatch
    ? { city: stateMatch[1].trim(), state: normalizeUsState(stateMatch[2]), zip }
    : { city: normalized, state: "", zip };
}

function normalizeUsState(value: string): string {
  const aliases: Record<string, string> = {
    alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co",
    connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id",
    illinois: "il", indiana: "in", iowa: "ia", kansas: "ks", kentucky: "ky", louisiana: "la",
    maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn",
    mississippi: "ms", missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
    "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny",
    "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok", oregon: "or",
    pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc", "south dakota": "sd",
    tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt", virginia: "va", washington: "wa",
    "west virginia": "wv", wisconsin: "wi", wyoming: "wy", "district of columbia": "dc",
  };
  const normalized = normalizeText(value);
  const stateCodes = new Set([...Object.values(aliases), "pr", "vi", "gu", "as", "mp"]);
  return aliases[normalized] || (stateCodes.has(normalized) ? normalized : "");
}

function normalizeText(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveDistance(property: Property, constraint: DistanceConstraint): number | null {
  if (constraint.lat != null && constraint.lng != null && property.latitude != null && property.longitude != null) {
    return haversineMiles(property.latitude, property.longitude, constraint.lat, constraint.lng);
  }
  const candidates = (property.nearbyPlaces || []).filter((place) => {
    if (constraint.category && constraint.category !== "other") return place.category === constraint.category;
    return place.name.toLowerCase().includes(constraint.name.toLowerCase());
  });
  return candidates.length ? Math.min(...candidates.map((place) => place.distanceMiles)) : null;
}

function distanceSource(property: Property, constraint: DistanceConstraint): string {
  return constraint.lat != null && property.latitude != null ? "straight-line distance" : "listing data";
}

function extractNearbyDistances(text: string): NonNullable<Property["nearbyPlaces"]> {
  const results: NonNullable<Property["nearbyPlaces"]> = [];
  const patterns = [
    /(?:([A-Z][\w &'’-]{2,50})\s*)?(\d+(?:\.\d+)?)\s*(?:mi|miles?)\s+(?:to|from)\s+(?:a\s+)?(supermarket|grocery store|large grocery store)/gi,
    /(supermarket|grocery store|large grocery store)(?:[^.]{0,50}?)(\d+(?:\.\d+)?)\s*(?:mi|miles?)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const distance = Number(match[2]);
      if (!Number.isFinite(distance)) continue;
      results.push({ name: match[1] || match[3] || "grocery store", category: "grocery", distanceMiles: distance, source: "listing" });
    }
  }
  // Realtor's Neighborhood section uses a compact layout such as:
  // "Groceries ALDI (0.6 mi), R and A Seafood Market (0.9 mi)".
  const grocerySection = text.match(/\bGroceries\b([\s\S]{0,500}?)(?=\b(?:Shopping|Restaurants|Coffee|Schools|Show more)\b|$)/i)?.[1] || "";
  const placePattern = /([A-Z][A-Za-z0-9 '&.\-]{1,80}?)\s*\((\d+(?:\.\d+)?)\s*(?:mi|miles?)\)/g;
  let place: RegExpExecArray | null;
  while ((place = placePattern.exec(grocerySection)) !== null) {
    const distance = Number(place[2]);
    if (!Number.isFinite(distance)) continue;
    results.push({ name: place[1].trim(), category: "grocery", distanceMiles: distance, source: "listing" });
  }
  return results;
}

function extractCoordinates(content: string): { lat: number; lng: number } | null {
  const patterns = [
    /"latitude"\s*:\s*"?(-?\d+(?:\.\d+)?)"?[\s\S]{0,120}?"longitude"\s*:\s*"?(-?\d+(?:\.\d+)?)"?/i,
    /"lat"\s*:\s*(-?\d+(?:\.\d+)?)[\s\S]{0,80}?"(?:lon|lng)"\s*:\s*(-?\d+(?:\.\d+)?)/i,
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return { lat: Number(match[1]), lng: Number(match[2]) };
  }
  return null;
}

function decodeHtml(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;/g, "'").replace(/&quot;/gi, '"');
}

export function extractListingFacts(content: string): Record<string, string[]> {
  const text = content.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(?:p|li|div|h[1-6])>/gi, "\n")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'").replace(/&quot;/gi, '"').replace(/\\n|\\r|\\t/g, "\n");
  const lines = text.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*+]\s+|#{1,6}\s*)/, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const facts: Record<string, string[]> = {};
  let section = "Listing";
  const add = (label: string, value: string) => {
    const cleanLabel = label.replace(/[:：]+$/, "").trim();
    const cleanValue = value.trim();
    if (!cleanLabel || !cleanValue || cleanLabel.length > 100 || cleanValue.length > 500) return;
    // The snapshot is evidence, not a dump of Realtor's page chrome. Keep
    // property attributes and requested-feature data; discard freshness/source,
    // marketing prompts, and duplicate-listing navigation.
    const meaningfulLabel = /(?:architect|construction|material|exterior|interior|bed|bath|living area|square feet|sqft|lot|year built|property type|home type|style|roof|foundation|floor|fireplace|garage|parking|heating|cooling|air condition|appliance|laundry|utility|utilities|water|sewer|community|subdivision|amenit|association|hoa|school|view|pool|lake|pond)/i;
    const boilerplate = /(?:home buyers reveal|what i wish i had known|realtor\.com checked|listing last updated|multiple listings|for sale listing|brokered by|contact (?:the )?agent|advertisement)/i;
    if (!meaningfulLabel.test(cleanLabel) || boilerplate.test(cleanLabel) || boilerplate.test(cleanValue)) return;
    const key = `${section}: ${cleanLabel}`;
    facts[key] ||= [];
    if (!facts[key].includes(cleanValue) && facts[key].length < 8) facts[key].push(cleanValue);
  };
  for (let index = 0; index < lines.length && Object.keys(facts).length < 200; index += 1) {
    const line = lines[index];
    if (/^(?:Property details|Interior|Exterior|Community|Listing|Features|Utilities|Neighborhood & schools|Schools|School Information|Amenities and Community Features)$/i.test(line)) {
      section = line;
      continue;
    }
    const inline = line.match(/^([A-Za-z][A-Za-z0-9 &/'().-]{1,90}):\s*(.+)$/);
    if (inline) { add(inline[1], inline[2]); continue; }
    if (/^[A-Za-z][A-Za-z0-9 &/'().-]{1,90}:$/.test(line) && lines[index + 1]) add(line, lines[index + 1]);
  }
  return facts;
}

function mergeListingFacts(current: Record<string, string[]>, incoming: Record<string, string[]>): Record<string, string[]> {
  const merged = { ...current };
  for (const [key, values] of Object.entries(incoming)) {
    merged[key] = [...new Set([...(merged[key] || []), ...values])].slice(0, 8);
  }
  return merged;
}

function extractListingEvidenceText(content: string): string {
  const text = content.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'").replace(/&quot;/gi, '"').replace(/\\n|\\r|\\t/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const details = text.search(/(?:^|\n)\s*(?:#{1,6}\s*)?Property details\b/i);
  const relevant = details >= 0 ? text.slice(details) : text;
  const end = relevant.search(/(?:^|\n)\s*(?:#{1,6}\s*)?Similar homes\b/i);
  return (end >= 0 ? relevant.slice(0, end) : relevant).slice(0, 60000);
}

function extractListingDescription(evidence: string): string {
  const match = evidence.match(/Property details\s+([\s\S]{20,5000}?)(?=\n\s*(?:Interior|Exterior|Community|Listing|Features|Monthly payment)\b)/i);
  return match?.[1]?.replace(/\s+/g, " ").trim().slice(0, 3000) || "";
}

function decodeEmbeddedData(value: string): string {
  const scripts: string[] = [];
  const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(value)) !== null) {
    const body = match[1];
    if (/brick|lake|pond|exterior|amenit|subdivision|community/i.test(body)) scripts.push(body);
  }
  return scripts.join(" ")
    .replace(/\\u0022|\\"/g, '"')
    .replace(/\\u0026/g, "&")
    .replace(/\\n|\\r|\\t/g, " ")
    .replace(/[{}\[\],:]/g, " ");
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function mergeSchoolEvidence(existing: NonNullable<Property["schools"]>, incoming: NonNullable<Property["schools"]>): NonNullable<Property["schools"]> {
  const merged = new Map(existing.map((school) => [schoolIdentityKey(school.name), school]));
  for (const school of incoming) {
    const key = schoolIdentityKey(school.name);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, school);
    } else {
      const preserveRelationship = current.relationship === "assigned"
        || current.relationship === "assignment-option" || current.relationship === "listing-associated";
      merged.set(key, {
        ...current,
        rating: current.rating ?? school.rating,
        ratingSource: current.rating != null ? current.ratingSource : school.ratingSource,
        type: current.type === "other" ? school.type : current.type,
        grades: current.grades || school.grades,
        distanceMiles: current.distanceMiles ?? school.distanceMiles,
        studentCount: current.studentCount ?? school.studentCount,
        reviewCount: current.reviewCount ?? school.reviewCount,
        evidenceSource: current.rating != null ? current.evidenceSource : school.evidenceSource,
        sourceUrl: current.rating != null ? current.sourceUrl : school.sourceUrl,
        checkedAt: current.rating != null ? current.checkedAt : school.checkedAt,
        relationship: preserveRelationship ? current.relationship : school.relationship,
        assignmentSource: current.assignmentSource || school.assignmentSource,
        assignmentSourceUrl: current.assignmentSourceUrl || school.assignmentSourceUrl,
      });
    }
  }
  return [...merged.values()];
}

function schoolIdentityKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\broad\b/g, " ").replace(/\s+/g, " ").trim();
}

function findRequirementEvidence(property: Property, searchable: string, requirement: string): string | null {
  const normalizedRequirement = normalizeText(requirement);
  if (!normalizedRequirement) return null;
  const segments = [
    ...(property.features || []),
    property.description || "",
    ...Object.entries(property.listingFacts || {}).flatMap(([label, values]) => values.map((value) => `${label}: ${value}`)),
  ].filter(Boolean);
  const exact = segments.find((segment) => normalizeText(segment).includes(normalizedRequirement));
  if (exact) return exact.slice(0, 300);
  const tokens = normalizedRequirement.split(" ").filter((token) => token.length > 2 && !/^(?:with|and|the|has|have|home|house)$/.test(token));
  if (tokens.length >= 2) {
    const tokenMatch = segments.find((segment) => {
      const normalizedSegment = normalizeText(segment);
      return tokens.every((token) => normalizedSegment.includes(token));
    });
    if (tokenMatch) return tokenMatch.slice(0, 300);
  }
  return searchable.includes(requirement.toLowerCase()) ? requirement : null;
}

function verified(criterion: string, detail: string): ConstraintMatch { return { criterion, status: "verified", detail }; }
function failed(criterion: string, detail: string): ConstraintMatch { return { criterion, status: "failed", detail }; }
function unknown(criterion: string, detail: string): ConstraintMatch { return { criterion, status: "unknown", detail }; }
