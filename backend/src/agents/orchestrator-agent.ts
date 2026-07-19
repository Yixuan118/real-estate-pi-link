
import { SearchCriteria, Property, ConversationEntry, UserSession } from "../core/types";
import { MemoryAgent, createMemorySession } from "./memory-agent";
import { watcherAgent } from "./watcher-agent";
import * as store from "../core/store";
import { piRuntimeService } from "../runtime/pi-runtime-service";
import { buildComplexSearchReport } from "../core/complex-search-report";

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

    this.emitActivity("Orchestrator", "ready", "Memory Agent and Pi collaborating agents ready");

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
    this.emitActivity("Orchestrator", "resume", `Resumed session for ${session.userId}`);
    return session;
  }

  /**
   * Handle a user message end-to-end:
   * 1. MemoryAgent extracts criteria from natural language
   * 2. PiRuntime performs integrated listing research and collaboration
   * 3. WatcherAgent optionally starts background monitoring
   * 4. Returns evidence-ranked results with activity log
   */
  async handleUserMessage(userMessage: string): Promise<{
    response: string;
    updatedCriteria: SearchCriteria;
    properties: Property[];
    conversation: ConversationEntry[];
    activityLog: Array<{ agent: string; action: string; detail: string }>;
  }> {
    const cleanMessage = userMessage.trim().replace(/^\/(?:collab-agent-scrape|collab-full|collab)\s*/i, "");

    const activityLog: Array<{ agent: string; action: string; detail: string }> = [];
    const logActivity = (agent: string, action: string, detail: string) => {
      activityLog.push({ agent, action, detail });
      this.emitActivity(agent, action, detail);
    };

    logActivity("OrchestratorAgent", "mode", "Pi collaborating agents");

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

    // PiRuntime owns both listing research and collaborative analysis. There is
    // intentionally no standalone/basic scraper path.
    const properties: Property[] = [];
    logActivity("PiRuntime", "research", "Researching listings and coordinating evidence analysis...");

    let finalResponse = response;
    let finalProperties = properties;
    let collaborativeDataError = "";

    const hasComplexCriteria = Boolean(updatedCriteria.mustHave?.length || updatedCriteria.exteriorMaterials?.length
      || updatedCriteria.communityFeatures?.length || updatedCriteria.distanceConstraints?.length
      || updatedCriteria.highwayAccess || updatedCriteria.schoolMinRating != null || updatedCriteria.schoolAtLeastOneRating != null);
    // Step 4: Pi collaborating agents validate, rank, and summarize.
    {
      try {
        logActivity("PiRuntime", "busy", "Calling Pi collaborating agents for collaborative analysis...");

        const piResult = await piRuntimeService.analyze({
          userMessage: cleanMessage,
          criteria: updatedCriteria,
          properties,
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
        collaborativeDataError = piResult.data_error || "";

        if (piResult.warnings.length > 0) {
          logActivity("PiRuntime", "warnings", piResult.warnings.join("; "));
        }

        // For agent-scrape mode: use properties scraped by PiRuntime internally
        if (piResult.properties && piResult.properties.length > 0) {
          finalProperties = piResult.properties;
          if (piResult.ranked_property_ids.length > 0) {
            const rank = new Map(piResult.ranked_property_ids.map((id, index) => [id, index]));
            finalProperties = [...finalProperties].sort((a, b) =>
              (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
          }
          logActivity("PiRuntime", "properties", "received " + finalProperties.length + " scraped properties");
          // Save to store for frontend display
          for (const prop of finalProperties) {
            store.saveMatchedProperty(this.sessionId, prop);
          }
        }

        logActivity("PiRuntime", "done", "Pi collaborating agents analysis complete");
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        collaborativeDataError = detail;
        finalProperties = [];
        finalResponse = `Pi collaborating agents could not complete this search: ${detail}`;
        logActivity("PiRuntime", "error", finalResponse);
      }
    }

    if (hasComplexCriteria && !collaborativeDataError) {
      finalResponse = buildComplexSearchReport(updatedCriteria, finalProperties);
      const diagnostics = finalProperties.flatMap((property) => (property.evidenceDiagnostics || [])
        .filter((item) => item.status !== "success")
        .map((item) => `${property.id}/${item.stage}: ${item.detail}`));
      if (diagnostics.length > 0) logActivity("EvidenceValidator", "warnings", diagnostics.slice(0, 10).join("; "));
    }

    // Monitoring is opt-in because every interval performs an external listing
    // request. Automatically starting one timer per chat caused silent credit use.
    const watcherEnabled = /^(?:1|true|yes)$/i.test(process.env.RE_WATCHER_ENABLED || "");
    if (watcherEnabled && updatedCriteria.location && !watcherAgent.isMonitoring(this.sessionId)) {
      logActivity("WatcherAgent", "start", "starting background monitoring...");
      watcherAgent.startMonitoring(
        this.sessionId,
        3600000,
        (sid, newProps) => {
          this.emitActivity("WatcherAgent", "new-properties", "found " + newProps.length + " new properties");
        },
      );
      logActivity("WatcherAgent", "active", "background monitoring activated");
    } else if (!watcherEnabled && updatedCriteria.location) {
      logActivity("WatcherAgent", "disabled", "background monitoring is opt-in and disabled to control API cost");
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
    store.unregisterAgent("memory");
    this.activityListeners = [];
    this.memoryAgent = null;
    this._initialized = false;
    this.emitActivity("Orchestrator", "shutdown", "Agent system shutting down");
  }
}

// build: 2026-07-09 15:43:32
