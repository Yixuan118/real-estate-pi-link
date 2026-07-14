
import { SearchCriteria, Property } from "../core/types";
import { firecrawlSkill } from "../skills/firecrawl-skill";
import * as store from "../core/store";

// ─── Watcher Agent ───
// Inspired by pi-collaborating-agents' background monitoring pattern.
// Runs at configured intervals to check for new matching properties.
// Implements a lightweight cron-based scheduler.

export class WatcherAgent {
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private _active: boolean = false;

  get active(): boolean { return this._active; }

  /**
   * Start monitoring a session for new properties.
   * @param sessionId The session to monitor
   * @param intervalMs How often to check (default: 1 hour)
   * @param onChange Callback when new properties are found
   */
  startMonitoring(
    sessionId: string,
    intervalMs: number = 3600000,
    onChange?: (sessionId: string, newProperties: Property[]) => void,
  ): void {
    if (this.timers.has(sessionId)) {
      console.log(`[WatcherAgent] Already monitoring session ${sessionId}`);
      return;
    }

    this._active = true;
    console.log(`[WatcherAgent] Started monitoring session ${sessionId} every ${intervalMs}ms`);

    const timer = setInterval(async () => {
      try {
        const session = store.loadSession(sessionId);
        if (!session) {
          console.log(`[WatcherAgent] Session ${sessionId} no longer exists, stopping`);
          this.stopMonitoring(sessionId);
          return;
        }

        const newProperties = await firecrawlSkill.checkForNewProperties(session.criteria);

        if (newProperties.length > 0) {
          console.log(`[WatcherAgent] Found ${newProperties.length} new properties for session ${sessionId}`);

          // Store new properties
          for (const prop of newProperties) {
            store.saveMatchedProperty(sessionId, prop);
          }

          // Update last check time
          session.lastCheckAt = new Date().toISOString();
          store.saveSession(session);

          // Notify via callback
          onChange?.(sessionId, newProperties);
        } else {
          session.lastCheckAt = new Date().toISOString();
          store.saveSession(session);
        }
      } catch (err) {
        console.error(`[WatcherAgent] Error monitoring session ${sessionId}:`, err);
      }
    }, intervalMs);

    this.timers.set(sessionId, timer);
  }

  /**
   * Stop monitoring a session.
   */
  stopMonitoring(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(sessionId);
      console.log(`[WatcherAgent] Stopped monitoring session ${sessionId}`);
    }
    if (this.timers.size === 0) {
      this._active = false;
    }
  }

  /**
   * Check if a session is being monitored.
   */
  isMonitoring(sessionId: string): boolean {
    return this.timers.has(sessionId);
  }

  /**
   * Get all monitored sessions.
   */
  getMonitoredSessions(): string[] {
    return [...this.timers.keys()];
  }

  /**
   * Clean up all timers.
   */
  shutdown(): void {
    for (const [sessionId, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    this._active = false;
    console.log("[WatcherAgent] Shutdown complete");
  }
}

// Singleton for use by orchestrator
export const watcherAgent = new WatcherAgent();
