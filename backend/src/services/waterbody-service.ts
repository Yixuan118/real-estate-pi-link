import { Property, SearchCriteria } from "../core/types";

type FetchLike = typeof fetch;
type Point = [number, number]; // [longitude, latitude]

const USGS_COLLECTION = "https://hydro.nationalmap.gov/arcgis/rest/services/3DHP_all/FeatureServer/60/query";
const METERS_PER_MILE = 1609.344;
const SQ_KM_TO_ACRES = 247.105381;

export class WaterbodyService {
  private readonly cache = new Map<string, Promise<NonNullable<Property["nearbyWaterBodies"]>>>();

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async enrichProperties(properties: Property[], criteria: SearchCriteria): Promise<Property[]> {
    if (!hasLakeCriterion(criteria) || properties.length === 0) return properties;
    const limit = clamp(Number(process.env.RE_WATERBODY_ENRICH_LIMIT || 20), 1, 20);
    const result = [...properties];
    await mapWithConcurrency(result.slice(0, limit).map((_, index) => index), 4, async (index) => {
      result[index] = await this.enrichProperty(result[index]);
    });
    for (let index = limit; index < result.length; index++) {
      result[index] = addDiagnostic(result[index], "waterbody-search", "warning", `Waterbody validation limit ${limit} reached.`);
    }
    return result;
  }

  async enrichProperty(property: Property): Promise<Property> {
    if (property.latitude == null || property.longitude == null) {
      return addDiagnostic(property, "waterbody-search", "warning", "Property coordinates are unavailable; nearby mapped waterbodies could not be checked.");
    }
    const radiusMiles = clamp(Number(process.env.RE_WATERBODY_RADIUS_MILES || 3), 0.25, 10);
    const key = `${property.latitude.toFixed(5)},${property.longitude.toFixed(5)}:${radiusMiles}`;
    let request = this.cache.get(key);
    if (!request) {
      request = this.query(property.latitude, property.longitude, radiusMiles).catch((error) => {
        this.cache.delete(key);
        throw error;
      });
      this.cache.set(key, request);
    }
    try {
      const bodies = await request;
      const enriched = { ...property, nearbyWaterBodies: bodies };
      const nearest = bodies[0];
      return nearest
        ? addDiagnostic(enriched, "waterbody-search", "success", `${nearest.name} is ${nearest.distanceMiles.toFixed(2)} straight-line miles from the property boundary point (USGS hydrography). This proves proximity, not HOA ownership or resident access.`)
        : addDiagnostic(enriched, "waterbody-search", "warning", `USGS hydrography found no mapped lake, pond, or reservoir within ${radiusMiles} miles.`);
    } catch (error) {
      return addDiagnostic(property, "waterbody-search", "error", `USGS waterbody lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async query(latitude: number, longitude: number, radiusMiles: number): Promise<NonNullable<Property["nearbyWaterBodies"]>> {
    const url = new URL(USGS_COLLECTION);
    url.search = new URLSearchParams({
      where: "1=1",
      geometry: `${longitude},${latitude}`, geometryType: "esriGeometryPoint", inSR: "4326",
      spatialRel: "esriSpatialRelIntersects", distance: String(radiusMiles), units: "esriSRUnit_StatuteMile",
      outFields: "id3dhp,gnisidlabel,featuretypelabel,areasqkm", returnGeometry: "true", outSR: "4326", f: "geojson",
    }).toString();
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: any = await response.json();
    const origin: Point = [longitude, latitude];
    const checkedAt = new Date().toISOString();
    return (payload.features || []).map((feature: any) => {
      const distanceMiles = geometryDistanceMiles(origin, feature.geometry);
      const properties = feature.properties || {};
      const ftype = String(properties.featuretypelabel || properties.FTYPE || properties.ftype || "");
      return {
        name: String(properties.gnisidlabel || properties.GNIS_NAME || properties.gnis_name || "").trim() || (/reservoir/i.test(ftype) ? "Unnamed reservoir" : "Unnamed lake/pond"),
        type: /reservoir/i.test(ftype) ? "reservoir" as const : /lake|pond|390/i.test(ftype) ? "lake-pond" as const : "waterbody" as const,
        distanceMiles,
        areaAcres: Number.isFinite(Number(properties.AREASQKM ?? properties.areasqkm)) ? Number(properties.AREASQKM ?? properties.areasqkm) * SQ_KM_TO_ACRES : undefined,
        source: "USGS 3D Hydrography Program" as const,
        sourceUrl: USGS_COLLECTION,
        checkedAt,
      };
    }).filter((item: any) => Number.isFinite(item.distanceMiles) && item.distanceMiles <= radiusMiles)
      .sort((a: any, b: any) => a.distanceMiles - b.distanceMiles)
      .slice(0, 5);
  }
}

function hasLakeCriterion(criteria: SearchCriteria): boolean {
  return Boolean(criteria.communityFeatures?.some((item) => /lake|pond/i.test(item)));
}

function geometryDistanceMiles(point: Point, geometry: any): number {
  const polygons: Point[][][] = geometry?.type === "Polygon" ? [geometry.coordinates]
    : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
  let minimumMeters = Infinity;
  for (const polygon of polygons) {
    if (polygon[0] && pointInRing(point, polygon[0])) return 0;
    for (const ring of polygon) {
      for (let index = 1; index < ring.length; index++) {
        minimumMeters = Math.min(minimumMeters, pointToSegmentMeters(point, ring[index - 1], ring[index]));
      }
    }
  }
  return minimumMeters / METERS_PER_MILE;
}

function pointInRing(point: Point, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1])
        && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointToSegmentMeters(point: Point, start: Point, end: Point): number {
  const latitude = point[1] * Math.PI / 180;
  const scaleX = 111320 * Math.cos(latitude), scaleY = 110540;
  const px = point[0] * scaleX, py = point[1] * scaleY;
  const ax = start[0] * scaleX, ay = start[1] * scaleY;
  const bx = end[0] * scaleX, by = end[1] * scaleY;
  const dx = bx - ax, dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function addDiagnostic(property: Property, stage: "waterbody-search", status: "success" | "warning" | "error", detail: string): Property {
  return { ...property, evidenceDiagnostics: [...(property.evidenceDiagnostics || []), { stage, status, detail }] };
}

function clamp(value: number, min: number, max: number): number { return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max); }

async function mapWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

export const waterbodyService = new WaterbodyService();
