export interface HighwayAnchor {
  name: string;
  lat: number;
  lng: number;
}

export interface HighwayDefinition {
  canonicalName: string;
  aliases: string[];
  anchors: HighwayAnchor[];
  probeSpacingMiles: number;
  probeCandidateLimit: number;
  source: string;
}

const HIGHWAYS: HighwayDefinition[] = [
  {
    canonicalName: "GA-316",
    aliases: [
      "GA-316",
      "GA 316",
      "Georgia 316",
      "SR-316",
      "SR 316",
      "State Route 316",
      "University Parkway",
    ],
    // Endpoints from the Georgia DOT State Route Network, route code 00031600.
    // HERE traces the highway between these endpoints once, then property
    // routes target nearby points on that trace. The endpoints are no longer
    // the only access candidates.
    anchors: [
      { name: "GA-316 west terminus at I-85", lat: 33.9624146746, lng: -84.1065900256 },
      { name: "GA-316 east terminus at GA-10 Loop", lat: 33.9126948703, lng: -83.4511025177 },
    ],
    probeSpacingMiles: 0.75,
    probeCandidateLimit: 8,
    source: "Georgia DOT State Route Network (route 00031600)",
  },
];

export function resolveHighwayDefinition(name: string): HighwayDefinition | null {
  const normalized = normalizeHighwayName(name);
  return HIGHWAYS.find((highway) => highway.aliases.some((alias) => normalizeHighwayName(alias) === normalized)) || null;
}

export function isHighwayRoadLabel(value: string, highway: HighwayDefinition): boolean {
  const normalized = normalizeHighwayName(value);
  return highway.aliases.some((alias) => normalizeHighwayName(alias) === normalized);
}

function normalizeHighwayName(value: string): string {
  return value.toLowerCase()
    .replace(/\b(?:georgia|state route|route|highway)\b/g, "sr")
    .replace(/\bga\b/g, "sr")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^srsr/, "sr");
}
