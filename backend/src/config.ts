export interface AppConfig {
  port: number;
  wsPort: number;
  storageDir: string;
  llmApiKey: string;
  llmModel: string;
  firecrawlApiKey: string;
  monitoringIntervalMs: number;
}

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || "3000", 10),
    wsPort: parseInt(process.env.WS_PORT || process.env.PORT || "3742", 10),
    storageDir: process.env.RE_STORAGE_DIR || "",
    llmApiKey: process.env.OPENAI_API_KEY || process.env.RE_LLM_KEY || process.env.DEEPSEEK_API_KEY || "",
    llmModel: process.env.RE_LLM_MODEL || "deepseek-chat",
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY || "",
    monitoringIntervalMs: parseInt(process.env.RE_MONITOR_INTERVAL || "3600000", 10),
  };
}
