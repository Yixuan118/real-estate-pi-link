import { SearchCriteria, Property } from "../core/types";
import { firecrawlSkill } from "../skills/firecrawl-skill";

export class ScraperAgent {
  private _active: boolean = false;
  private _lastSearchCriteria: SearchCriteria | null = null;

  get active(): boolean { return this._active; }
  get lastSearchCriteria(): SearchCriteria | null { return this._lastSearchCriteria; }

  async search(criteria: SearchCriteria, onProgress?: (message: string) => void): Promise<{ properties: Property[]; totalCount: number }> {
    this._active = true;
    this._lastSearchCriteria = { ...criteria };

    try {
      onProgress?.("Searching Realtor.com via Firecrawl...");
      const result = await firecrawlSkill.searchProperties(criteria);
      if (result.error) { onProgress?.(result.error); return { properties: [], totalCount: 0 }; }
      onProgress?.("Found " + result.totalCount + " properties from " + result.source);
      return { properties: result.properties, totalCount: result.totalCount };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress?.("Firecrawl error: " + msg);
      return { properties: [], totalCount: 0 };
    } finally {
      this._active = false;
    }
  }

  async checkForNew(criteria: SearchCriteria, onProgress?: (message: string) => void): Promise<Property[]> {
    this._active = true;
    try {
      onProgress?.("Checking for new listings...");
      const result = await firecrawlSkill.searchProperties(criteria);
      return result.properties || [];
    } catch (err) {
      onProgress?.("Error: " + (err instanceof Error ? err.message : String(err)));
      return [];
    } finally {
      this._active = false;
    }
  }
}

export const scraperAgent = new ScraperAgent();