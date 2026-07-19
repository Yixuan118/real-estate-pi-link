import { WebSocketBridge } from "./bridge/websocket-server";
import { loadConfig } from "./config";
import * as store from "./core/store";

const config = loadConfig();

if (config.mapProvider === "here" && !config.hereApiKey) {
  throw new Error("RE_MAP_PROVIDER=here but HERE_API_KEY is missing. Start with npm run dev or start.ps1 -Dev so Windows user environment variables are loaded.");
}
if (config.mapProvider === "google" && !config.googleMapsApiKey) {
  throw new Error("RE_MAP_PROVIDER=google but GOOGLE_MAPS_API_KEY is missing.");
}

console.log("[Main] Backend starting...");
console.log("[Main] Storage: " + (config.storageDir || ".real-estate-store"));
console.log("[Main] LLM: " + config.llmModel + " (" + (config.llmApiKey ? "configured" : "fallback to regex") + ")");
console.log("[Main] Firecrawl: " + (config.firecrawlApiKey ? "configured" : "not configured (live Realtor search unavailable)"));
console.log("[Main] Google Maps: " + (config.googleMapsApiKey ? `configured (${config.geoDistanceMode})` : "not configured"));
console.log("[Main] HERE: " + (config.hereApiKey ? `configured (${config.geoDistanceMode})` : "not configured"));
console.log("[Main] Map provider: " + config.mapProvider);
console.log("[Main] Monitor interval: " + (config.monitoringIntervalMs / 1000) + "s");

store.registerAgent("system", "orchestrator", process.pid);

const bridge = new WebSocketBridge(config.wsPort);
bridge.start();

process.on("SIGINT", async () => {
  console.log("[Main] Shutting down...");
  store.unregisterAgent("system");
  await bridge.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[Main] Shutting down...");
  store.unregisterAgent("system");
  await bridge.stop();
  process.exit(0);
});

console.log("[Main] Backend ready. Frontend: open frontend/index.html");
console.log("[Main] WebSocket: ws://localhost:" + config.wsPort);
