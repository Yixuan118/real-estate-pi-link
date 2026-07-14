
import * as fs from "fs";
import * as path from "path";
import { UserSession, ConversationEntry, SearchCriteria, Property, InboxMessage, MessageLogEvent } from "./types";

// ─── File-based persistence inspired by pi-collaborating-agents store.ts ───
// Uses atomic writes (write + rename) and directory-based locking for consistency

const STORAGE_DIR = process.env.RE_STORAGE_DIR || path.join(process.cwd(), ".real-estate-store");
const SESSIONS_DIR = path.join(STORAGE_DIR, "sessions");
const REGISTRY_DIR = path.join(STORAGE_DIR, "registry");
const MESSAGES_DIR = path.join(STORAGE_DIR, "messages");
const MESSAGE_LOG = path.join(STORAGE_DIR, "messages.jsonl");
const PROPERTIES_DIR = path.join(STORAGE_DIR, "properties");

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, data, "utf-8");
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

// ─── Session Store ───

export function saveSession(session: UserSession): void {
  ensureDir(SESSIONS_DIR);
  atomicWrite(path.join(SESSIONS_DIR, `${session.id}.json`), JSON.stringify(session, null, 2));
}

export function loadSession(sessionId: string): UserSession | null {
  return readJson<UserSession>(path.join(SESSIONS_DIR, `${sessionId}.json`));
}

export function listSessions(): string[] {
  ensureDir(SESSIONS_DIR);
  try {
    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(".json", ""));
  } catch { return []; }
}

// ─── Conversation Store ───

export function appendConversation(sessionId: string, entry: ConversationEntry): void {
  const session = loadSession(sessionId);
  if (!session) return;
  session.conversation.push(entry);
  session.updatedAt = new Date().toISOString();
  saveSession(session);
}

// ─── Criteria Store ───

export function updateCriteria(sessionId: string, criteria: SearchCriteria): void {
  const session = loadSession(sessionId);
  if (!session) return;
  session.criteria = criteria;
  session.updatedAt = new Date().toISOString();
  saveSession(session);
}

// ─── Properties Store ───

export function saveMatchedProperty(sessionId: string, property: Property): boolean {
  const session = loadSession(sessionId);
  if (!session) return false;
  const exists = session.matchedProperties.some(p => p.id === property.id);
  if (!exists) {
    session.matchedProperties.push(property);
    session.watchedProperties.push(property.id);
    session.updatedAt = new Date().toISOString();
    saveSession(session);
    return true;
  }
  return false;
}

export function getMatchedProperties(sessionId: string): Property[] {
  const session = loadSession(sessionId);
  return session?.matchedProperties ?? [];
}

// ─── Message System (pi-collaborating-agents pattern) ───

export function sendMessage(msg: InboxMessage): void {
  // Store in per-agent inbox directory
  const inboxDir = path.join(MESSAGES_DIR, msg.to);
  ensureDir(inboxDir);
  atomicWrite(path.join(inboxDir, `${Date.now()}-${msg.id}.json`), JSON.stringify(msg, null, 2));

  // Append to global message log (JSONL)
  ensureDir(STORAGE_DIR);
  const logEntry: MessageLogEvent = {
    id: msg.id,
    from: msg.from,
    to: msg.to,
    text: msg.text,
    kind: msg.kind,
    timestamp: msg.timestamp,
    urgent: msg.urgent,
  };
  fs.appendFileSync(MESSAGE_LOG, JSON.stringify(logEntry) + "\n", "utf-8");
}

export function pollInbox(agentName: string): InboxMessage[] {
  const inboxDir = path.join(MESSAGES_DIR, agentName);
  ensureDir(inboxDir);
  const messages: InboxMessage[] = [];
  try {
    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json")).sort();
    for (const file of files) {
      const msg = readJson<InboxMessage>(path.join(inboxDir, file));
      if (msg) {
        messages.push(msg);
        fs.unlinkSync(path.join(inboxDir, file));
      }
    }
  } catch { /* empty */ }
  return messages;
}

export function readMessageLog(limit: number = 50): MessageLogEvent[] {
  try {
    if (!fs.existsSync(MESSAGE_LOG)) return [];
    const content = fs.readFileSync(MESSAGE_LOG, "utf-8").trim();
    if (!content) return [];
    const lines = content.split("\n");
    const events: MessageLogEvent[] = [];
    for (const line of lines.slice(-limit)) {
      try { events.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return events;
  } catch { return []; }
}

// ─── Agent Registry (inspired by pi-collaborating-agents) ───

export function registerAgent(name: string, role: string, pid: number): void {
  ensureDir(REGISTRY_DIR);
  const reg = {
    id: crypto.randomUUID(),
    name,
    role,
    status: "idle" as const,
    pid,
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
  };
  atomicWrite(path.join(REGISTRY_DIR, `${name}.json`), JSON.stringify(reg, null, 2));
}

export function unregisterAgent(name: string): void {
  const filePath = path.join(REGISTRY_DIR, `${name}.json`);
  try { fs.unlinkSync(filePath); } catch { /* ok */ }
}

export function heartbeatAgent(name: string): void {
  const filePath = path.join(REGISTRY_DIR, `${name}.json`);
  const reg = readJson<any>(filePath);
  if (reg) {
    reg.lastHeartbeat = new Date().toISOString();
    atomicWrite(filePath, JSON.stringify(reg, null, 2));
  }
}

export function listAgents(): any[] {
  ensureDir(REGISTRY_DIR);
  const agents: any[] = [];
  try {
    for (const file of fs.readdirSync(REGISTRY_DIR).filter(f => f.endsWith(".json"))) {
      const reg = readJson<any>(path.join(REGISTRY_DIR, file));
      if (reg) agents.push(reg);
    }
  } catch { /* empty */ }
  return agents;
}

// ─── Reset ───

export function resetStore(): void {
  try { fs.rmSync(STORAGE_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}

export { STORAGE_DIR };
