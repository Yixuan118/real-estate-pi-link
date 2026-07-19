import { AsyncLocalStorage } from "node:async_hooks";

interface BudgetState {
  limit: number;
  used: number;
  requests: number;
  labels: string[];
}

class FirecrawlRequestBudget {
  private readonly storage = new AsyncLocalStorage<BudgetState>();

  run<T>(producer: () => Promise<T>, limit = Number(process.env.RE_FIRECRAWL_REQUEST_BUDGET || 15)): Promise<T> {
    const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 15, 100));
    return this.storage.run({ limit: safeLimit, used: 0, requests: 0, labels: [] }, producer);
  }

  consume(label: string): void {
    const state = this.storage.getStore();
    if (!state) return;
    if (state.used >= state.limit) {
      throw new Error(`Firecrawl request budget ${state.limit} reached; skipped ${label}.`);
    }
    state.used += 1;
    state.requests += 1;
    state.labels.push(label);
  }

  settle(label: string, creditsUsed: unknown): void {
    const state = this.storage.getStore();
    const actual = Number(creditsUsed);
    if (!state || !Number.isFinite(actual) || actual < 0) return;
    // consume() reserves one credit before the request. Reconcile that
    // reservation with Firecrawl's authoritative response value.
    state.used = Math.max(0, state.used + Math.ceil(actual) - 1);
    if (Math.ceil(actual) !== 1) state.labels.push(`${label} creditsUsed=${Math.ceil(actual)}`);
  }

  snapshot(): { limit: number; used: number; requests: number; labels: string[] } | null {
    const state = this.storage.getStore();
    return state ? { ...state, labels: [...state.labels] } : null;
  }
}

export const firecrawlRequestBudget = new FirecrawlRequestBudget();
