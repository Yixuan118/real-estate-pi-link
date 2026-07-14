import { WebSocketBridge } from "./bridge/websocket-server";
import { loadConfig } from "./config";
import * as store from "./core/store";

const config = loadConfig();

console.log("[Main] Backend starting...");
console.log("[Main] Storage: " + (config.storageDir || ".real-estate-store"));
console.log("[Main] LLM: " + config.llmModel + " (" + (config.llmApiKey ? "configured" : "fallback to regex") + ")");
console.log("[Main] Firecrawl: " + (config.firecrawlApiKey ? "configured" : "using mock data"));
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