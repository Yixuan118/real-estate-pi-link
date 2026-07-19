import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface CacheRecord<T> {
  expiresAt: number;
  value: T;
}

export class PersistentJsonCache<T> {
  private readonly records = new Map<string, CacheRecord<T>>();

  constructor(private readonly filePath: string) {
    if (!filePath) return;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, CacheRecord<T>>;
      for (const [key, record] of Object.entries(parsed || {})) {
        if (record?.expiresAt > Date.now()) this.records.set(key, record);
      }
    } catch {
      // A missing or stale cache is expected on first run.
    }
  }

  get(key: string): T | undefined {
    const record = this.records.get(key);
    if (!record) return undefined;
    if (record.expiresAt <= Date.now()) {
      this.records.delete(key);
      return undefined;
    }
    return record.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.records.set(key, { expiresAt: Date.now() + ttlMs, value });
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const output = Object.fromEntries(this.records);
      writeFileSync(this.filePath, JSON.stringify(output, null, 2), "utf8");
    } catch (error) {
      console.warn("[PersistentJsonCache] Cannot save cache:", error instanceof Error ? error.message : String(error));
    }
  }
}

export function defaultCacheFile(name: string): string {
  const storage = process.env.RE_STORAGE_DIR || resolve(process.cwd(), ".real-estate-store");
  return resolve(storage, "cache", name);
}
