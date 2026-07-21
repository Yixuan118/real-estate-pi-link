import { DistanceConstraint, Property, SearchCriteria } from "../core/types";
import { normalizeDistanceConstraint } from "../core/property-matcher";
import { HighwayDefinition, isHighwayRoadLabel, resolveHighwayDefinition } from "../data/highway-registry";
import { decode } from "@here/flexpolyline";

interface LatLng { lat: number; lng: number }
interface HerePlace { id: string; name: string; location: LatLng; straightLineMeters?: number }
interface HighwayRouteResult { distanceMiles: number; accessName: string }
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const METERS_PER_MILE = 1609.344;

export class HereMapsService {
  private apiKey: string;
  private fetchImpl: FetchLike;
  private geocodeCache = new Map<string, Promise<LatLng | null>>();
  private placesCache = new Map<string, Promise<HerePlace[]>>();
  private routeCache = new Map<string, Promise<number | null>>();
  private highwayRouteCache = new Map<string, Promise<HighwayRouteResult | null>>();
  private highwayProbeCache = new Map<string, Promise<LatLng[]>>();

  constructor(apiKey = process.env.HERE_API_KEY || "", fetchImpl: FetchLike = fetch) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  get enabled(): boolean { return Boolean(this.apiKey); }

  async enrichProperties(
    properties: Property[],
    criteria: SearchCriteria,
    onProgress?: (message: string) => void,
  ): Promise<Property[]> {
    const needsWaterCoordinates = criteria.communityFeatures?.some((item) => /lake|pond/i.test(item));
    if (!this.enabled || (!criteria.distanceConstraints?.length && !criteria.highwayAccess && !needsWaterCoordinates) || properties.length === 0) return properties;
    const highwayOnly = Boolean(criteria.highwayAccess && !criteria.distanceConstraints?.length);
    const defaultLimit = highwayOnly ? 50 : 20;
    const limit = clamp(Number(process.env.RE_GEO_ENRICH_LIMIT || defaultLimit), 1, 100);
    const result = [...properties];
    const indexes = result.slice(0, limit).map((_, index) => index);
    for (let index = limit; index < result.length; index++) {
      addDiagnostic(
        result[index],
        "geo-provider",
        "warning",
        `Map validation limit ${limit} reached; this property was not checked. Set RE_GEO_ENRICH_LIMIT higher to include it.`,
      );
    }
    let completed = 0;
    await mapWithConcurrency(indexes, 4, async (index) => {
      result[index] = await this.enrichProperty(result[index], criteria.distanceConstraints || [], criteria.highwayAccess);
      completed++;
      onProgress?.(`HERE verified map constraints for ${completed}/${indexes.length} properties`);
    });
    return result;
  }

  async enrichProperty(
    property: Property,
    constraints: DistanceConstraint[],
    highwayAccess?: SearchCriteria["highwayAccess"],
  ): Promise<Property> {
    const enriched: Property = {
      ...property,
      nearbyPlaces: [...(property.nearbyPlaces || [])],
      distanceEvaluations: [...(property.distanceEvaluations || [])],
    };
    if (enriched.latitude == null || enriched.longitude == null) {
      const address = propertyAddress(enriched);
      if (address) {
        try {
          const resolved = await this.geocode(address);
          if (resolved) {
            enriched.latitude = resolved.lat;
            enriched.longitude = resolved.lng;
            enriched.coordinateSource = "here-geocoding";
            addDiagnostic(enriched, "geocoding", "success", `HERE geocoded ${address}.`);
          } else {
            addDiagnostic(enriched, "geocoding", "warning", `HERE returned no geocoding result for ${address}.`);
          }
        } catch (error) {
          addDiagnostic(enriched, "geocoding", "error", `HERE geocoding failed: ${safeError(error)}`);
        }
      } else {
        addDiagnostic(enriched, "geocoding", "warning", "A complete street address is unavailable for geocoding.");
      }
    } else {
      enriched.coordinateSource ||= "listing";
      addDiagnostic(enriched, "geocoding", "success", "Listing coordinates were available; HERE geocoding was not required.");
    }

    for (const rawConstraint of constraints) {
      const constraint = normalizeDistanceConstraint(rawConstraint);
      if (!constraint) continue;
      try {
        if (constraint.category === "grocery") {
          await this.evaluateGrocery(enriched, constraint);
        } else if (distanceMode() === "driving" && constraint.lat != null && constraint.lng != null) {
          await this.evaluateDestination(enriched, constraint);
        }
      } catch (error) {
        this.setEvaluation(enriched, constraint, {
          status: "unknown",
          detail: `HERE verification failed: ${safeError(error)}`,
          distanceMode: constraint.category === "grocery" ? "driving" : distanceMode(),
        });
      }
    }
    if (highwayAccess) {
      try {
        await this.evaluateHighwayAccess(enriched, highwayAccess);
      } catch (error) {
        this.setHighwayEvaluation(enriched, highwayAccess, {
          status: "unknown",
          detail: `HERE highway verification failed: ${safeError(error)}`,
        });
      }
    }
    return enriched;
  }

  private async evaluateHighwayAccess(
    property: Property,
    constraint: NonNullable<SearchCriteria["highwayAccess"]>,
  ): Promise<void> {
    const origin = coordinates(property);
    if (!origin) {
      this.setHighwayEvaluation(property, constraint, {
        status: "unknown",
        detail: "HERE could not geocode the property address for highway access routing.",
      });
      return;
    }
    const highway = resolveHighwayDefinition(constraint.highwayName);
    if (!highway) {
      this.setHighwayEvaluation(property, constraint, {
        status: "unknown",
        detail: `No access-routing definition is configured for ${constraint.highwayName}.`,
      });
      return;
    }

    const corridorProbes = await this.highwayCorridorProbes(highway);
    if (corridorProbes.length === 0) {
      this.setHighwayEvaluation(property, constraint, {
        status: "unknown",
        detail: `HERE could not build a verified ${highway.canonicalName} road corridor for access checks.`,
      });
      return;
    }
    const candidateLimit = clamp(
      Number(process.env.RE_HIGHWAY_PROBE_CANDIDATE_LIMIT || highway.probeCandidateLimit),
      2,
      16,
    );
    const candidates = corridorProbes
      .map((point) => ({ point, distance: haversineMiles(origin, point) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, candidateLimit)
      .map((item) => item.point);
    const results: Array<HighwayRouteResult | null> = candidates.map(() => null);
    await mapWithConcurrency(candidates.map((_, index) => index), 2, async (index) => {
      results[index] = await this.highwayAccessRoute(origin, candidates[index], highway);
    });
    const nearest = results
      .filter((item): item is HighwayRouteResult => item != null)
      .sort((a, b) => a.distanceMiles - b.distanceMiles)[0];
    if (!nearest) {
      this.setHighwayEvaluation(property, constraint, {
        status: "unknown",
        detail: `HERE routes did not contain a recognizable ${highway.canonicalName} road segment.`,
      });
      return;
    }
    this.setHighwayEvaluation(property, constraint, {
      status: nearest.distanceMiles <= constraint.maxMiles ? "verified" : "failed",
      distanceMiles: nearest.distanceMiles,
      accessName: nearest.accessName,
      detail: `${nearest.accessName} is ${nearest.distanceMiles.toFixed(1)} driving miles from the property (${highway.canonicalName}, HERE).`,
    });
  }

  private async evaluateGrocery(property: Property, constraint: DistanceConstraint): Promise<void> {
    const origin = coordinates(property);
    if (!origin) {
      this.setEvaluation(property, constraint, {
        status: "unknown", detail: "HERE could not geocode the property address.", distanceMode: "driving",
      });
      return;
    }
    const places = await this.searchGroceries(origin, constraint.maxMiles * METERS_PER_MILE);
    if (places.length === 0) {
      this.setEvaluation(property, constraint, {
        status: "failed",
        detail: `HERE Discover found no supermarket or large grocery store within ${constraint.maxMiles} straight-line miles.`,
        distanceMode: "driving",
      });
      return;
    }

    const candidateLimit = clamp(Number(process.env.RE_HERE_ROUTE_CANDIDATE_LIMIT || 10), 1, 20);
    const candidates = places.slice(0, candidateLimit);
    const distances: Array<number | null> = candidates.map(() => null);
    await mapWithConcurrency(candidates.map((_, index) => index), 4, async (index) => {
      distances[index] = await this.routeDistance(origin, candidates[index].location);
    });
    const reachable = candidates.map((place, index) => ({ place, distanceMiles: distances[index] }))
      .filter((item): item is { place: HerePlace; distanceMiles: number } => item.distanceMiles != null)
      .sort((a, b) => a.distanceMiles - b.distanceMiles);
    if (reachable.length === 0) {
      this.setEvaluation(property, constraint, {
        status: "unknown", detail: "HERE Routing returned no drivable route to the grocery candidates.", distanceMode: "driving",
      });
      return;
    }

    const nearest = reachable[0];
    upsertNearbyPlace(property, {
      name: nearest.place.name,
      category: "grocery",
      distanceMiles: nearest.distanceMiles,
      source: "calculated",
      placeId: nearest.place.id,
      distanceMode: "driving",
      checkedAt: new Date().toISOString(),
    });
    this.setEvaluation(property, constraint, {
      status: nearest.distanceMiles <= constraint.maxMiles ? "verified" : "failed",
      distanceMiles: nearest.distanceMiles,
      detail: `${nearest.place.name} is ${nearest.distanceMiles.toFixed(1)} driving miles away (HERE).`,
      distanceMode: "driving",
    });
  }

  private async evaluateDestination(property: Property, constraint: DistanceConstraint): Promise<void> {
    const origin = coordinates(property);
    if (!origin || constraint.lat == null || constraint.lng == null) {
      this.setEvaluation(property, constraint, {
        status: "unknown", detail: "Coordinates are unavailable for HERE route calculation.", distanceMode: "driving",
      });
      return;
    }
    const distanceMiles = await this.routeDistance(origin, { lat: constraint.lat, lng: constraint.lng });
    if (distanceMiles == null) {
      this.setEvaluation(property, constraint, {
        status: "unknown", detail: `HERE Routing returned no route to ${constraint.name}.`, distanceMode: "driving",
      });
      return;
    }
    upsertNearbyPlace(property, {
      name: constraint.name,
      category: constraint.category || "other",
      distanceMiles,
      source: "calculated",
      distanceMode: "driving",
      checkedAt: new Date().toISOString(),
    });
    this.setEvaluation(property, constraint, {
      status: distanceMiles <= constraint.maxMiles ? "verified" : "failed",
      distanceMiles,
      detail: `${distanceMiles.toFixed(1)} driving miles to ${constraint.name} (HERE).`,
      distanceMode: "driving",
    });
  }

  private async geocode(address: string): Promise<LatLng | null> {
    const key = address.toLowerCase().replace(/\s+/g, " ").trim();
    const cached = this.geocodeCache.get(key);
    if (cached) return cached;
    const request = this.fetchGeocode(address);
    this.geocodeCache.set(key, request);
    return request;
  }

  private async fetchGeocode(address: string): Promise<LatLng | null> {
    const url = this.url("https://geocode.search.hereapi.com/v1/geocode", { q: address, limit: "1" });
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`Geocoding HTTP ${response.status}`);
    const payload: any = await response.json();
    const position = payload.items?.[0]?.position;
    return finiteLatLng(position?.lat, position?.lng);
  }

  private async searchGroceries(center: LatLng, radiusMeters: number): Promise<HerePlace[]> {
    const radius = clamp(radiusMeters, 1, 250000);
    const key = `${center.lat.toFixed(5)},${center.lng.toFixed(5)}:${radius.toFixed(0)}`;
    const cached = this.placesCache.get(key);
    if (cached) return cached;
    const request = this.fetchGroceries(center, radius);
    this.placesCache.set(key, request);
    return request;
  }

  private async fetchGroceries(center: LatLng, radiusMeters: number): Promise<HerePlace[]> {
    const url = this.url("https://browse.search.hereapi.com/v1/browse", {
      at: `${center.lat},${center.lng}`,
      in: `circle:${center.lat},${center.lng};r=${Math.round(radiusMeters)}`,
      categories: "600-6300-0066",
      limit: "20",
    });
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`Browse HTTP ${response.status}`);
    const payload: any = await response.json();
    const byId = new Map<string, HerePlace>();
    for (const item of payload.items || []) {
      const location = finiteLatLng(item.position?.lat, item.position?.lng);
      const categories = Array.isArray(item.categories) ? item.categories : [];
      if (!location || !item.id || !categories.some((category: any) => category.id === "600-6300-0066") || !isLargeGrocery(item)) continue;
      byId.set(String(item.id), {
        id: String(item.id), name: String(item.title || "Grocery store"), location,
        straightLineMeters: Number.isFinite(Number(item.distance)) ? Number(item.distance) : undefined,
      });
    }
    return [...byId.values()].sort((a, b) => (a.straightLineMeters ?? Infinity) - (b.straightLineMeters ?? Infinity));
  }

  private async routeDistance(origin: LatLng, destination: LatLng): Promise<number | null> {
    const key = `${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}>${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}`;
    const cached = this.routeCache.get(key);
    if (cached) return cached;
    const request = this.fetchRouteDistance(origin, destination);
    this.routeCache.set(key, request);
    return request;
  }

  private async fetchRouteDistance(origin: LatLng, destination: LatLng): Promise<number | null> {
    const url = this.url("https://router.hereapi.com/v8/routes", {
      transportMode: "car",
      routingMode: "short",
      departureTime: "any",
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
      return: "summary",
    });
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`Routing HTTP ${response.status}`);
    const payload: any = await response.json();
    const sections = payload.routes?.[0]?.sections;
    if (!Array.isArray(sections) || sections.length === 0) return null;
    const meters = sections.reduce((total: number, section: any) => total + Number(section.summary?.length || 0), 0);
    return Number.isFinite(meters) && meters > 0 ? meters / METERS_PER_MILE : null;
  }

  private async highwayAccessRoute(
    origin: LatLng,
    destination: LatLng,
    highway: HighwayDefinition,
  ): Promise<HighwayRouteResult | null> {
    const key = `${highway.canonicalName}:${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}>${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}`;
    const cached = this.highwayRouteCache.get(key);
    if (cached) return cached;
    const request = this.fetchHighwayAccessRoute(origin, destination, highway);
    this.highwayRouteCache.set(key, request);
    return request;
  }

  private async highwayCorridorProbes(highway: HighwayDefinition): Promise<LatLng[]> {
    const cached = this.highwayProbeCache.get(highway.canonicalName);
    if (cached) return cached;
    const request = this.fetchHighwayCorridorProbes(highway);
    this.highwayProbeCache.set(highway.canonicalName, request);
    return request;
  }

  private async fetchHighwayCorridorProbes(highway: HighwayDefinition): Promise<LatLng[]> {
    if (highway.anchors.length < 2) return [];
    const start = highway.anchors[0];
    const end = highway.anchors[highway.anchors.length - 1];
    const url = this.url("https://router.hereapi.com/v8/routes", {
      transportMode: "car",
      routingMode: "short",
      departureTime: "any",
      origin: `${start.lat},${start.lng}`,
      destination: `${end.lat},${end.lng}`,
      return: "polyline",
      spans: "names,routeNumbers,length",
      lang: "en-US",
    });
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`Highway corridor routing HTTP ${response.status}`);
    const payload: any = await response.json();
    const sections = payload.routes?.[0]?.sections;
    if (!Array.isArray(sections)) return [];

    const roadPoints: LatLng[] = [];
    for (const section of sections) {
      if (typeof section.polyline !== "string" || !Array.isArray(section.spans)) continue;
      let decoded: number[][];
      try {
        decoded = decode(section.polyline).polyline;
      } catch {
        continue;
      }
      const spans = section.spans;
      for (let index = 0; index < spans.length; index++) {
        const span = spans[index];
        const labels = [...roadLabels(span.names), ...roadLabels(span.routeNumbers)];
        if (!labels.some((label) => isHighwayRoadLabel(label, highway))) continue;
        const startOffset = clamp(Math.floor(Number(span.offset || 0)), 0, Math.max(0, decoded.length - 1));
        const endOffset = index + 1 < spans.length
          ? clamp(Math.floor(Number(spans[index + 1].offset || decoded.length)), startOffset + 1, decoded.length)
          : decoded.length;
        for (let pointIndex = startOffset; pointIndex < endOffset; pointIndex++) {
          const point = finiteLatLng(decoded[pointIndex]?.[0], decoded[pointIndex]?.[1]);
          if (point) roadPoints.push(point);
        }
      }
    }
    return samplePolyline(roadPoints, highway.probeSpacingMiles);
  }

  private async fetchHighwayAccessRoute(
    origin: LatLng,
    destination: LatLng,
    highway: HighwayDefinition,
  ): Promise<HighwayRouteResult | null> {
    const url = this.url("https://router.hereapi.com/v8/routes", {
      transportMode: "car",
      routingMode: "short",
      departureTime: "any",
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
      return: "summary,polyline",
      spans: "names,routeNumbers,length",
      lang: "en-US",
    });
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`Highway routing HTTP ${response.status}`);
    const payload: any = await response.json();
    const sections = payload.routes?.[0]?.sections;
    if (!Array.isArray(sections)) return null;

    let distanceMeters = 0;
    let lastMeaningfulRoad = "legal road access";
    let precedingSpans = 0;
    let measuredSpans = 0;
    for (const section of sections) {
      for (const span of section.spans || []) {
        const labels = [...roadLabels(span.names), ...roadLabels(span.routeNumbers)];
        if (labels.some((label) => isHighwayRoadLabel(label, highway))) {
          if (precedingSpans > 0 && measuredSpans !== precedingSpans) return null;
          return { distanceMiles: distanceMeters / METERS_PER_MILE, accessName: lastMeaningfulRoad };
        }
        const meaningful = labels.find((label) => !/^(?:ramp|unnamed road)$/i.test(label));
        if (meaningful) lastMeaningfulRoad = meaningful;
        const length = Number(span.length);
        if (Number.isFinite(length) && length >= 0) {
          distanceMeters += length;
          measuredSpans++;
        }
        precedingSpans++;
      }
    }
    return null;
  }

  private url(base: string, parameters: Record<string, string>): URL {
    const url = new URL(base);
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
    url.searchParams.set("apiKey", this.apiKey);
    return url;
  }

  private setEvaluation(
    property: Property,
    constraint: DistanceConstraint,
    value: { status: "verified" | "failed" | "unknown"; distanceMiles?: number; detail: string; distanceMode: "driving" | "straight-line" },
  ): void {
    const evaluation = {
      name: constraint.name,
      category: constraint.category || "other" as const,
      maxMiles: constraint.maxMiles,
      status: value.status,
      distanceMiles: value.distanceMiles,
      detail: value.detail,
      source: "here" as const,
      distanceMode: value.distanceMode,
      checkedAt: new Date().toISOString(),
    };
    property.distanceEvaluations ||= [];
    const index = property.distanceEvaluations.findIndex((item) => item.name.toLowerCase() === constraint.name.toLowerCase()
      || item.category === constraint.category);
    if (index >= 0) property.distanceEvaluations[index] = evaluation;
    else property.distanceEvaluations.push(evaluation);
    addDiagnostic(
      property,
      constraint.category === "grocery" ? "poi-search" : "routing",
      value.status === "unknown" ? "error" : "success",
      value.detail,
    );
  }

  private setHighwayEvaluation(
    property: Property,
    constraint: NonNullable<SearchCriteria["highwayAccess"]>,
    value: { status: "verified" | "failed" | "unknown"; distanceMiles?: number; accessName?: string; detail: string },
  ): void {
    property.highwayAccessEvaluation = {
      highwayName: constraint.highwayName,
      maxMiles: constraint.maxMiles,
      status: value.status,
      distanceMiles: value.distanceMiles,
      accessName: value.accessName,
      detail: value.detail,
      source: "here",
      distanceMode: "driving",
      checkedAt: new Date().toISOString(),
    };
    addDiagnostic(
      property,
      "highway-routing",
      value.status === "unknown" ? "error" : "success",
      value.detail,
    );
  }
}

function propertyAddress(property: Property): string | null {
  const title = property.title.trim();
  if (!/^\d+\s+\S+/.test(title) || /\bhome in\b|\bproperty\b/i.test(title)) return null;
  return title.toLowerCase().includes(property.location.toLowerCase()) ? title : `${title}, ${property.location}`;
}

function coordinates(property: Property): LatLng | null { return finiteLatLng(property.latitude, property.longitude); }

function finiteLatLng(lat: unknown, lng: unknown): LatLng | null {
  const latitude = Number(lat), longitude = Number(lng);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? { lat: latitude, lng: longitude } : null;
}

function distanceMode(): "driving" | "straight-line" {
  const value = process.env.RE_GEO_DISTANCE_MODE || process.env.GEO_DISTANCE_MODE || "STRAIGHT_LINE";
  return ["DRIVE", "DRIVING"].includes(value.toUpperCase()) ? "driving" : "straight-line";
}

function upsertNearbyPlace(property: Property, place: NonNullable<Property["nearbyPlaces"]>[number]): void {
  property.nearbyPlaces ||= [];
  const index = property.nearbyPlaces.findIndex((item) => item.placeId && item.placeId === place.placeId
    || item.name.toLowerCase() === place.name.toLowerCase());
  if (index >= 0) property.nearbyPlaces[index] = place;
  else property.nearbyPlaces.push(place);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);
}

function safeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function haversineMiles(a: LatLng, b: LatLng): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function samplePolyline(points: LatLng[], spacingMiles: number): LatLng[] {
  if (points.length === 0) return [];
  const samples = [points[0]];
  let remaining = spacingMiles;
  for (let index = 1; index < points.length; index++) {
    let from = points[index - 1];
    const to = points[index];
    let segmentMiles = haversineMiles(from, to);
    while (segmentMiles >= remaining && segmentMiles > 0) {
      const fraction = remaining / segmentMiles;
      const sample = {
        lat: from.lat + (to.lat - from.lat) * fraction,
        lng: from.lng + (to.lng - from.lng) * fraction,
      };
      samples.push(sample);
      from = sample;
      segmentMiles -= remaining;
      remaining = spacingMiles;
    }
    remaining -= segmentMiles;
  }
  const last = points[points.length - 1];
  if (haversineMiles(samples[samples.length - 1], last) > 0.05) samples.push(last);
  return samples;
}

function roadLabels(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((item) => typeof item === "string" ? item : String(item?.value || "")).filter(Boolean);
}

function isLargeGrocery(item: any): boolean {
  const title = String(item.title || "").toLowerCase();
  const knownLargeChains = /\b(?:publix|kroger|aldi|lidl|whole foods|trader joe'?s|food lion|ingles|piggly wiggly|walmart supercenter|sam'?s club|costco|fresh market|earth fare|save a lot)\b/i;
  const explicitStoreType = /\b(?:supermarket|super market|grocery|food market|farmers market|warehouse club)\b/i;
  return knownLargeChains.test(title) || explicitStoreType.test(title);
}

function addDiagnostic(
  property: Property,
  stage: NonNullable<Property["evidenceDiagnostics"]>[number]["stage"],
  status: NonNullable<Property["evidenceDiagnostics"]>[number]["status"],
  detail: string,
): void {
  property.evidenceDiagnostics ||= [];
  property.evidenceDiagnostics.push({ stage, status, detail });
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) await worker(items[nextIndex++]);
  });
  await Promise.all(runners);
}

export const hereMapsService = new HereMapsService();
