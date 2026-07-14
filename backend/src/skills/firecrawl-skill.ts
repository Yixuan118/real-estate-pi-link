import { SearchCriteria, Property } from "../core/types";

export class FirecrawlSkill {
  private apiKey: string;
  private maxResults: number = 100;

  constructor() {
    this.apiKey = process.env.FIRECRAWL_API_KEY ;
  }

  async searchProperties(criteria: SearchCriteria): Promise<{ properties: Property[]; source: string; totalCount: number; error?: string }> {
    console.log("[FirecrawlSkill] Search:", JSON.stringify(criteria));
    if (!criteria.location) return { properties: [], source: "none", totalCount: 0, error: "Please specify a location" };

    const applyFilters = (props: any[], content?: string): any[] => {
      if (!props.length) return props;
      return props.filter((p: any) => {
        if (criteria.location) {
          const w = criteria.location.replace(/\s+(priced|under|over|budget|max|min|million|thousand|k|dollars?).*$/i, "").trim().toLowerCase().split(/[\s,]+/).filter(x => x.length > 0);
          const pl = p.location.toLowerCase();
          if (!w.every(x => pl.includes(x))) return false;
        }
        if (criteria.minPrice != null && p.price < criteria.minPrice) return false;
        if (criteria.maxPrice != null && p.price > criteria.maxPrice) return false;
        if (criteria.minBedrooms != null && p.bedrooms < criteria.minBedrooms) return false;
        if (criteria.minBathrooms != null && p.bathrooms < criteria.minBathrooms) return false;
        if (criteria.mustHave && criteria.mustHave.length > 0) {
          const tl = p.title.toLowerCase(), ll = p.location.toLowerCase(), fl = (p.features||[]).map((f: any) => f.toLowerCase());
          for (const kw of criteria.mustHave) {
            const kl = kw.toLowerCase();
            if (!fl.some((f: any) => f.includes(kl)) && !tl.includes(kl) && !ll.includes(kl)) {
              if (!(p.features && p.features.length > 0) && content && content.toLowerCase().includes(kl)) continue;
              return false;
            }
          }
        }
        return true;
      });
    };

    try {
      const loc = this.parseLocation(criteria.location);
      let targetUrl = "https://www.realtor.com/realestateandhomes-search/" + loc.citySlug + "_" + loc.stateCode;

      const page = (criteria as any).page || 1;
      if (page > 1) {
        targetUrl += `/pg-${page}`;
      }

      console.log("[FirecrawlSkill] Fetching:", targetUrl);

let data: any;

try {
    const controller = new AbortController();

    // 超时时间改成120秒
    const timeout = setTimeout(() => {
        controller.abort();
    }, 120000);

    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
            url: targetUrl,

            // 两种格式即可
            formats: ["rawHtml", "markdown"],

            // 页面等待时间
            waitFor: 5000,
        }),
        signal: controller.signal,
    });

    clearTimeout(timeout);

    console.log("[FirecrawlSkill] HTTP Status:", res.status);

    if (!res.ok) {
        const text = await res.text();
        console.error("[FirecrawlSkill] HTTP Error:");
        console.error(text);

        throw new Error(`Firecrawl HTTP ${res.status}`);
    }

    data = await res.json();

    console.log(
        "[FirecrawlSkill] success:",
        data.success,
        "hasData:",
        !!data.data
    );

} catch (err: any) {
    console.error("[FirecrawlSkill] Request Failed");
    console.error(err);

    throw err;
}

      if (data.success && data.data) {
        const raw = data.data.rawHtml || "";
        if (raw.length > 1000) {const md = data.data.markdown || data.data.content || "";
          console.log("[FirecrawlSkill] Got rawHtml:", raw.length, "chars");
          const fromHtml = this.parsePropertiesFromHtml(raw, criteria, md);
          if (fromHtml.length > 0) {
            console.log("[FirecrawlSkill] Extracted", fromHtml.length, "properties from JSON-LD");
            const filteredHtml = applyFilters(fromHtml, raw); return { properties: filteredHtml, source: "realtor.com (via Firecrawl)", totalCount: filteredHtml.length };
          }
          console.log("[FirecrawlSkill] JSON-LD yielded 0, trying markdown...");
        }
        const md = data.data.markdown || data.data.content || "";
        if (md.length > 100) {
          console.log("[FirecrawlSkill] Got markdown:", md.length, "chars");
          const fromMd = this.parseContent(md, criteria);
          if (fromMd.length > 0) {
            console.log("[FirecrawlSkill] Parsed", fromMd.length, "properties from markdown");
            return { properties: fromMd, source: "realtor.com (via Firecrawl)", totalCount: fromMd.length };
          }
          console.log("[FirecrawlSkill] Markdown parser returned 0");
        }
      } else {
        console.log("[FirecrawlSkill] Firecrawl returned no data:", JSON.stringify(data).substring(0, 300));
      }
    } catch (err: any) {
    console.error("[FirecrawlSkill]");
    console.error(err);

    if (err.name === "AbortError") {
        console.error("Firecrawl Timeout (>120s)");
    }

    console.log("[FirecrawlSkill] Using demo database for", criteria.location);

    const results = this.demoSearch(criteria);

    return {
        properties: results,
        source: "demo-database",
        totalCount: results.length,
        error: err.message,
    };
}

    console.log("[FirecrawlSkill] Using demo database for", criteria.location);
    const results = this.demoSearch(criteria);
    return { properties: results, source: "demo-database", totalCount: results.length };
  }

  async checkForNewProperties(criteria: SearchCriteria): Promise<Property[]> {
    const result = await this.searchProperties(criteria);
    return result.properties;
  }

  private parseLocation(location: string): { citySlug: string; stateCode: string } {
    const cityToState = this.getCityToState();
    // Strip price/noise words before location matching
    let clean = location.toLowerCase().trim();
    clean = clean.replace(/\s+(priced|under|over|budget|max|min|million|thousand|k|dollars?)\b.*$/i, "").trim();
    const lower = clean;
    if (lower.includes("atlanta")) return { citySlug: "atlanta", stateCode: "GA" }; if (lower.includes("seattle")) return { citySlug: "seattle", stateCode: "WA" };
    if (lower.includes("new york")) return { citySlug: "new-york", stateCode: "NY" };
    if (lower.includes("san francisco")) return { citySlug: "san-francisco", stateCode: "CA" };
    if (lower.includes("los angeles")) return { citySlug: "los-angeles", stateCode: "CA" };
    if (lower.includes("chicago")) return { citySlug: "chicago", stateCode: "IL" };
    if (lower.includes("boston")) return { citySlug: "boston", stateCode: "MA" };
    if (lower.includes("miami")) return { citySlug: "miami", stateCode: "FL" };
    if (lower.includes("austin")) return { citySlug: "austin", stateCode: "TX" };
    if (lower.includes("denver")) return { citySlug: "denver", stateCode: "CO" };
    if (lower.includes("athens")) return { citySlug: "athens", stateCode: "GA" };
    if (lower.includes("portland")) return { citySlug: "portland", stateCode: "OR" };
    if (lower.includes("philadelphia")) return { citySlug: "philadelphia", stateCode: "PA" };
    if (lower.includes("washington")) return { citySlug: "washington", stateCode: "DC" };
    if (lower.includes("phoenix")) return { citySlug: "phoenix", stateCode: "AZ" };
    if (lower.includes("detroit")) return { citySlug: "detroit", stateCode: "MI" };
    if (lower.includes("san diego")) return { citySlug: "san-diego", stateCode: "CA" };

    const stateMatch = lower.match(/,?\s*([a-z]{2})$/);
    if (stateMatch && stateMatch[1].length === 2) {
      const city = lower.replace(/,?\s*[a-z]{2}$/, "").trim();
      return { citySlug: city.replace(/[^a-z0-9]+/g, "-").replace(/-$/g, ""), stateCode: stateMatch[1].toUpperCase() };
    }
    for (const [city, state] of Object.entries(cityToState)) {
      if (lower.includes(city)) {
        return { citySlug: city.replace(/[^a-z0-9]+/g, "-").replace(/-$/g, ""), stateCode: state };
      }
    }
    return { citySlug: lower.replace(/[^a-z0-9]+/g, "-").replace(/-$/g, ""), stateCode: "WA" };
  }

  private getCityToState(): Record<string, string> {
    return {
      "atlanta": "GA", "seattle": "WA", "bellevue": "WA", "redmond": "WA", "kirkland": "WA",
      "new york": "NY", "manhattan": "NY", "brooklyn": "NY",
      "san francisco": "CA", "los angeles": "CA", "san diego": "CA",
      "santa monica": "CA", "long beach": "CA", "sacramento": "CA",
      "miami": "FL", "orlando": "FL",
      "austin": "TX", "dallas": "TX", "houston": "TX",
      "denver": "CO",
      "boston": "MA",
      "chicago": "IL",
      "portland": "OR", "salem": "OR",
      "philadelphia": "PA",
      "washington": "DC",
      "nashville": "TN",

      "phoenix": "AZ",
      "detroit": "MI",
      "athens": "GA",
    };
  }


  private parsePropertiesFromHtml(raw: string, criteria: SearchCriteria, markdown?: string): Property[] {
    const props: Property[] = [];
    try {
      const scriptMatch = raw.match(/<script[^>]*data-testid="seoLinkingData"[^>]*>([\s\S]*?)<\/script>/);
      if (!scriptMatch) throw new Error("No seoLinkingData found");
      const jsonLd = JSON.parse(scriptMatch[1]);
      if (!Array.isArray(jsonLd)) throw new Error("JSON-LD is not an array");
      let listings: any[] = [];
      for (const item of jsonLd) {
        if (item["@type"] === "CollectionPage" && item.mainEntity?.itemListElement) {
          listings = item.mainEntity.itemListElement;
          break;
        }
      }
      if (listings.length === 0) throw new Error("No listings found");
      console.log("[FirecrawlSkill] JSON-LD parsed:", listings.length, "listings");
      for (let i = 0; i < listings.length && props.length < this.maxResults; i++) {
        const listing = listings[i];
        if (!listing || !listing["@type"]) continue;
        const me = listing.mainEntity || {};
        const address = me.address || {};
        const offers = listing.offers || {};
        const priceVal = parseInt(offers.price) || 0;
        if (priceVal < 50000 || priceVal > 50000000) continue;
        const bedroomVal = parseInt(me.numberOfBedrooms) || 0;
        const sqftVal = parseInt(me.floorSize?.value) || parseInt(me.livingArea) || 0;
        const street = address.streetAddress || "";
        const city = address.addressLocality || "";
        const state = address.addressRegion || "";
        const zip = address.postalCode || "";
        const imageUrl = listing.image || "";
        const url = listing.url || "";
        let bathrooms = parseInt(me.numberOfBathrooms) || 0;
        if (!bathrooms) bathrooms = parseInt(me.bathroomsTotal) || 0;
        props.push({
          id: "r" + (i + 1),
          title: listing.name || street || (city ? "Home in " + city : bedroomVal + "BR Home"),
          price: priceVal, bedrooms: bedroomVal, bathrooms, sqft: sqftVal,
          location: city ? city + ", " + state + (zip ? " " + zip : "") : state, features: [],
          url: url, imageUrl: imageUrl,
          listedAt: new Date().toISOString(), source: "Realtor.com",
        });
      }
    } catch (e: any) {
      console.log("[FirecrawlSkill] JSON-LD parse error:", e.message);
    }
    if (markdown) this.enrichBathroomsFromMarkdown(props, markdown);
    return props;
  }


  private enrichBathroomsFromMarkdown(props: Property[], markdown: string): void {
    const lines = markdown.split("\n").map(l => l.trim());
    for (const prop of props) {
      if (prop.bathrooms > 0) continue;
      const streetPart = (prop.title.split(",")[0] || "").replace(/^[0-9]+\s*/, "").substring(0, 20).toLowerCase();
      const priceStr = "$" + prop.price.toLocaleString();
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(priceStr)) continue;
        let addrConfirmed = true;
        if (streetPart.length >= 3) {
          addrConfirmed = false;
          for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
            if (lines[j].toLowerCase().includes(streetPart)) { addrConfirmed = true; break; }
            if (/^\$[\d,]+/.test(lines[j]) && !lines[j].includes(priceStr)) break;
          }
          if (!addrConfirmed) continue;
        }
        const ctxStart = Math.max(0, i - 3);
        const ctxEnd = Math.min(lines.length, i + 7);
        const ctx = lines.slice(ctxStart, ctxEnd).join(" ");
        const bathMatch = ctx.match(/(\d[\d.]*)\+?\s*(?:ba|bath|baths)\b/i);
        if (bathMatch) {
          const v = Math.floor(parseFloat(bathMatch[1]));
          if (!isNaN(v) && v > 0 && v < 20) prop.bathrooms = v;
        }
        break;
      }
    }
  }

  private extractBathrooms(raw: string, props: Property[]): void {
    const bathValues: number[] = [];
    const metaBathRegex = /property-meta-bath[^>]*>([^<]+)</g;
    let m;
    while ((m = metaBathRegex.exec(raw)) !== null) {
      const n = m[1].match(/[\d.]+/);
      if (n) { const v = parseFloat(n[0]); if (!isNaN(v) && v > 0 && v < 20) bathValues.push(v); }
    }
    const bathRegex = />\s*([\d.]+)\+?\s*(?:bath|ba)\s*</gi;
    while ((m = bathRegex.exec(raw)) !== null) {
      const v = parseFloat(m[1]);
      if (!isNaN(v) && v > 0 && v < 20) bathValues.push(v);
    }
    console.log("[FirecrawlSkill] Bath values found:", bathValues.length);
    for (let i = 0; i < props.length && i < bathValues.length; i++) props[i].bathrooms = bathValues[i];
  }

  private extractAll(str: string, regex: RegExp): any[][] {
    const results: any[][] = [];
    let m;
    while ((m = regex.exec(str)) !== null) results.push(Array.from(m));
    return results;
  }
  private parseContent(content: string, criteria: SearchCriteria): Property[] {
    const props: Property[] = [];
    const seen = new Set<string>();
    let id = 0;
    const lines = content.split("\n").map(l => l.trim());

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.startsWith("|") || line.startsWith("[!") || /^\\+$/.test(line)) continue;

      const pm = line.match(/\$\s*([\d,]+(?:\.\d+)?(?:K|M)?)/i);
      if (!pm) continue;

      let priceStr = pm[1].replace(/[\$,]/g, "").toLowerCase();
      let price = parseFloat(priceStr);
      if (priceStr.includes("m") && !priceStr.includes(".") && price < 1000) price = price * 1000000;
      else if (priceStr.includes("k")) price = price * 1000;
      if (isNaN(price) || price > 10000000 || price < 50000) continue;

      const ctxStart = Math.max(0, i - 3);
      const ctxEnd = Math.min(lines.length, i + 5);
      const key = String(price) + lines.slice(ctxStart, ctxEnd).join(" ").substring(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);

      let bedrooms = 3, bathrooms = 2, sqft = 0, address = "";
      const contextLines = lines.slice(Math.max(0, i - 6), Math.min(lines.length, i + 8));
      const context = contextLines.join(" ");

      const isStudio = /\bstudio\b/i.test(context);
      const bedMatch = context.match(/(\d+)\s*(?:bd|bed|beds)\b|\b(\d+)\s*br\b/i);
      const bathMatch = context.match(/(\d[\d.]*)\+?\s*(?:ba|bath|baths)\b/i);
      const sqftMatch = context.match(/([\d,]+)\s*(?:sqft|square feet)/i);

      if (isStudio) { bedrooms = 1; bathrooms = 1; }
      else if (bedMatch) { bedrooms = parseInt(bedMatch[1] || bedMatch[2]) || 3; }
      if (bathMatch) { bathrooms = parseInt(bathMatch[1]) || 2; }
      if (sqftMatch) sqft = parseInt(sqftMatch[1].replace(/,/g, "")) || 0;

      for (const l of contextLines) {
        if (!l || l.length < 5 || l.length > 120) continue;
        if (/^\$|^- |^\[|^From|^built|^brokered|^open|^pending|^new|^house|^condo|^town|^email|^contact|^property|^agent/i.test(l)) continue;
        if (/^\d+\s+\w/.test(l) || /,\s*(WA|NY|CA|TX|FL|IL|MA|CO|OR|PA|DC|TN|GA|AZ|MI|NC|OH|MN|MO|MD|IN|WI|VA)\s/i.test(l)) {
          address = l.replace(/[,.]$/, "").replace(/\\+$/g, "").trim();
          break;
        }
      }

      const title = address || (criteria.location ? "Home in " + criteria.location : "Property $" + price.toLocaleString());
      id++;
      props.push({
        id: "fc" + id,
        title: title.substring(0, 80), price, bedrooms, bathrooms, sqft,
        location: criteria.location || "",
        features: [], url: "", imageUrl: "",
        listedAt: new Date().toISOString(),
        source: "Realtor.com",
      });
      if (props.length >= this.maxResults) break;
    }

    if (props.length > 0) {
      const filteredProps = props.filter((p: any) => {
        if (criteria.minBedrooms && p.bedrooms < criteria.minBedrooms) return false;
        if (criteria.minBathrooms && p.bathrooms < criteria.minBathrooms) return false;
        if (criteria.maxPrice && p.price > criteria.maxPrice) return false;
        if (criteria.minPrice && p.price < criteria.minPrice) return false;
        return true;
      });
      console.log(`[FirecrawlSkill] Page yielded ${props.length} total, filtered down to ${filteredProps.length} matching properties.`);
      return filteredProps;
    }

    return [];
  }

  private demoDB: Property[] = [
    { id: "d1", title: "Modern 3BR Townhouse with Pool", price: 850000, bedrooms: 3, bathrooms: 2, sqft: 1800, location: "Seattle, WA", features: ["pool","garage","hardwood floors"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d2", title: "Luxury Waterfront 4BR Estate", price: 1250000, bedrooms: 4, bathrooms: 3, sqft: 2800, location: "Seattle, WA", features: ["water view","garage","balcony","pool","fireplace"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d3", title: "Cozy 2BR Downtown Apartment", price: 550000, bedrooms: 2, bathrooms: 1, sqft: 950, location: "Seattle, WA", features: ["balcony","gym","in-unit laundry","view"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d4", title: "Charming 3BR Craftsman with Garden", price: 720000, bedrooms: 3, bathrooms: 2, sqft: 1600, location: "Seattle, WA", features: ["garden","fireplace","garage","hardwood floors"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d5", title: "New 2BR Luxury Condo with Views", price: 620000, bedrooms: 2, bathrooms: 2, sqft: 1100, location: "Bellevue, WA", features: ["view","parking","pool","gym"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d6", title: "Spacious 4BR Family Home", price: 980000, bedrooms: 4, bathrooms: 3, sqft: 2500, location: "Bellevue, WA", features: ["garage","yard","air conditioning","fireplace","hardwood floors"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d7", title: "Studio NYC Midtown High-Rise", price: 480000, bedrooms: 1, bathrooms: 1, sqft: 500, location: "New York, NY", features: ["gym","doorman","view"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d8", title: "2BR Brooklyn Loft with Natural Light", price: 750000, bedrooms: 2, bathrooms: 1, sqft: 900, location: "New York, NY", features: ["balcony","laundry","natural light","hardwood floors"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d9", title: "3BR San Francisco Victorian Home", price: 1500000, bedrooms: 3, bathrooms: 2, sqft: 1900, location: "San Francisco, CA", features: ["fireplace","garden","garage","hardwood floors","natural light"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d10", title: "Modern 2BR LA Apartment with Pool", price: 680000, bedrooms: 2, bathrooms: 2, sqft: 1050, location: "Los Angeles, CA", features: ["pool","gym","parking","view","balcony"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d11", title: "Luxury Penthouse Miami Beach", price: 2200000, bedrooms: 4, bathrooms: 4, sqft: 3200, location: "Miami, FL", features: ["pool","view","balcony","parking","gym","doorman"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d12", title: "3BR Austin Hill Country Home", price: 580000, bedrooms: 3, bathrooms: 2, sqft: 1700, location: "Austin, TX", features: ["yard","garage","fireplace","air conditioning","hardwood floors"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d13", title: "4BR Denver Mountain View", price: 820000, bedrooms: 4, bathrooms: 3, sqft: 2200, location: "Denver, CO", features: ["view","fireplace","garage","yard"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d14", title: "2BR Chicago Luxury Condo", price: 450000, bedrooms: 2, bathrooms: 2, sqft: 1000, location: "Chicago, IL", features: ["gym","doorman","view","parking"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d15", title: "3BR Boston Brownstone", price: 1100000, bedrooms: 3, bathrooms: 2, sqft: 1800, location: "Boston, MA", features: ["fireplace","hardwood floors","garden","natural light"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d16", title: "Beachfront 3BR House Seattle", price: 950000, bedrooms: 3, bathrooms: 2, sqft: 2000, location: "Seattle, WA", features: ["view","garage","deck","fireplace"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d17", title: "Bellevue 2BR Condo with View", price: 650000, bedrooms: 2, bathrooms: 2, sqft: 1050, location: "Bellevue, WA", features: ["pool","balcony","gym","parking"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d18", title: "Redmond 3BR Family Home", price: 880000, bedrooms: 3, bathrooms: 2, sqft: 1500, location: "Redmond, WA", features: ["yard","garage","fireplace","hardwood floors"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d19", title: "Kirkland 2BR Condo", price: 420000, bedrooms: 2, bathrooms: 1, sqft: 800, location: "Kirkland, WA", features: ["parking","gym","balcony"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d20", title: "Manhattan 1BR Condo", price: 380000, bedrooms: 1, bathrooms: 1, sqft: 650, location: "New York, NY", features: ["doorman","gym","pool"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d21", title: "Washington 3BR Single Family Home", price: 780000, bedrooms: 3, bathrooms: 2, sqft: 1600, location: "Washington, DC", features: ["garage","yard","fireplace","central ac"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d22", title: "SP 3BR Victorian Style", price: 1600000, bedrooms: 3, bathrooms: 2, sqft: 2100, location: "San Francisco, CA", features: ["fireplace","hardwood floors","garden","garage","natural light"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d23", title: "LA 2BR Modern Apartment", price: 640000, bedrooms: 2, bathrooms: 2, sqft: 1100, location: "Los Angeles, CA", features: ["pool","balcony","ocean view"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d24", title: "Miami 2BR Waterfront Condo", price: 750000, bedrooms: 2, bathrooms: 2, sqft: 1200, location: "Miami, FL", features: ["pool","balcony","view"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d25", title: "Denver 2BR Townhome", price: 520000, bedrooms: 2, bathrooms: 2, sqft: 1000, location: "Denver, CO", features: ["fireplace","garden","parking"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d26", title: "Austin 2BR View Home", price: 480000, bedrooms: 2, bathrooms: 1, sqft: 900, location: "Austin, TX", features: ["yard","pool","garage"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d27", title: "Boston 2BR Studio Backbay", price: 700000, bedrooms: 2, bathrooms: 1, sqft: 750, location: "Boston, MA", features: ["parking","laundry","gym"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d28", title: "Chicago 4BR Brownstone", price: 850000, bedrooms: 4, bathrooms: 2, sqft: 2200, location: "Chicago, IL", features: ["fireplace","hardwood floors","garage","basement"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d29", title: "Philadelphia 2BR Historic", price: 550000, bedrooms: 2, bathrooms: 1, sqft: 950, location: "Philadelphia, PA", features: ["fireplace","natural light","parking"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d30", title: "Portland 3BR Craftsman", price: 450000, bedrooms: 3, bathrooms: 2, sqft: 1400, location: "Portland, OR", features: ["natural light","yard","basement"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d31", title: "Dallas 3BR Suburban Home", price: 380000, bedrooms: 3, bathrooms: 2, sqft: 1500, location: "Dallas, TX", features: ["yard","pool","garage","central ac"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d32", title: "Denver 3BR Townhome", price: 700000, bedrooms: 3, bathrooms: 3, sqft: 1800, location: "Denver, CO", features: ["fireplace","pool","parking","natural light"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d33", title: "NYC 2BR Tribeca Style", price: 500000, bedrooms: 2, bathrooms: 1, sqft: 900, location: "New York, NY", features: ["laundry","nursery","central ac"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d34", title: "Austin 2BR Modern Condo", price: 450000, bedrooms: 2, bathrooms: 2, sqft: 1000, location: "Austin, TX", features: ["pool","gym","parking"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d35", title: "Santa Monica 3BR House", price: 800000, bedrooms: 3, bathrooms: 2, sqft: 1700, location: "Santa Monica, CA", features: ["ocean view","garage","pool","yard"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d36", title: "Nashville 4BR Colonial", price: 720000, bedrooms: 4, bathrooms: 3, sqft: 2500, location: "Nashville, TN", features: ["yard","garage","fireplace","central ac"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d37", title: "Salem 3BR Historic View", price: 500000, bedrooms: 3, bathrooms: 2, sqft: 1500, location: "Salem, OR", features: ["view","natural light","yard"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d38", title: "Orlando 2BR Modern Condo", price: 350000, bedrooms: 2, bathrooms: 1, sqft: 850, location: "Orlando, FL", features: ["pool","gym","parking"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d39", title: "Long Beach 3BR Living", price: 500000, bedrooms: 3, bathrooms: 2, sqft: 1200, location: "Long Beach, CA", features: ["yard","pool","garage"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d40", title: "Sacramento 4BR Modern Home", price: 620000, bedrooms: 4, bathrooms: 3, sqft: 2000, location: "Sacramento, CA", features: ["yard","pool","fireplace","air conditioning"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d41", title: "Atlanta 3BR Craftsman Style", price: 400000, bedrooms: 3, bathrooms: 2, sqft: 1600, location: "Atlanta, GA", features: ["yard","garage","fireplace","natural light"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d42", title: "Houston 4BR Modern Home", price: 450000, bedrooms: 4, bathrooms: 3, sqft: 2400, location: "Houston, TX", features: ["pool","garage","yard","fireplace","central ac"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d43", title: "Phoenix 3BR Desert View", price: 380000, bedrooms: 3, bathrooms: 2, sqft: 1700, location: "Phoenix, AZ", features: ["pool","view","garage","fireplace"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d44", title: "San Diego 2BR Beach Condo", price: 600000, bedrooms: 2, bathrooms: 2, sqft: 950, location: "San Diego, CA", features: ["ocean view","balcony","pool","gym"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d45", title: "Detroit 3BR Historic Home", price: 250000, bedrooms: 3, bathrooms: 2, sqft: 1800, location: "Detroit, MI", features: ["fireplace","hardwood floors","garden","basement"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d46", title: "NYC 3BR Upper West Side Apt", price: 925000, bedrooms: 3, bathrooms: 2, sqft: 1400, location: "New York, NY", features: ["doorman","gym","laundry","view"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d47", title: "NYC 3BR Brooklyn Townhouse", price: 850000, bedrooms: 3, bathrooms: 2, sqft: 1600, location: "New York, NY", features: ["garden","fireplace","hardwood floors","natural light"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d48", title: "NYC 3BR Queens Family Home", price: 720000, bedrooms: 3, bathrooms: 2, sqft: 1500, location: "New York, NY", features: ["yard","garage","basement","central ac"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d49", title: "Athens 3BR Craftsman Near UGA", price: 380000, bedrooms: 3, bathrooms: 2, sqft: 1700, location: "Athens, GA", features: ["hardwood floors","fireplace","yard","garage","natural light"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d50", title: "Athens 4BR Colonial Milledge", price: 550000, bedrooms: 4, bathrooms: 3, sqft: 2400, location: "Athens, GA", features: ["yard","garage","fireplace","hardwood floors","central ac"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d51", title: "New York 4BR Historic Townhouse", price: 2100000, bedrooms: 4, bathrooms: 3, sqft: 2800, location: "New York, NY", features: ["yard","garage","fireplace"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d52", title: "Brooklyn 4BR Family Home", price: 1250000, bedrooms: 4, bathrooms: 3, sqft: 2200, location: "New York, NY", features: ["garden","hardwood floors"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d53", title: "Queens 4BR Single Family", price: 950000, bedrooms: 4, bathrooms: 2, sqft: 1800, location: "New York, NY", features: ["garage","yard"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" }
  ];

  private demoSearch(criteria: SearchCriteria): Property[] {
    return this.demoDB.filter((p: any) => {
      if (criteria.location) {
        // Strip price/noise words from criteria location before matching
        const cleanLoc = criteria.location.replace(/\s+(priced|under|over|budget|max|min|million|thousand|k|dollars?).*$/i, "").trim().toLowerCase();
        // Use word-boundary matching: match "new york" in "New York, NY" or "new-york"
        const pLoc = p.location.toLowerCase();
        const locWords = cleanLoc.split(/[\s,]+/).filter(w => w.length > 0);
        const matchAll = locWords.every(word => pLoc.includes(word));
        if (!matchAll) return false;
      }
      if (criteria.minPrice && p.price < criteria.minPrice) return false;
      if (criteria.maxPrice && p.price > criteria.maxPrice) return false;
      if (criteria.minBedrooms && p.bedrooms < criteria.minBedrooms) return false;
      if (criteria.minBathrooms && p.bathrooms < criteria.minBathrooms) return false;
      if (criteria.mustHave && criteria.mustHave.length > 0) {
        for (const f of criteria.mustHave) {
          if (!p.features.some((pf: any) => pf.toLowerCase().includes(f.toLowerCase()))) return false;
        }
      }
      return true;
    });
  }
}

export const firecrawlSkill = new FirecrawlSkill();
