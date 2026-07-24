export interface AppConfig {
  port: number;
  wsPort: number;
  storageDir: string;
  llmApiKey: string;
  llmModel: string;
  firecrawlApiKey: string;
  googleMapsApiKey: string;
  hereApiKey: string;
  mapProvider: "here" | "google" | "auto";
  geoDistanceMode: "STRAIGHT_LINE" | "DRIVE";
  monitoringIntervalMs: number;
}

export const DEFAULT_LLM_MODEL = "deepseek-v4-flash";

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || "3000", 10),
    wsPort: parseInt(process.env.WS_PORT || process.env.PORT || "3742", 10),
    storageDir: process.env.RE_STORAGE_DIR || "",
    llmApiKey: process.env.OPENAI_API_KEY || process.env.RE_LLM_KEY || process.env.DEEPSEEK_API_KEY || "",
    llmModel: process.env.RE_LLM_MODEL || DEFAULT_LLM_MODEL,
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY || "",
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || "",
    hereApiKey: process.env.HERE_API_KEY || "",
    mapProvider: ["here", "google"].includes((process.env.RE_MAP_PROVIDER || "").toLowerCase())
      ? (process.env.RE_MAP_PROVIDER!.toLowerCase() as "here" | "google") : "auto",
    geoDistanceMode: (process.env.RE_GEO_DISTANCE_MODE || process.env.GEO_DISTANCE_MODE || "STRAIGHT_LINE").toUpperCase() === "DRIVE" ? "DRIVE" : "STRAIGHT_LINE",
    monitoringIntervalMs: parseInt(process.env.RE_MONITOR_INTERVAL || "3600000", 10),
  };
}
