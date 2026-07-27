import assert from "node:assert/strict";
import test from "node:test";
import { defaultSearchCriteria, Property } from "./types";
import { regexExtract } from "./llm-service";
import { assessProperty, extractCommunityWaterEvidence, extractCoreListingMetrics, extractListingFacts, extractPropertyEvidence, haversineMiles, propertyMatchesRequestedMarket } from "./property-matcher";

test("uses full and half bathroom evidence instead of an incomplete summary count", () => {
  const metrics = extractCoreListingMetrics(
    "287 Pondview Dr, Athens, GA 30605 · 4 bd · 2 ba · 1 half ba · 1,809 sqft",
    "287 Pondview Dr, Athens, GA 30605",
  );
  assert.deepEqual(metrics, { bathrooms: 2.5, fullBathrooms: 2, halfBathrooms: 1 });
});

test("bathroom extraction is scoped to the exact property instead of a preceding listing", () => {
  const content = [
    "999 Other St, Athens, GA 30606 Total Bathrooms: 3 Full Bathrooms: 2 1/2 Bathrooms: 1",
    "x".repeat(4000),
    "155 Creek Plantation Dr, Athens, GA 30606 Total Bathrooms: 5 Full Bathrooms: 4 1/2 Bathrooms: 1 Total Square Feet Living: 4712",
  ].join(" ");
  assert.deepEqual(extractCoreListingMetrics(content, "155 Creek Plantation Dr, Athens, GA 30606"), {
    bathrooms: 4.5, fullBathrooms: 4, halfBathrooms: 1, sqft: 4712, sqftSource: "detail-page",
  });
});

test("an exact total plus full-bath count establishes zero half baths", () => {
  const metrics = extractCoreListingMetrics(
    "1305 Cedar Shoals Dr Apt 501, Athens, GA 30605 Total Bathrooms: 2 Full Bathrooms: 2",
    "1305 Cedar Shoals Dr Apt 501, Athens, GA 30605",
  );
  assert.deepEqual(metrics, { bathrooms: 2, fullBathrooms: 2, halfBathrooms: 0 });
});

test("detail bathroom fields outrank an older card total for the same address", () => {
  const address = "256 Wood Lake Dr, Athens, GA 30606";
  const content = [
    `${address} 2 beds 1.5 baths 1,863 sqft`,
    "x".repeat(4000),
    `${address} Total Bathrooms: 3 Full Bathrooms: 2 1/2 Bathrooms: 1`,
  ].join(" ");
  const metrics = extractCoreListingMetrics(content, address);
  assert.equal(metrics.bathrooms, 2.5);
  assert.equal(metrics.fullBathrooms, 2);
  assert.equal(metrics.halfBathrooms, 1);
});

test("integer MLS room count does not override a consumer-facing fractional bath count", () => {
  const address = "155 Creek Plantation Dr, Athens, GA 30606";
  const content = [
    `${address} 5 beds 4.5 baths 4,712 sqft`,
    "x".repeat(4000),
    `${address} Bathroom Information Total Bathrooms: 5 Full Bathrooms: 4`,
  ].join(" ");
  const metrics = extractCoreListingMetrics(content, address);
  assert.equal(metrics.bathrooms, 4.5);
});

test("fresh exact-property totals clear a stale cached bathroom breakdown", () => {
  const property: Property = {
    id: "unit-501", title: "1305 Cedar Shoals Dr Apt 501, Athens, GA 30605",
    price: 214000, bedrooms: 2, bathrooms: 2.5, fullBathrooms: 2, halfBathrooms: 1,
    sqft: 1176, location: "Athens, GA 30605", features: [], url: "",
    listedAt: new Date().toISOString(), source: "test",
  };
  const repaired = extractPropertyEvidence(
    property,
    "1305 Cedar Shoals Dr Apt 501, Athens, GA 30605 is a 2 bedroom, 2 bathroom condo.",
  );
  assert.equal(repaired.bathrooms, 2);
  assert.equal(repaired.fullBathrooms, undefined);
  assert.equal(repaired.halfBathrooms, undefined);
});

test("explicit living area overrides a nearby lot-size-like card value", () => {
  const metrics = extractCoreListingMetrics(
    "10 Main St, Boise, ID 83702 Living Area: 1,809 sqft Lot Size: 7,405 sqft 3 beds 2 baths 7,405 sqft",
    "10 Main St, Boise, ID 83702",
  );
  assert.equal(metrics.sqft, 1809);
  assert.equal(metrics.sqftSource, "detail-page");
});

test("1080 Belmont Realtor Schools panel produces a failed rating check instead of unknown", () => {
  const property: Property = {
    id: "belmont", title: "1080 Belmont Rd, Athens, GA 30605", price: 199000,
    bedrooms: 2, bathrooms: 1, sqft: 1164, location: "Athens, GA 30605", features: [],
    url: "https://www.realtor.com/realestateandhomes-detail/1080-Belmont-Rd_Athens_GA_30605_M53905-58944",
    listedAt: new Date().toISOString(), source: "Realtor.com",
  };
  const detail = `
    Schools From listing agent Elementary School: Whit Davis High School: Cedar Shoals Middle School: Hilsman
    Nearby schools Elementary Middle High Private
    5 10 5 out of 10 Whit Davis Road Elementary School Grades K-5 | 3.4 mi away | 346 students | 6 reviews
    3 10 3 out of 10 Hilsman Middle School Grades 6-8 | 5.5 mi away | 609 students | 9 reviews
    2 10 2 out of 10 Cedar Shoals High School Grades 9-12 | 5.0 mi away | 1508 students | 8 reviews
    Ratings provided by GreatSchools.org
  `;
  const enriched = extractPropertyEvidence(property, detail);
  assert.deepEqual(enriched.schools?.map((school) => [school.name, school.rating]), [
    ["Whit Davis Road Elementary School", 5], ["Hilsman Middle School", 3], ["Cedar Shoals High School", 2],
  ]);
  const match = assessProperty(enriched, {
    ...defaultSearchCriteria(), location: "Athens, GA", schoolMinRating: 5,
    schoolAtLeastOneRating: 8, schoolAssignmentRequired: true,
  });
  assert.equal(match.overall, "failed");
  assert.equal(match.checks.at(-1)?.status, "failed");
});

test("extracts an arbitrary bare US city after a location preposition", () => {
  const result = regexExtract("Find homes in Boise with 3 bedrooms", defaultSearchCriteria());
  assert.equal(result.criteria.location, "Boise");
});

test("preserves explicit states and foreign qualifiers for strict location resolution", () => {
  assert.equal(regexExtract("Find homes in Portland, ME with 3 bedrooms", defaultSearchCriteria()).criteria.location, "Portland, ME");
  assert.equal(regexExtract("Find homes in Portland, Maine under $700k", defaultSearchCriteria()).criteria.location, "Portland, Maine");
  assert.equal(regexExtract("Find homes in Athens, Greece", defaultSearchCriteria()).criteria.location, "Athens, Greece");
  assert.equal(regexExtract("Find homes in London, UK", defaultSearchCriteria()).criteria.location, "London, UK");
});

test("extracts the mixed Chinese and English complex query", () => {
  const result = regexExtract(
    "房子四面墙是砖墙，小区里有湖，离supermarket or large grocery store不超过三英里，离UGA不超过30英里。",
    defaultSearchCriteria(),
  );
  assert.equal(result.criteria.location, "Athens, GA");
  assert.deepEqual(result.criteria.exteriorMaterials, ["brick"]);
  assert.deepEqual(result.criteria.communityFeatures, ["lake"]);
  assert.equal(result.criteria.distanceConstraints?.find((item) => item.category === "grocery")?.maxMiles, 3);
  assert.equal(result.criteria.distanceConstraints?.find((item) => item.name === "UGA")?.maxMiles, 30);
});

test("extracts a GA-316 nearest-access driving constraint", () => {
  const result = regexExtract(
    "找 Athens 的房子，离 GA-316 最近的入口不超过 3 英里。",
    defaultSearchCriteria(),
  );
  assert.deepEqual(result.criteria.highwayAccess, { highwayName: "GA-316", maxMiles: 3 });
});

test("extracts natural English assigned K-12 compound rating criteria", () => {
  const result = regexExtract(
    "Find homes in Atlanta with assigned K–12 schools all rated at least 5/10 with at least one rated 8/10.",
    defaultSearchCriteria(),
  );
  assert.equal(result.criteria.location, "Atlanta");
  assert.equal(result.criteria.schoolMinRating, 5);
  assert.equal(result.criteria.schoolAtLeastOneRating, 8);
  assert.equal(result.criteria.schoolAssignmentRequired, true);
  assert.equal(result.criteria.schoolAlternativePolicy, "any-eligible-option");
});

test("verifies basic location and bedroom criteria instead of marking every result unknown", () => {
  const property: Property = {
    id: "basic-1", title: "Seattle home", price: 650000, bedrooms: 3, bathrooms: 2, sqft: 1600,
    location: "Seattle, WA", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  };
  const match = assessProperty(property, {
    ...defaultSearchCriteria(), location: "Seattle, WA", minBedrooms: 3,
  });
  assert.equal(match.overall, "verified");
  assert.equal(match.checks.length, 2);
});

test("a source-backed Studio fails a three-bedroom requirement instead of becoming unknown", () => {
  const property: Property = {
    id: "studio", title: "189 Chestnut Hill Ave Apt 14, Boston, MA 02135",
    price: 295900, bedrooms: 0, bedroomsSource: "listing-card",
    bathrooms: 1, sqft: 395, location: "Boston, MA 02135", features: [],
    url: "", listedAt: new Date().toISOString(), source: "Realtor.com",
  };
  const match = assessProperty(property, {
    ...defaultSearchCriteria(), location: "Boston, MA", minBedrooms: 3, maxPrice: 1000000,
  });
  assert.equal(match.overall, "failed");
  assert.equal(match.checks.find((check) => /bedrooms/.test(check.criterion))?.status, "failed");
});

test("fails basic search results from the wrong market or below the bedroom minimum", () => {
  const property: Property = {
    id: "basic-2", title: "Atlanta home", price: 400000, bedrooms: 2, bathrooms: 2, sqft: 1400,
    location: "Atlanta, GA", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  };
  const match = assessProperty(property, {
    ...defaultSearchCriteria(), location: "Seattle, WA", minBedrooms: 3,
  });
  assert.equal(match.overall, "failed");
  assert.equal(match.checks.filter((check) => check.status === "failed").length, 2);
});

test("extracts evidence and verifies all complex constraints", () => {
  const base: Property = {
    id: "p1", title: "Athens home", price: 500000, bedrooms: 4, bathrooms: 3, sqft: 2400,
    location: "Athens, GA", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  };
  const property = extractPropertyEvidence(base, `
    <p>Four-sided brick home in a neighborhood with a community lake.</p>
    <p>Publix grocery store 2.4 miles from the property.</p>
    <script>{"latitude":33.95,"longitude":-83.38}</script>
  `);
  const match = assessProperty(property, {
    ...defaultSearchCriteria(),
    exteriorMaterials: ["brick"], communityFeatures: ["lake"],
    distanceConstraints: [
      { name: "supermarket", category: "grocery", maxMiles: 3 },
      { name: "UGA", category: "university", maxMiles: 30, lat: 33.948, lng: -83.3773 },
    ],
  });
  assert.equal(match.overall, "verified");
  assert.equal(match.score, 100);
});

test("does not treat a generic brick mention as four-sided brick", () => {
  const property = extractPropertyEvidence({
    id: "p2", title: "Brick-front home", price: 400000, bedrooms: 3, bathrooms: 2, sqft: 1800,
    location: "Athens, GA", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  }, "This home has a brick front accent.");
  const match = assessProperty(property, { ...defaultSearchCriteria(), exteriorMaterials: ["brick"] });
  assert.equal(match.overall, "failed");
});

test("extracts brick and lake evidence embedded in listing JSON scripts", () => {
  const property = extractPropertyEvidence({
    id: "p3", title: "320 Kings Rd", price: 375000, bedrooms: 4, bathrooms: 2, sqft: 1985,
    location: "Athens, GA", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  }, '<script type="application/json">{"description":"Four-sided brick home","communityAmenities":["Lake"]}</script>');
  assert.equal(property.exteriorCoverage, "all-sides");
  assert.deepEqual(property.communityFeatures, ["lake"]);
});

test("recognizes HOA lake amenities in either sentence order without using mere proximity", () => {
  const base: Property = {
    id: "hoa-lake", title: "Athens home", price: 300000, bedrooms: 3, bathrooms: 2, sqft: 1500,
    location: "Athens, GA", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  };
  assert.deepEqual(extractPropertyEvidence(base, "Association Amenities: walking trails and a lake for residents.").communityFeatures, ["lake"]);
  assert.deepEqual(extractPropertyEvidence(base, "The lake is maintained by the HOA and available to residents.").communityFeatures, ["lake"]);
  assert.deepEqual(extractPropertyEvidence(base, "A public lake is located 2 miles from the property.").communityFeatures, []);
});

test("recognizes structured resident lake access but not an unrelated nearby lake", () => {
  const base: Property = {
    id: "lake-access", title: "1 Main St, Athens, GA 30606", price: 300000,
    bedrooms: 3, bathrooms: 2, sqft: 1500, location: "Athens, GA 30606",
    features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  };
  assert.deepEqual(extractPropertyEvidence(base, "Association Amenities: Lake Access, Clubhouse").communityFeatures, ["lake"]);
  assert.deepEqual(extractPropertyEvidence(base, "Community Features: Private Pond, Sidewalks").communityFeatures, ["pond"]);
  assert.deepEqual(extractPropertyEvidence(base, "Lake Oconee is 28 miles away.").communityFeatures, []);
});

test("extracts Realtor collapsed community-lake JSON without letting unrelated pond tags replace lake", () => {
  const raw = `<script>{"categories":[
    {"category":"Homeowners Association","parent_category":"Community","text":[
      "Association: Yes","Association Fee Includes: Maintenance Grounds"
    ]},
    {"category":"Amenities and Community Features","parent_category":"Community","text":[
      "Community Features: Homeowners Assoc, Lake, Near Shopping, Playground, Pool"
    ]}
  ],"photo_tags":["pond"],"description":"A decorative pond appears in one photo."}</script>`;
  const evidence = extractCommunityWaterEvidence(raw);
  assert.deepEqual(evidence.features, ["lake"]);
  assert.match(evidence.snippets.join(" "), /Community Features: Homeowners Assoc, Lake/);
});

test("accepts HOA lake rights and rejects lake views or nearby public lakes", () => {
  assert.deepEqual(
    extractCommunityWaterEvidence("Association Fee Includes: Lake/Pond, Common Area Maintenance").features,
    ["lake", "pond"],
  );
  assert.deepEqual(
    extractCommunityWaterEvidence("Waterfront and Water Access: Lake Privileges; Association: Yes").features,
    ["lake"],
  );
  assert.deepEqual(extractCommunityWaterEvidence("View: Lake. Water Body Name: Lake Oconee.").features, []);
  assert.deepEqual(extractCommunityWaterEvidence("Public lake located 0.4 miles away.").features, []);
});

test("256 Wood Lake keeps the Realtor lake excerpt and displays 2 full plus 1 half as 2.5 baths", () => {
  const property = extractPropertyEvidence({
    id: "wood-lake", title: "256 Wood Lake Dr, Athens, GA 30606", price: 345000,
    bedrooms: 2, bathrooms: 1.5, sqft: 1863, location: "Athens, GA 30606",
    features: [], url: "https://www.realtor.com/realestateandhomes-detail/256-Wood-Lake-Dr_Athens_GA_30606_M68277-44687",
    listedAt: new Date().toISOString(), source: "Realtor.com",
  }, `256 Wood Lake Dr, Athens, GA 30606
    Property details
    This home has 2 full bathrooms and 1 partial bathroom.
    This gated neighborhood includes a community pool, and lake, surrounded by trees.
  `);
  assert.equal(property.bathrooms, 2.5);
  assert.equal(property.fullBathrooms, 2);
  assert.equal(property.halfBathrooms, 1);
  assert.deepEqual(property.communityFeatures, ["lake"]);
  assert.match(property.featureEvidence?.[0]?.excerpt || "", /neighborhood includes a community pool, and lake/i);

  const match = assessProperty(property, { ...defaultSearchCriteria(), communityFeatures: ["lake"] });
  assert.equal(match.overall, "verified");
  const lakeCheck = match.checks.find((check) => check.criterion === "community feature: lake");
  assert.match(lakeCheck?.detail || "", /Listing evidence:.*community pool, and lake/i);
  assert.match(lakeCheck?.detail || "", /realtor\.com/i);
});

test("community evidence does not join a Pool field to a later Wood Lake driving direction", () => {
  const content = `{"category":"Amenities and Community Features","text":["Community Features: Pool"]},
    {"category":"Other Property Info","text":["Directions: turn right into Wood Lake"]},
    {"description":"This gated neighborhood includes a community pool, and lake, surrounded by trees."}`;
  const evidence = extractCommunityWaterEvidence(content);
  assert.deepEqual(evidence.features, ["lake"]);
  assert.ok(evidence.snippets.some((snippet) => /neighborhood includes a community pool, and lake/i.test(snippet)));
  assert.ok(evidence.snippets.every((snippet) => !/Community Features: Pool.*Directions/i.test(snippet)));
});

test("strict requested-market matching rejects same-name cities, nearby cities, and foreign results", () => {
  const property = (location: string): Pick<Property, "title" | "location"> => ({
    title: `1 Main St, ${location}`, location,
  });
  assert.equal(propertyMatchesRequestedMarket(property("Athens, GA 30606"), "Athens, GA"), true);
  assert.equal(propertyMatchesRequestedMarket(property("Athens, Georgia 30606"), "Athens, GA"), true);
  assert.equal(propertyMatchesRequestedMarket(property("Athens, OH 45701"), "Athens, GA"), false);
  assert.equal(propertyMatchesRequestedMarket(property("Atlanta, GA 30303"), "Athens, GA"), false);
  assert.equal(propertyMatchesRequestedMarket(property("Athens, Greece"), "Athens, GA"), false);
  assert.equal(propertyMatchesRequestedMarket(property("Seattle, WA 98101"), "Seattle"), true);
  assert.equal(propertyMatchesRequestedMarket(property("Seattle, Canada"), "Seattle"), false);
  assert.equal(propertyMatchesRequestedMarket(property("Seattle, BC"), "Seattle"), false);
  assert.equal(propertyMatchesRequestedMarket(property("Athens, OH 45701"), "Athens"), false);
  assert.equal(propertyMatchesRequestedMarket(property("Portland, ME 04101"), "Portland"), false);
  assert.equal(propertyMatchesRequestedMarket(property("Washington, PA 15301"), "Washington"), false);
  assert.equal(propertyMatchesRequestedMarket(property("Athens, GA, USA"), "Athens, GA"), true);
  assert.equal(propertyMatchesRequestedMarket(property("Athens, GA, United States"), "Athens, GA"), true);
});

test("extracts Realtor detail-page brick, groceries, and score-first school evidence", () => {
  const property = extractPropertyEvidence({
    id: "kings-rd", title: "320 Kings Rd", price: 375000, bedrooms: 4, bathrooms: 2, sqft: 1985,
    location: "Athens, GA 30606", features: [], url: "https://www.realtor.com/kings-rd",
    listedAt: new Date().toISOString(), source: "test",
  }, `
    Construction Materials: Brick
    Architectural Style: Brick 4 Side, Ranch
    ## Neighborhood & schools
    Groceries
    ALDI (0.6 mi), R and A Seafood Market (0.9 mi)
    Shopping
    ## Schools
    7 10 7 out of 10
    Timothy Elementary School
    Grades K-5
    4 10 4 out of 10
    Clarke Middle School
    Grades 6-8
    5 10 5 out of 10
    Clarke Central High School
    Grades 9-12
  `);

  assert.equal(property.exteriorCoverage, "all-sides");
  assert.deepEqual(property.listingFacts?.["Listing: Architectural Style"], ["Brick 4 Side, Ranch"]);
  assert.deepEqual(property.nearbyPlaces?.slice(0, 2).map((place) => [place.name, place.distanceMiles]), [
    ["ALDI", 0.6], ["R and A Seafood Market", 0.9],
  ]);
  assert.deepEqual(property.schools?.map((school) => [school.name, school.rating, school.type]), [
    ["Timothy Elementary School", 7, "elementary"],
    ["Clarke Middle School", 4, "middle"],
    ["Clarke Central High School", 5, "high"],
  ]);
  assert.equal(assessProperty(property, { ...defaultSearchCriteria(), mustHave: ["brick ranch style"] }).overall, "verified");
});

test("listing evidence snapshot excludes Realtor page chrome and keeps property facts", () => {
  const facts = extractListingFacts(`
    ## Neighborhood & schools
    Home buyers reveal: 'What I wish I had known before buying my first home'
    Realtor.com checked: A few minutes ago | Listing last updated:
    Source: GeorgiaMLS, MLS #10801902
    This property has multiple listings: For Sale listing 1 | For Sale listing 2
    ## Exterior
    Construction Materials: Brick
    Architectural Style: Brick 4 Side, Ranch
    Community Features: Lake, Sidewalks
    Year Built: 1983
  `);
  assert.deepEqual(facts, {
    "Exterior: Construction Materials": ["Brick"],
    "Exterior: Architectural Style": ["Brick 4 Side, Ranch"],
    "Exterior: Community Features": ["Lake, Sidewalks"],
    "Exterior: Year Built": ["1983"],
  });
});

test("repairs missing core metrics from a Realtor detail summary", () => {
  const summary = "153 Ponderosa Dr, Athens, GA 30605 beds 2 baths 2 sqft square feet 1,570 sqft lot 8,276 year built 1983";
  assert.deepEqual(extractCoreListingMetrics(summary, "153 Ponderosa Dr, Athens, GA 30605"), {
    bedrooms: 2, bathrooms: 2, sqft: 1570, sqftSource: "listing-card",
  });
  const property = extractPropertyEvidence({
    id: "ponderosa", title: "153 Ponderosa Dr, Athens, GA 30605", price: 299000,
    bedrooms: 2, bathrooms: 0, sqft: 1570, location: "Athens, GA 30605", features: [], url: "",
    listedAt: new Date().toISOString(), source: "test",
  }, summary);
  assert.equal(property.bathrooms, 2);
});

test("treats unavailable bedroom and bathroom counts as unknown rather than zero", () => {
  const property: Property = {
    id: "missing-core", title: "Athens listing", price: 300000, bedrooms: 0, bathrooms: 0, sqft: 0,
    location: "Athens, GA", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  };
  const match = assessProperty(property, {
    ...defaultSearchCriteria(), location: "Athens, GA", minBedrooms: 3, minBathrooms: 2,
  });
  assert.equal(match.overall, "unknown");
  assert.deepEqual(match.checks.slice(-2).map((check) => check.status), ["unknown", "unknown"]);
});

test("computes stable straight-line distances", () => {
  assert.ok(haversineMiles(33.95, -83.38, 33.948, -83.3773) < 1);
});

test("extracts a Chinese K-12 rating threshold without an LLM", () => {
  const result = regexExtract("我想找 Athens 的房子，所在的 K-12 school 打分在8以上", defaultSearchCriteria());
  assert.equal(result.criteria.schoolMinRating, 8);
  assert.equal(result.criteria.schoolAssignmentRequired, true);
});

test("extracts a compound assigned-school rating rule without leaking it into mustHave", () => {
  const result = regexExtract(
    "我想找 Athens, GA 的房子，所在小学、初中、高中评分均不低于5，其中至少一所不低于8",
    defaultSearchCriteria(),
  );
  assert.equal(result.criteria.schoolMinRating, 5);
  assert.equal(result.criteria.schoolAtLeastOneRating, 8);
  assert.equal(result.criteria.schoolAssignmentRequired, true);
  assert.equal(result.criteria.mustHave, undefined);
});

test("verifies all assigned schools at five with at least one at eight", () => {
  const checkedAt = new Date().toISOString();
  const property: Property = {
    id: "compound-school", title: "Athens home", price: 400000, bedrooms: 3, bathrooms: 2, sqft: 1800,
    location: "Athens, GA", features: [], url: "", listedAt: checkedAt, source: "test",
    schools: [
      assignedSchool("Elementary", "elementary", 5, checkedAt),
      assignedSchool("Middle", "middle", 8, checkedAt),
      assignedSchool("High", "high", 6, checkedAt),
    ],
  };
  const criteria = {
    ...defaultSearchCriteria(), schoolMinRating: 5, schoolAtLeastOneRating: 8, schoolAssignmentRequired: true,
  };
  assert.equal(assessProperty(property, criteria).overall, "verified");
  property.schools![1].rating = 7;
  assert.equal(assessProperty(property, criteria).overall, "failed");
  property.schools![0].rating = 4;
  property.schools![1].rating = 9;
  assert.equal(assessProperty(property, criteria).overall, "failed");
});

test("accepts any qualifying school in a non-unique official placement pool", () => {
  const checkedAt = new Date().toISOString();
  const option = (name: string, rating: number) => ({
    ...assignedSchool(name, "elementary" as const, rating, checkedAt),
    relationship: "assignment-option" as const,
    assignmentGroup: "Elementary C",
    assignmentGroupSize: 3,
  });
  const property: Property = {
    id: "school-options", title: "Athens home", price: 400000, bedrooms: 3, bathrooms: 2, sqft: 1800,
    location: "Athens, GA", features: [], url: "", listedAt: checkedAt, source: "test",
    schools: [
      option("Possible Elementary A", 4), option("Possible Elementary B", 8), option("Possible Elementary C", 3),
      assignedSchool("Middle", "middle", 6, checkedAt),
      assignedSchool("High", "high", 5, checkedAt),
    ],
  };
  const criteria = {
    ...defaultSearchCriteria(), schoolMinRating: 5, schoolAtLeastOneRating: 8,
    schoolAssignmentRequired: true, schoolAlternativePolicy: "any-eligible-option" as const,
  };

  const match = assessProperty(property, criteria);
  assert.equal(match.overall, "verified");
  assert.match(match.checks[0].detail, /official option meets/i);

  property.schools![1].rating = 4;
  assert.equal(assessProperty(property, criteria).overall, "failed");
});

test("extracts the user's flexible official-school option policy", () => {
  const result = regexExtract("If assignment depends on availability, any one possible school at least 8 is acceptable", {
    ...defaultSearchCriteria(), schoolMinRating: 5, schoolAtLeastOneRating: 8,
  });
  assert.equal(result.criteria.schoolAlternativePolicy, "any-eligible-option");
});

test("verifies complete nearby K-12 rating evidence but does not claim assignment", () => {
  const checkedAt = new Date().toISOString();
  const property: Property = {
    id: "school-1", title: "Athens home", price: 400000, bedrooms: 3, bathrooms: 2, sqft: 1800,
    location: "Athens, GA", features: [], url: "https://www.realtor.com/example", listedAt: checkedAt, source: "test",
    schools: [
      { name: "A Elementary School", rating: 8, scale: 10, type: "elementary", ratingSource: "GreatSchools", evidenceSource: "realtor-listing", sourceUrl: "https://www.realtor.com/example", relationship: "nearby", checkedAt },
      { name: "B Middle School", rating: 9, scale: 10, type: "middle", ratingSource: "GreatSchools", evidenceSource: "realtor-listing", sourceUrl: "https://www.realtor.com/example", relationship: "nearby", checkedAt },
      { name: "C High School", rating: 8, scale: 10, type: "high", ratingSource: "GreatSchools", evidenceSource: "realtor-listing", sourceUrl: "https://www.realtor.com/example", relationship: "nearby", checkedAt },
    ],
  };
  const match = assessProperty(property, { ...defaultSearchCriteria(), schoolMinRating: 8 });
  assert.equal(match.overall, "verified");
  assert.match(match.checks[0].detail, /attendance assignment is not verified/i);
});

test("fails the school criterion when a Realtor-listed school is below the threshold", () => {
  const checkedAt = new Date().toISOString();
  const property: Property = {
    id: "school-2", title: "Athens home", price: 400000, bedrooms: 3, bathrooms: 2, sqft: 1800,
    location: "Athens, GA", features: [], url: "https://www.realtor.com/example", listedAt: checkedAt, source: "test",
    schools: [{ name: "D High School", rating: 6, scale: 10, type: "high", ratingSource: "GreatSchools", evidenceSource: "firecrawl-search", sourceUrl: "https://www.realtor.com/school", relationship: "nearby", checkedAt }],
  };
  assert.equal(assessProperty(property, { ...defaultSearchCriteria(), schoolMinRating: 8 }).overall, "failed");
});

test("property-page school evidence satisfies the requested school rule nationwide", () => {
  const checkedAt = new Date().toISOString();
  const property: Property = {
    id: "school-3", title: "Athens home", price: 400000, bedrooms: 3, bathrooms: 2, sqft: 1800,
    location: "Athens, GA", features: [], url: "", listedAt: checkedAt, source: "test",
    schools: [
      { name: "A Elementary School", rating: 9, scale: 10, type: "elementary", ratingSource: "GreatSchools", evidenceSource: "realtor-listing", sourceUrl: "https://www.realtor.com/example", relationship: "listing-associated", assignmentSource: "realtor-listing", checkedAt },
      { name: "B Middle School", rating: 9, scale: 10, type: "middle", ratingSource: "GreatSchools", evidenceSource: "realtor-listing", sourceUrl: "https://www.realtor.com/example", relationship: "listing-associated", assignmentSource: "realtor-listing", checkedAt },
      { name: "C High School", rating: 9, scale: 10, type: "high", ratingSource: "GreatSchools", evidenceSource: "realtor-listing", sourceUrl: "https://www.realtor.com/example", relationship: "listing-associated", assignmentSource: "realtor-listing", checkedAt },
    ],
  };
  const match = assessProperty(property, { ...defaultSearchCriteria(), schoolMinRating: 8, schoolAssignmentRequired: true });
  assert.equal(match.overall, "verified");
  assert.match(match.checks[0].detail, /displayed for this property on its Realtor page/i);
});

test("an unrelated nearby-school search does not satisfy a property-associated school request", () => {
  const checkedAt = new Date().toISOString();
  const property: Property = {
    id: "school-4", title: "Athens home", price: 400000, bedrooms: 3, bathrooms: 2, sqft: 1800,
    location: "Athens, GA", features: [], url: "", listedAt: checkedAt, source: "test",
    schools: [
      { name: "A Elementary School", rating: 9, scale: 10, type: "elementary", ratingSource: "GreatSchools", evidenceSource: "firecrawl-search", sourceUrl: "", relationship: "nearby", checkedAt },
      { name: "B Middle School", rating: 9, scale: 10, type: "middle", ratingSource: "GreatSchools", evidenceSource: "firecrawl-search", sourceUrl: "", relationship: "nearby", checkedAt },
      { name: "C High School", rating: 9, scale: 10, type: "high", ratingSource: "GreatSchools", evidenceSource: "firecrawl-search", sourceUrl: "", relationship: "nearby", checkedAt },
    ],
  };
  const match = assessProperty(property, { ...defaultSearchCriteria(), schoolMinRating: 8, schoolAssignmentRequired: true });
  assert.equal(match.overall, "unknown");
});

function assignedSchool(name: string, type: "elementary" | "middle" | "high", rating: number, checkedAt: string) {
  return {
    name, rating, scale: 10 as const, type, ratingSource: "GreatSchools" as const,
    evidenceSource: "greatschools-page" as const, sourceUrl: "https://www.greatschools.org/example",
    relationship: "assigned" as const, assignmentSource: "official-locator" as const,
    assignmentSourceUrl: "https://district.example/locator", checkedAt,
  };
}
