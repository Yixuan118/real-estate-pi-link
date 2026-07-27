
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
  bedroomsSource?: "structured-data" | "listing-card" | "detail-page" | "cached";
  bathrooms: number;
  fullBathrooms?: number;
  halfBathrooms?: number;
  bathroomsSource?: "structured-data" | "listing-card" | "detail-page" | "cached";
  sqft: number;
  sqftSource?: "structured-data" | "listing-card" | "detail-page" | "cached";
  location: string;
  features: string[];
  url: string;
  imageUrl?: string;
  listedAt: string;
  source: string;
  latitude?: number;
  longitude?: number;
  coordinateSource?: "listing" | "google-geocoding" | "here-geocoding";
  description?:string;
  listingFacts?: Record<string, string[]>;
  listingEvidenceText?: string;
  listingEvidenceSourceUrl?: string;
  schools?: SchoolEvidence[];
  schoolDistricts?: SchoolDistrictEvidence[];
  exteriorMaterials?: string[];
  exteriorCoverage?: "all-sides" | "partial" | "unknown";
  communityFeatures?: string[];
  nearbyWaterBodies?: Array<{
    name: string;
    type: "lake-pond" | "reservoir" | "waterbody";
    distanceMiles: number;
    areaAcres?: number;
    source: "USGS 3D Hydrography Program" | "HERE";
    sourceUrl: string;
    checkedAt: string;
  }>;
  featureEvidence?: Array<{
    criterion: "all-sides-brick" | "community-lake";
    sourceUrl: string;
    source: "realtor-listing" | "targeted-web-search";
    checkedAt: string;
    excerpt?: string;
  }>;
  nearbyPlaces?: Array<{
    name: string;
    category: "grocery" | "university" | "other";
    distanceMiles: number;
    source: "listing" | "calculated";
    placeId?: string;
    distanceMode?: "driving" | "straight-line";
    checkedAt?: string;
  }>;
  distanceEvaluations?: Array<{
    name: string;
    category: "grocery" | "university" | "other";
    maxMiles: number;
    status: ConstraintMatchStatus;
    distanceMiles?: number;
    detail: string;
    source: "google-maps" | "here" | "listing" | "calculated";
    distanceMode: "driving" | "straight-line";
    checkedAt: string;
  }>;
  highwayAccessEvaluation?: {
    highwayName: string;
    maxMiles: number;
    status: ConstraintMatchStatus;
    distanceMiles?: number;
    accessName?: string;
    detail: string;
    source: "here";
    distanceMode: "driving";
    checkedAt: string;
  };
  criteriaMatch?: PropertyCriteriaMatch;
  evidenceDiagnostics?: Array<{
    stage: "listing-detail" | "listing-search" | "school-district" | "school-assignment" | "school-rating" | "geocoding" | "poi-search" | "waterbody-search" | "routing" | "highway-routing" | "geo-provider";
    status: "success" | "warning" | "error";
    detail: string;
  }>;
}

export interface SchoolEvidence {
  name: string;
  rating?: number;
  scale: 10;
  type: "elementary" | "middle" | "high" | "k12" | "other";
  grades?: string;
  distanceMiles?: number;
  studentCount?: number;
  reviewCount?: number;
  ratingSource: "GreatSchools" | "unknown";
  evidenceSource: "realtor-listing" | "realtor-school-page" | "greatschools-page" | "firecrawl-search" | "official-locator";
  sourceUrl: string;
  relationship: "nearby" | "listing-associated" | "assigned" | "assignment-option" | "unknown";
  assignmentGroup?: string;
  assignmentGroupSize?: number;
  assignmentSource?: "official-locator" | "realtor-listing";
  assignmentSourceUrl?: string;
  checkedAt: string;
}

export interface SchoolDistrictEvidence {
  name: string;
  geoid: string;
  level: "elementary" | "secondary" | "unified";
  lowGrade?: string;
  highGrade?: string;
  source: "US Census/NCES";
  sourceUrl: string;
  checkedAt: string;
}

export type ConstraintMatchStatus = "verified" | "failed" | "unknown";

export interface ConstraintMatch {
  criterion: string;
  status: ConstraintMatchStatus;
  detail: string;
}

export interface PropertyCriteriaMatch {
  overall: ConstraintMatchStatus;
  score: number;
  checks: ConstraintMatch[];
}

export interface DistanceConstraint {
  name: string;
  maxMiles: number;
  category?: "grocery" | "university" | "other";
  lat?: number;
  lng?: number;
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
  distanceConstraints?: DistanceConstraint[];
  schoolMinRating?: number;
  schoolAtLeastOneRating?: number;
  schoolAssignmentRequired?: boolean;
  schoolAlternativePolicy?: "any-eligible-option" | "strict-unique-assignment";
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
    schoolAtLeastOneRating: undefined,
    schoolAssignmentRequired: undefined,
    schoolAlternativePolicy: "any-eligible-option",
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
