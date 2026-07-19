import { Property, SearchCriteria } from "./types";

export function buildComplexSearchReport(criteria: SearchCriteria, properties: Property[]): string {
  const hasComplexCriteria = Boolean(criteria.mustHave?.length || criteria.exteriorMaterials?.length
    || criteria.communityFeatures?.length || criteria.distanceConstraints?.length || criteria.highwayAccess
    || criteria.schoolMinRating != null || criteria.schoolAtLeastOneRating != null);
  if (!hasComplexCriteria) return "";
  if (properties.length === 0) {
    return "No candidates remain after applying the hard requirements. Review the activity log for listing, map, or evidence-source errors.";
  }

  const verified = properties.filter((property) => property.criteriaMatch?.overall === "verified").length;
  const unknown = properties.filter((property) => property.criteriaMatch?.overall === "unknown" || !property.criteriaMatch).length;
  const failed = properties.filter((property) => property.criteriaMatch?.overall === "failed").length;
  const lines = [
    `Evidence review for ${properties.length} properties: ${verified} fully verified, ${unknown} with unresolved evidence, ${failed} failed at least one hard criterion.`,
    "City or ZIP membership is never used to infer a distance. Only source-backed coordinates or a verified driving route can satisfy a distance requirement.",
  ];

  properties.slice(0, 10).forEach((property, index) => {
    lines.push("", `${index + 1}. ${property.title} — $${property.price.toLocaleString("en-US")}`);
    const checks = property.criteriaMatch?.checks || [];
    if (checks.length === 0) {
      lines.push("   ⚠️ No criterion-level validation was produced for this property.");
    } else {
      for (const check of checks) {
        const icon = check.status === "verified" ? "✅" : check.status === "failed" ? "❌" : "⚠️";
        lines.push(`   ${icon} ${check.criterion}: ${check.detail}`);
      }
    }
    const failures = (property.evidenceDiagnostics || []).filter((item) =>
      item.status !== "success" && item.stage !== "listing-search");
    for (const diagnostic of failures.slice(0, 3)) {
      lines.push(`   ℹ️ ${diagnostic.stage}: ${diagnostic.detail}`);
    }
  });

  if (unknown > 0) {
    const followUps: string[] = [];
    if (criteria.mustHave?.length || criteria.exteriorMaterials?.length || criteria.communityFeatures?.length) {
      followUps.push("Unresolved construction or community facts still require listing-detail, seller-disclosure, or agent evidence");
    }
    if (criteria.distanceConstraints?.length) {
      followUps.push("Unresolved distance checks still require map coordinates or a valid route");
    }
    if (criteria.highwayAccess) {
      followUps.push(`${criteria.highwayAccess.highwayName} access still requires HERE road-segment and route evidence`);
    }
    if (criteria.schoolMinRating != null || criteria.schoolAtLeastOneRating != null) {
      followUps.push(criteria.schoolAssignmentRequired
        ? criteria.schoolAlternativePolicy === "strict-unique-assignment"
          ? "School evidence must include elementary, middle, and high schools from the Realtor property page or an official locator; an unrelated nearby-school search is not property-level evidence"
          : "School evidence may come from the Realtor property page or an official locator; when a district returns an eligible assignment pool, any official option may satisfy the rating rule, but an unrelated nearby-school search cannot"
        : "School ratings use source-backed 1–10 ratings shown by Realtor or targeted GreatSchools evidence; nearby does not mean officially assigned");
    }
    lines.push("", `A ⚠️ check is unresolved, not satisfied. ${followUps.join("; ")}.`);
  }
  return lines.join("\n");
}
