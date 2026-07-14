
import { SearchCriteria, ConversationEntry, UserSession } from "../core/types";
import { extractCriteriaFromMessage } from "../core/llm-service";
import * as store from "../core/store";

// ─── Memory Agent ───
// Inspired by pi-collaborating-agents' memory subagent pattern.
// Manages user conversation history and dynamically updates search criteria
// based on natural language input. Uses the "file reservation" pattern
// (via atomic session writes) to ensure consistent state.

export class MemoryAgent {
  private sessionId: string;
  private _active: boolean = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  get active(): boolean { return this._active; }

  /**
   * Process a user message:
   * 1. Store it in conversation history
   * 2. Extract criteria updates using LLM or regex
   * 3. Persist updated criteria
   * 4. Return the updated criteria + response
   */
  async processMessage(userMessage: string): Promise<{
    updatedCriteria: SearchCriteria;
    response: string;
    conversationHistory: ConversationEntry[];
  }> {
    this._active = true;

    try {
      // Load current session
      let session = store.loadSession(this.sessionId);
      if (!session) {
        throw new Error(`Session ${this.sessionId} not found`);
      }

      // Add user message to conversation
      const userEntry: ConversationEntry = {
        role: "user",
        content: userMessage,
        timestamp: new Date().toISOString(),
      };
      store.appendConversation(this.sessionId, userEntry);
      session.conversation.push(userEntry);

      // Get conversation history for context
      const historyContext = session.conversation
        .filter((e) => e.role === "user" || e.role === "assistant")
        .slice(-10)
        .map((e) => `${e.role === "user" ? "User" : "Assistant"}: ${e.content}`);

      // Extract criteria update
      const { criteria: updatedCriteria, response } = await extractCriteriaFromMessage(
        session.criteria,
        userMessage,
        historyContext,
      );

      // Save updated criteria (atomic write = pi-collaborating-agents "file reservation" pattern)
      store.updateCriteria(this.sessionId, updatedCriteria);
      session.criteria = updatedCriteria;

      // Add assistant response to conversation
      const assistantEntry: ConversationEntry = {
        role: "assistant",
        content: response,
        timestamp: new Date().toISOString(),
      };
      store.appendConversation(this.sessionId, assistantEntry);
      session.conversation.push(assistantEntry);

      return {
        updatedCriteria,
        response,
        conversationHistory: session.conversation,
      };
    } finally {
      this._active = false;
    }
  }

  /**
   * Get the conversation history for context.
   */
  getHistory(): ConversationEntry[] {
    const session = store.loadSession(this.sessionId);
    return session?.conversation ?? [];
  }

  /**
   * Get the current search criteria.
   */
  getCurrentCriteria(): SearchCriteria | null {
    const session = store.loadSession(this.sessionId);
    return session?.criteria ?? null;
  }
}

/**
 * Factory function — creates a new user session and returns a MemoryAgent for it.
 * Mirrors pi-collaborating-agents' "spawn subagent" pattern.
 */
export function createMemorySession(userId: string): { session: UserSession; agent: MemoryAgent } {
  const session = store.loadSession(userId) || (() => {
    const s = { id: crypto.randomUUID(), userId, criteria: { location: undefined, maxPrice: undefined, minBedrooms: undefined, minBathrooms: undefined, propertyType: undefined, mustHave: [], updatedAt: new Date().toISOString() } as SearchCriteria, conversation: [], watchedProperties: [], matchedProperties: [], monitoringInterval: 3600000, lastCheckAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as UserSession;
    s.id = crypto.randomUUID();
    store.saveSession(s);
    return s;
  })();
  const agent = new MemoryAgent(session.id);
  return { session, agent };
}
