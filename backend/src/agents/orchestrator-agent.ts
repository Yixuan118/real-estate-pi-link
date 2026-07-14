
import { SearchCriteria, Property, ConversationEntry, UserSession } from "../core/types";
import { MemoryAgent, createMemorySession } from "./memory-agent";
import { scraperAgent } from "./scraper-agent";
import { watcherAgent } from "./watcher-agent";
import * as store from "../core/store";
import { piRuntimeService } from "../runtime/pi-runtime-service";

// 鈹€鈹€鈹€ Orchestrator Agent 鈹€鈹€鈹€
// Inspired by pi-collaborating-agents' main orchestrator pattern.
// Coordinates memory, scraper, and watcher subagents.
// Routes user input to the right agent, streams activity to the frontend.

export class OrchestratorAgent {
  private memoryAgent: MemoryAgent | null = null;
  private sessionId: string = "";
  private userId: string = "";
  private _initialized: boolean = false;
  private activityListeners: Array<(agentName: string, action: string, detail: string) => void> = [];

  get initialized(): boolean { return this._initialized; }
  get currentSessionId(): string { return this.sessionId; }

  /**
   * Initialize a new session for a user.
   * Similar to pi-collaborating-agents' subagent spawning 鈥?creates dedicated agents.
   */
  async initialize(userId: string): Promise<UserSession> {
    this.userId = userId;
    store.registerAgent("orchestrator", "orchestrator", process.pid);

    // Spawn memory subagent (pi-collaborating-agents pattern)
    this.emitActivity("Orchestrator", "spawn", "Spawning Memory Agent...");
    const { session, agent } = createMemorySession(userId);
    this.sessionId = session.id;
    this.memoryAgent = agent;

    // Register scraper skill availability
    store.registerAgent("scraper", "scraper", process.pid);
    this.emitActivity("Orchestrator", "ready", "Memory Agent ready, Scraper Agent available");

    this._initialized = true;
    return session;
  }

  /**
   * Resume an existing session.
   */
  async resume(sessionId: string): Promise<UserSession | null> {
    const session = store.loadSession(sessionId);
    if (!session) return null;
    this.sessionId = sessionId;
    this.userId = session.userId;
    this.memoryAgent = new MemoryAgent(sessionId);
    this._initialized = true;

    store.registerAgent("orchestrator", "orchestrator", process.pid);
    store.registerAgent("memory", "memory", process.pid);
    store.registerAgent("scraper", "scraper", process.pid);

    this.emitActivity("Orchestrator", "resume", `Resumed session for ${session.userId}`);
    return session;
  }

  /**
   * Handle a user message end-to-end:
   * 1. MemoryAgent extracts criteria from natural language
   * 2. ScraperAgent searches for matching properties
   * 3. WatcherAgent starts background monitoring
   * 4. Returns results with activity log
   */
  async handleUserMessage(userMessage: string): Promise<{
    response: string;
    updatedCriteria: SearchCriteria;
    properties: Property[];
    conversation: ConversationEntry[];
    activityLog: Array<{ agent: string; action: string; detail: string }>;
  }> {
    let collaborativeMode: string | false = false;
    let cleanMessage = userMessage.trim();
    const lower = cleanMessage.toLowerCase();

    if (lower.startsWith("/collab-agent-scrape")) {
      collaborativeMode = "agent-scrape";
      cleanMessage = cleanMessage.replace(/^\/collab-agent-scrape\s*/i, "");
    }

    const activityLog: Array<{ agent: string; action: string; detail: string }> = [];
    const logActivity = (agent: string, action: string, detail: string) => {
      activityLog.push({ agent, action, detail });
      this.emitActivity(agent, action, detail);
    };

    logActivity("OrchestratorAgent", "mode", "resolved: " + (collaborativeMode || "normal"));

    if (!this.memoryAgent) {
      throw new Error("Orchestrator not initialized. Call initialize() first.");
    }

    // Step 1: Memory Agent processes the message (NL to criteria)
    logActivity("MemoryAgent", "busy", "analyzing user input...");
    const { updatedCriteria, response, conversationHistory } = await this.memoryAgent.processMessage(cleanMessage);

    // Sanitize: strip price-related noise from location field
    if (updatedCriteria.location) {
      const cleaned = updatedCriteria.location.replace(/\s+(priced|under|over|budget|max|min|million|thousand|k|dollars?)\b.*$/i, "").trim();
      if (cleaned !== updatedCriteria.location) {
        logActivity("MemoryAgent", "sanitize", `location '${updatedCriteria.location}' 鈫?'${cleaned}'`);
        updatedCriteria.location = cleaned;
      }
    }

    logActivity("MemoryAgent", "done", "updated preferences: " + JSON.stringify(updatedCriteria));

    // Step 2: Scraper Agent searches for matching properties (skip for agent-scrape - PiRuntime handles scraping + analysis)
    let properties: Property[] = [];
    let sourceLabel = "realtor.com (via Firecrawl)";
    if (collaborativeMode !== "agent-scrape") {
      logActivity("ScraperAgent", "busy", "searching matching properties...");
      const result = await scraperAgent.search(updatedCriteria, (progress) => {
        logActivity("ScraperAgent", "progress", progress);
      });
      properties = result.properties;
      sourceLabel = result.totalCount > 0 ? result.properties[0]?.source || "realtor.com" : "none";
      logActivity("ScraperAgent", "done", "found " + properties.length + " matching properties");
    } else {
      logActivity("ScraperAgent", "skipped", "agent-scrape mode: PiRuntime will scrape + analyze together");
    }

    // Step 3: Store matched properties
    for (const prop of properties) {
      store.saveMatchedProperty(this.sessionId, prop);
    }

    let finalResponse = response;
    let finalProperties = properties;

    // Step 4: Collaborative mode -- call Pi collaborating agents for validation/ranking/summary
    if (collaborativeMode) {
      try {
        logActivity("PiRuntime", "busy", "Calling Pi collaborating agents for collaborative analysis...");

        const piResult = await piRuntimeService.analyze({
          userMessage: cleanMessage,
          criteria: updatedCriteria,
          properties,
          mode: collaborativeMode || undefined,
        });

        for (const item of piResult.agent_activity) {
          logActivity(item.agent, item.action, item.detail);
        }

        if (piResult.ranked_property_ids.length > 0) {
          const rank = new Map(
            piResult.ranked_property_ids.map((id, index) => [id, index]),
          );
          finalProperties = [...properties].sort((a: any, b: any) => {
            const aRank = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
            const bRank = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
            return aRank - bRank;
          });
        }

        finalResponse = piResult.assistant_message;

        if (piResult.warnings.length > 0) {
          logActivity("PiRuntime", "warnings", piResult.warnings.join("; "));
        }

        // For agent-scrape mode: use properties scraped by PiRuntime internally
        if (piResult.properties && piResult.properties.length > 0) {
          finalProperties = piResult.properties;
          logActivity("PiRuntime", "properties", "received " + finalProperties.length + " scraped properties");
          // Save to store for frontend display
          for (const prop of finalProperties) {
            store.saveMatchedProperty(this.sessionId, prop);
          }
        }

        logActivity("PiRuntime", "done", "Pi collaborating agents analysis complete");
      } catch (err) {
        logActivity(
          "PiRuntime",
          "fallback",
          "Pi collaboration failed, falling back to normal results: " +
            (err instanceof Error ? err.message : String(err)),
        );
        // For agent-scrape mode: fall back to enhanced scraper when PiRuntime is unavailable
        if (collaborativeMode === "agent-scrape") {
          try {
            logActivity("ScraperAgent", "busy", "fallback: scraping enhanced data...");
            const fb = await scraperAgent.search(updatedCriteria, (p) => {
              logActivity("ScraperAgent", "progress", p);
            });
            if (fb.properties.length > 0) {
              finalProperties = fb.properties;
              for (const prop of finalProperties) store.saveMatchedProperty(this.sessionId, prop);
              logActivity("ScraperAgent", "done", "fallback found " + finalProperties.length + " properties");
            }
          } catch (sb) {
            logActivity("ScraperAgent", "error", "fallback scrape failed: " + (sb instanceof Error ? sb.message : String(sb)));
          }
        }
      }
    }

    // Step 5: Start watcher (if location is set)
    if (updatedCriteria.location && !watcherAgent.isMonitoring(this.sessionId)) {
      logActivity("WatcherAgent", "start", "starting background monitoring...");
      watcherAgent.startMonitoring(
        this.sessionId,
        3600000,
        (sid, newProps) => {
          this.emitActivity("WatcherAgent", "new-properties", "found " + newProps.length + " new properties");
        },
      );
      logActivity("WatcherAgent", "active", "background monitoring activated");
    }

    return {
      response: finalResponse,
      updatedCriteria,
      properties: finalProperties,
      conversation: conversationHistory,
      activityLog,
    };
  }
  /**
   * Subscribe to activity updates (for WebSocket streaming).
   */
  onActivity(listener: (agentName: string, action: string, detail: string) => void): () => void {
    this.activityListeners.push(listener);
    return () => {
      this.activityListeners = this.activityListeners.filter((l) => l !== listener);
    };
  }

  private emitActivity(agentName: string, action: string, detail: string): void {
    for (const listener of this.activityListeners) {
      listener(agentName, action, detail);
    }
  }

  /**
   * Get current session data.
   */
  getSessionData(): UserSession | null {
    return store.loadSession(this.sessionId);
  }

  /**
   * Clean up 鈥?mirrors pi-collaborating-agents' session_shutdown handler.
   */
  shutdown(): void {
    store.unregisterAgent("orchestrator");
    store.unregisterAgent("scraper");
    store.unregisterAgent("memory");
    this.activityListeners = [];
    this.memoryAgent = null;
    this._initialized = false;
    this.emitActivity("Orchestrator", "shutdown", "Agent system shutting down");
  }
}

// build: 2026-07-09 15:43:32
