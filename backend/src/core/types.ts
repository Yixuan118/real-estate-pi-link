
// ─── Core Types for Real Estate Multi-Agent System ───
// Inspired by pi-collaborating-agents: agent registry, message bus, file reservation patterns

export type AgentRole = "orchestrator" | "memory" | "scraper" | "watcher";
export type AgentStatus = "idle" | "busy" | "error";

export interface AgentRegistration {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  pid: number;
  startedAt: string;
  lastHeartbeat: string;
}

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  kind: "direct" | "broadcast";
  timestamp: string;
  urgent?: boolean;
  replyTo?: string | null;
}

export interface MessageLogEvent {
  id: string;
  from: string;
  to: string | "all";
  text: string;
  kind: "direct" | "broadcast";
  timestamp: string;
  urgent?: boolean;
}

// ─── Real Estate Domain Types ───

export interface Property {
  id: string;
  title: string;
  price: number;
  bedrooms: number;
  bathrooms: number;
  sqft: number;
  location: string;
  features: string[];
  url: string;
  imageUrl?: string;
  listedAt: string;
  source: string;
  latitude?: number;
  longitude?: number;
  description?:string;
  schools?: Array<{name:string;rating:number;type:string}>;
}

export interface SearchCriteria {
  location?: string;
  minPrice?: number;
  maxPrice?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  propertyType?: string;
  mustHave: string[];
  exteriorMaterials?: string[];
  communityFeatures?: string[];
  distanceConstraints?: Array<{ name: string; lat: number; lng: number; maxMiles: number }>;
  schoolMinRating?: number;
  highwayAccess?: { highwayName: string; maxMiles: number };
  updatedAt: string;
}

export function defaultSearchCriteria(): SearchCriteria {
  return {
    location: undefined,
    minPrice: undefined,
    maxPrice: undefined,
    minBedrooms: undefined,
    minBathrooms: undefined,
    propertyType: undefined,
    mustHave: [],
    exteriorMaterials: undefined,
    communityFeatures: undefined,
    distanceConstraints: undefined,
    schoolMinRating: undefined,
    highwayAccess: undefined,
    updatedAt: new Date().toISOString(),
  };
}

export interface ConversationEntry {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ─── Session / State Types ───

export interface UserSession {
  id: string;
  userId: string;
  criteria: SearchCriteria;
  conversation: ConversationEntry[];
  watchedProperties: string[];
  matchedProperties: Property[];
  monitoringInterval: number;
  lastCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function createUserSession(userId: string): UserSession {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    userId,
    criteria: defaultSearchCriteria(),
    conversation: [],
    watchedProperties: [],
    matchedProperties: [],
    monitoringInterval: 3600000,
    lastCheckAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ─── WebSocket Event Types ───

export interface WsClientMessage {
  type: "user_message";
  text: string;
}

export interface WsServerEvent {
  type: "agent_activity" | "agent_message" | "properties_update" | "criteria_update" | "conversation_update" | "error" | "connection_ack";
  payload: Record<string, unknown>;
}

export interface AgentActivityPayload {
  agentName: string;
  action: string;
  detail: string;
}
