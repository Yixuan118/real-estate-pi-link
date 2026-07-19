import { DistanceConstraint, Property, SearchCriteria } from "../core/types";
import { normalizeDistanceConstraint } from "../core/property-matcher";

interface LatLng { lat: number; lng: number }

interface NearbyPlace {
  id: string;
  name: string;
  location: LatLng;
  primaryType?: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const METERS_PER_MILE = 1609.344;
const GROCERY_TYPES = ["supermarket", "grocery_store", "discount_supermarket", "hypermarket", "warehouse_store"];

export class GoogleMapsService {
  private apiKey: string;
  private fetchImpl: FetchLike;
  private geocodeCache = new Map<string, Promise<LatLng | null>>();
  private placesCache = new Map<string, Promise<NearbyPlace[]>>();

  constructor(apiKey = process.env.GOOGLE_MAPS_API_KEY || "", fetchImpl: FetchLike = fetch) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  get enabled(): boolean { return Boolean(this.apiKey); }

  async enrichProperties(
    properties: Property[],
    criteria: SearchCriteria,
    onProgress?: (message: string) => void,
  ): Promise<Property[]> {
    if (!this.enabled || !criteria.distanceConstraints?.length || properties.length === 0) return properties;
    const limit = Math.max(1, Math.min(Number(process.env.RE_GEO_ENRICH_LIMIT || 20), 50));
    const result = [...properties];
    const indexes = result.slice(0, limit).map((_, index) => index);
    let completed = 0;
    await mapWithConcurrency(indexes, 4, async (index) => {
      result[index] = await this.enrichProperty(result[index], criteria.distanceConstraints || []);
      completed++;
      onProgress?.(`Google Maps verified ${completed}/${indexes.length} properties`);
    });
    return result;
  }

  async enrichProperty(property: Property, constraints: DistanceConstraint[]): Promise<Property> {
    const enriched: Property = {
      ...property,
      nearbyPlaces: [...(property.nearbyPlaces || [])],
      distanceEvaluations: [...(property.distanceEvaluations || [])],
    };

    if (enriched.latitude == null || enriched.longitude == null) {
      const address = this.propertyAddress(enriched);
      if (address) {
        const coordinates = await this.geocode(address);
        if (coordinates) {
          enriched.latitude = coordinates.lat;
          enriched.longitude = coordinates.lng;
          enriched.coordinateSource = "google-geocoding";
        }
      }
    } else {
      enriched.coordinateSource ||= "listing";
    }

    for (const rawConstraint of constraints) {
      const constraint = normalizeDistanceConstraint(rawConstraint);
      if (!constraint) continue;
      try {
        if (constraint.category === "grocery") {
          await this.evaluateGrocery(enriched, constraint);
        } else if (this.distanceMode() === "driving" && constraint.lat != null && constraint.lng != null) {
          await this.evaluateDestination(enriched, constraint);
        }
      } catch (error) {
        this.setEvaluation(enriched, constraint, {
          status: "unknown",
          detail: `Google Maps verification failed: ${safeError(error)}`,
          distanceMode: constraint.category === "grocery" ? "driving" : this.distanceMode(),
        });
      }
    }
    return enriched;
  }

  private async evaluateGrocery(property: Property, constraint: DistanceConstraint): Promise<void> {
    const origin = this.coordinates(property);
    if (!origin) {
      this.setEvaluation(property, constraint, {
        status: "unknown", detail: "The property address could not be geocoded.", distanceMode: "driving",
      });
      return;
    }

    const places = await this.searchNearbyGroceries(origin, constraint.maxMiles * METERS_PER_MILE);
    if (places.length === 0) {
      this.setEvaluation(property, constraint, {
        status: "failed",
        detail: `Google Places found no supermarket or large grocery store within ${constraint.maxMiles} straight-line miles.`,
        distanceMode: "driving",
      });
      return;
    }

    const distances = await this.computeDrivingDistances(origin, places.map((place) => place.location));
    const reachable = places.map((place, index) => ({ place, distanceMiles: distances[index] }))
      .filter((item): item is { place: NearbyPlace; distanceMiles: number } => item.distanceMiles != null)
      .sort((a, b) => a.distanceMiles - b.distanceMiles);
    if (reachable.length === 0) {
      this.setEvaluation(property, constraint, {
        status: "unknown", detail: "Google Routes returned no drivable route to the nearby grocery candidates.", distanceMode: "driving",
      });
      return;
    }

    const nearest = reachable[0];
    this.upsertNearbyPlace(property, {
      name: nearest.place.name,
      category: "grocery",
      distanceMiles: nearest.distanceMiles,
      source: "calculated",
      placeId: nearest.place.id,
      distanceMode: "driving",
      checkedAt: new Date().toISOString(),
    });
    const status = nearest.distanceMiles <= constraint.maxMiles ? "verified" : "failed";
    this.setEvaluation(property, constraint, {
      status,
      distanceMiles: nearest.distanceMiles,
      detail: `${nearest.place.name} is ${nearest.distanceMiles.toFixed(1)} driving miles away.`,
      distanceMode: "driving",
    });
  }

  private async evaluateDestination(property: Property, constraint: DistanceConstraint): Promise<void> {
    const origin = this.coordinates(property);
    if (!origin || constraint.lat == null || constraint.lng == null) {
      this.setEvaluation(property, constraint, {
        status: "unknown", detail: "Coordinates are unavailable for route calculation.", distanceMode: "driving",
      });
      return;
    }
    const [distanceMiles] = await this.computeDrivingDistances(origin, [{ lat: constraint.lat, lng: constraint.lng }]);
    if (distanceMiles == null) {
      this.setEvaluation(property, constraint, {
        status: "unknown", detail: `Google Routes returned no route to ${constraint.name}.`, distanceMode: "driving",
      });
      return;
    }
    this.upsertNearbyPlace(property, {
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
      detail: `${distanceMiles.toFixed(1)} driving miles to ${constraint.name}.`,
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
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", this.apiKey);
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`Geocoding HTTP ${response.status}`);
    const payload: any = await response.json();
    if (payload.status === "ZERO_RESULTS") return null;
    if (payload.status !== "OK") throw new Error(`Geocoding status ${payload.status || "unknown"}`);
    const location = payload.results?.[0]?.geometry?.location;
    return finiteLatLng(location?.lat, location?.lng);
  }

  private async searchNearbyGroceries(center: LatLng, radiusMeters: number): Promise<NearbyPlace[]> {
    const radius = Math.min(Math.max(radiusMeters, 1), 50000);
    const cacheKey = `${center.lat.toFixed(5)},${center.lng.toFixed(5)}:${radius.toFixed(0)}`;
    const cached = this.placesCache.get(cacheKey);
    if (cached) return cached;
    const request = this.fetchNearbyGroceries(center, radius);
    this.placesCache.set(cacheKey, request);
    return request;
  }

  private async fetchNearbyGroceries(center: LatLng, radiusMeters: number): Promise<NearbyPlace[]> {
    const response = await this.fetchImpl("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.primaryType,places.types",
      },
      body: JSON.stringify({
        includedTypes: GROCERY_TYPES,
        maxResultCount: 20,
        rankPreference: "DISTANCE",
        locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: radiusMeters } },
      }),
    });
    if (!response.ok) throw new Error(`Places HTTP ${response.status}`);
    const payload: any = await response.json();
    return (payload.places || []).map((place: any) => ({
      id: String(place.id || ""),
      name: String(place.displayName?.text || "Grocery store"),
      primaryType: place.primaryType,
      location: { lat: Number(place.location?.latitude), lng: Number(place.location?.longitude) },
    })).filter((place: NearbyPlace) => place.id && Number.isFinite(place.location.lat) && Number.isFinite(place.location.lng));
  }

  private async computeDrivingDistances(origin: LatLng, destinations: LatLng[]): Promise<Array<number | null>> {
    if (destinations.length === 0) return [];
    const response = await this.fetchImpl("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,status,condition",
      },
      body: JSON.stringify({
        origins: [{ waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } } }],
        destinations: destinations.map((destination) => ({
          waypoint: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
        })),
        travelMode: "DRIVE",
      }),
    });
    if (!response.ok) throw new Error(`Routes HTTP ${response.status}`);
    const payload: any = await response.json();
    const elements = Array.isArray(payload) ? payload : payload.elements || [];
    const distances: Array<number | null> = destinations.map(() => null);
    for (const element of elements) {
      const index = Number(element.destinationIndex);
      const meters = Number(element.distanceMeters);
      if (Number.isInteger(index) && index >= 0 && index < distances.length
          && Number.isFinite(meters) && (!element.condition || element.condition === "ROUTE_EXISTS")) {
        distances[index] = meters / METERS_PER_MILE;
      }
    }
    return distances;
  }

  private propertyAddress(property: Property): string | null {
    const title = property.title.trim();
    if (!/^\d+\s+\S+/.test(title) || /\bhome in\b|\bproperty\b/i.test(title)) return null;
    return title.toLowerCase().includes(property.location.toLowerCase()) ? title : `${title}, ${property.location}`;
  }

  private coordinates(property: Property): LatLng | null {
    return finiteLatLng(property.latitude, property.longitude);
  }

  private distanceMode(): "driving" | "straight-line" {
    const configured = process.env.RE_GEO_DISTANCE_MODE || process.env.GEO_DISTANCE_MODE || "STRAIGHT_LINE";
    return configured.toUpperCase() === "DRIVE" || configured.toUpperCase() === "DRIVING" ? "driving" : "straight-line";
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
      source: "google-maps" as const,
      distanceMode: value.distanceMode,
      checkedAt: new Date().toISOString(),
    };
    property.distanceEvaluations ||= [];
    const index = property.distanceEvaluations.findIndex((item) => item.name.toLowerCase() === constraint.name.toLowerCase()
      || item.category === constraint.category);
    if (index >= 0) property.distanceEvaluations[index] = evaluation;
    else property.distanceEvaluations.push(evaluation);
  }

  private upsertNearbyPlace(property: Property, place: NonNullable<Property["nearbyPlaces"]>[number]): void {
    property.nearbyPlaces ||= [];
    const index = property.nearbyPlaces.findIndex((item) => item.placeId && item.placeId === place.placeId
      || item.name.toLowerCase() === place.name.toLowerCase());
    if (index >= 0) property.nearbyPlaces[index] = place;
    else property.nearbyPlaces.push(place);
  }
}

function finiteLatLng(lat: unknown, lng: unknown): LatLng | null {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { lat: latitude, lng: longitude };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export const googleMapsService = new GoogleMapsService();
