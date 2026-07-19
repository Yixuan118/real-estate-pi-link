import { Property, SearchCriteria } from "../core/types";
import { googleMapsService } from "./google-maps-service";
import { hereMapsService } from "./here-maps-service";

export interface GeoValidationProvider {
  readonly enabled: boolean;
  enrichProperties(properties: Property[], criteria: SearchCriteria, onProgress?: (message: string) => void): Promise<Property[]>;
}

class GeoValidationService {
  get providerName(): "here" | "google" | "none" {
    const requested = (process.env.RE_MAP_PROVIDER || "").toLowerCase();
    if (requested === "here") return hereMapsService.enabled ? "here" : "none";
    if (requested === "google") return googleMapsService.enabled ? "google" : "none";
    if (hereMapsService.enabled) return "here";
    if (googleMapsService.enabled) return "google";
    return "none";
  }

  get enabled(): boolean { return this.providerName !== "none"; }

  async ensureCoordinates(property: Property): Promise<Property> {
    if (this.providerName === "here") return hereMapsService.enrichProperty(property, []);
    if (this.providerName === "google") return googleMapsService.enrichProperty(property, []);
    return property;
  }

  async enrichProperties(properties: Property[], criteria: SearchCriteria, onProgress?: (message: string) => void): Promise<Property[]> {
    // Named-highway span inspection is currently implemented with HERE Routing.
    // Prefer it for the whole map-enrichment pass so coordinates and route evidence
    // come from one provider when a highway constraint is present.
    if (criteria.highwayAccess && hereMapsService.enabled) {
      return hereMapsService.enrichProperties(properties, criteria, onProgress);
    }
    const provider = this.providerName === "here" ? hereMapsService : this.providerName === "google" ? googleMapsService : null;
    return provider ? provider.enrichProperties(properties, criteria, onProgress) : properties;
  }
}

export const geoValidationService = new GeoValidationService();
