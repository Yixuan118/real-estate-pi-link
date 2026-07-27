import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractGreatSchoolsRating, extractSchoolEvidence, extractTargetSchoolRating, SchoolRatingService } from "./school-rating-service";
import { assessProperty } from "../core/property-matcher";
import { defaultSearchCriteria } from "../core/types";

test("extracts property-associated school ratings from Realtor listing data", () => {
  const schools = extractSchoolEvidence(`
    <script type="application/json">
      {"schools":[
        {"name":"Timothy Road Elementary School","rating":8,"grades":"PK-5"},
        {"name":"Clarke Middle School","rating":9,"grades":"6-8"},
        {"name":"Clarke Central High School","rating":8,"grades":"9-12"}
      ]}
    </script>
  `, "https://www.realtor.com/realestateandhomes-detail/example");

  assert.deepEqual(schools.map((school) => [school.name, school.rating, school.type]), [
    ["Timothy Road Elementary School", 8, "elementary"],
    ["Clarke Middle School", 9, "middle"],
    ["Clarke Central High School", 8, "high"],
  ]);
  assert.ok(schools.every((school) => school.relationship === "listing-associated"));
  assert.ok(schools.every((school) => school.assignmentSource === "realtor-listing"));
});

test("extracts Realtor listing-agent schools and compact circle ratings", () => {
  const schools = extractSchoolEvidence(`
    Schools From listing agent
    Elementary School: Whitehead Road
    Middle School: Burney Harris Lyons
    High School: Clarke Central
    Nearby schools Elementary Middle High Private
    6 10 Whitehead Road Elementary School Grades K-5 | 0.5 mi away
    7 10 Burney-Harris-Lyons Middle School Grades 6-8 | 2.0 mi away
    5 10 Clarke Central High School Grades 9-12 | 3.6 mi away
  `, "https://www.realtor.com/realestateandhomes-detail/example");

  assert.deepEqual(schools.map((school) => [school.name, school.type, school.rating, school.relationship]), [
    ["Whitehead Road Elementary School", "elementary", 6, "listing-associated"],
    ["Burney-Harris-Lyons Middle School", "middle", 7, "listing-associated"],
    ["Clarke Central High School", "high", 5, "listing-associated"],
  ]);
  assert.deepEqual(schools.map((school) => school.distanceMiles), [0.5, 2, 3.6]);
});

test("extracts Realtor circle ratings when school names are markdown links", () => {
  const schools = extractSchoolEvidence(`
    7 10 7 out of 10
    [Timothy Elementary School](https://www.realtor.com/local/schools/Timothy-Elementary-School-1)
    Grades K-5
    4 10 4 out of 10
    [Clarke Middle School](https://www.realtor.com/local/schools/Clarke-Middle-School-2)
    Grades 6-8
    5 10 5 out of 10
    [Clarke Central High School](https://www.realtor.com/local/schools/Clarke-Central-High-School-3)
    Grades 9-12
  `, "https://www.realtor.com/realestateandhomes-detail/example");

  assert.deepEqual(schools.map((school) => [school.name, school.rating, school.type]), [
    ["Timothy Elementary School", 7, "elementary"],
    ["Clarke Middle School", 4, "middle"],
    ["Clarke Central High School", 5, "high"],
  ]);
});

test("extracts all Portland school cards when a school name has no level word", () => {
  const listingUrl = "https://www.realtor.com/realestateandhomes-detail/40-Webb-St_Portland_ME_04102_M35641-79717";
  const schools = extractSchoolEvidence(`
    ## Schools
    From listing agent
    High School District: Portland Public Schools
    School District: Portland Public Schools
    Nearby schools Elementary Middle High Private
    4 10 4 out of 10
    [Button: Amanda C Rowe School]
    Grades K-5 | 1.1 mi away | 414 students | 8 reviews
    6 10 6 out of 10
    [Lincoln Middle School](https://www.realtor.com/local/schools/Lincoln-Middle-School-0732860561)
    Grades 6-8 | 1.8 mi away | 501 students | 12 reviews
    2 10 2 out of 10
    [Button: Deering High School]
    Grades 9-12 | 2.0 mi away | 749 students | 7 reviews
    Contact the school or district directly to verify enrollment eligibility.
  `, listingUrl);

  assert.deepEqual(schools.map((school) => [school.name, school.rating, school.type, school.grades]), [
    ["Amanda C Rowe School", 4, "elementary", "K-5"],
    ["Lincoln Middle School", 6, "middle", "6-8"],
    ["Deering High School", 2, "high", "9-12"],
  ]);
  assert.ok(schools.every((school) => school.relationship === "listing-associated"));
  assert.equal(schools[0]?.sourceUrl, listingUrl);
  assert.match(schools[1]?.sourceUrl || "", /Lincoln-Middle-School/);
});

test("keeps school panel evidence isolated to its own listing", () => {
  const first = extractSchoolEvidence(`
    ## Schools
    4 10 4 out of 10 [Button: Amanda C Rowe School] Grades K-5
    6 10 6 out of 10 [Button: Lincoln Middle School] Grades 6-8
    2 10 2 out of 10 [Button: Deering High School] Grades 9-12
  `, "https://www.realtor.com/realestateandhomes-detail/40-Webb-St");
  const second = extractSchoolEvidence(`
    ## Schools
    8 10 8 out of 10 [Button: Different Academy] Grades K-5
    7 10 7 out of 10 [Button: Other Middle School] Grades 6-8
    9 10 9 out of 10 [Button: Other High School] Grades 9-12
  `, "https://www.realtor.com/realestateandhomes-detail/1-Other-St");

  assert.deepEqual(first.map((school) => school.name), [
    "Amanda C Rowe School", "Lincoln Middle School", "Deering High School",
  ]);
  assert.deepEqual(second.map((school) => school.name), [
    "Different Academy", "Other Middle School", "Other High School",
  ]);
  assert.ok(first.every((school) => /40-Webb-St/.test(school.assignmentSourceUrl || "")));
  assert.ok(second.every((school) => /1-Other-St/.test(school.assignmentSourceUrl || "")));
});

test("classifies the complete 40 Webb Portland panel as failed instead of unresolved", () => {
  const listingUrl = "https://www.realtor.com/realestateandhomes-detail/40-Webb-St_Portland_ME_04102_M35641-79717";
  const schools = extractSchoolEvidence(`
    ## Schools
    4 10 4 out of 10 [Button: Amanda C Rowe School] Grades K-5
    6 10 6 out of 10 [Button: Lincoln Middle School] Grades 6-8
    2 10 2 out of 10 [Button: Deering High School] Grades 9-12
  `, listingUrl);
  const match = assessProperty({
    id: "portland-40-webb",
    title: "40 Webb St, Portland, ME 04102",
    price: 399000,
    bedrooms: 1,
    bathrooms: 1,
    sqft: 721,
    location: "Portland, ME 04102",
    features: [],
    url: listingUrl,
    listedAt: new Date().toISOString(),
    source: "Realtor.com",
    schools,
  }, {
    ...defaultSearchCriteria(),
    location: "Portland, ME",
    schoolMinRating: 5,
    schoolAtLeastOneRating: 8,
    schoolAssignmentRequired: true,
  });

  assert.equal(match.overall, "failed");
  assert.equal(match.checks.find((check) => /K-12 schools/.test(check.criterion))?.status, "failed");
});

test("extracts property-associated schools from Realtor's server-rendered nearby-school links", () => {
  const content = `The schools near 1080 Belmont Rd, include
    [Whit Davis Road Elementary School](https://www.realtor.com/local/schools/Whit-Davis-Road-Elementary-School-0718577561),
    [Cedar Shoals High School](https://www.realtor.com/local/schools/Cedar-Shoals-High-School-0718577431) and
    [Hilsman Middle School](https://www.realtor.com/local/schools/Hilsman-Middle-School-0718577401).
    Nearby Cities`;
  const schools = extractSchoolEvidence(content, "https://www.realtor.com/example", "realtor-listing");
  assert.deepEqual(schools.map((school) => [school.name, school.type, school.relationship]), [
    ["Whit Davis Road Elementary School", "elementary", "listing-associated"],
    ["Cedar Shoals High School", "high", "listing-associated"],
    ["Hilsman Middle School", "middle", "listing-associated"],
  ]);
  assert.deepEqual(schools.map((school) => school.sourceUrl), [
    "https://www.realtor.com/local/schools/Whit-Davis-Road-Elementary-School-0718577561",
    "https://www.realtor.com/local/schools/Cedar-Shoals-High-School-0718577431",
    "https://www.realtor.com/local/schools/Hilsman-Middle-School-0718577401",
  ]);
  assert.ok(schools.every((school) => school.assignmentSourceUrl === "https://www.realtor.com/example"));
});

test("uses property-linked Realtor school pages without a broad school search", async () => {
  const requestedUrls: string[] = [];
  const mockFetch = (async (input: string | URL, init?: RequestInit) => {
    assert.match(String(input), /\/v2\/scrape$/);
    const body = JSON.parse(String(init?.body || "{}"));
    requestedUrls.push(body.url);
    const rating = /Elementary/.test(body.url) ? 7 : /Middle/.test(body.url) ? 4 : 5;
    const name = /Elementary/.test(body.url)
      ? "Timothy Elementary School"
      : /Middle/.test(body.url) ? "Clarke Middle School" : "Clarke Central High School";
    return new Response(JSON.stringify({
      data: { markdown: `# ${name}\n${rating} out of 10\nGreatSchools Rating\nParent Rating` },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const listingUrl = "https://www.realtor.com/realestateandhomes-detail/320-Kings-Rd";
  const schools = extractSchoolEvidence(`The schools near 320 Kings Rd include
    [Timothy Elementary School](https://www.realtor.com/local/schools/Timothy-Elementary-School-1),
    [Clarke Middle School](https://www.realtor.com/local/schools/Clarke-Middle-School-2) and
    [Clarke Central High School](https://www.realtor.com/local/schools/Clarke-Central-High-School-3).
    Nearby Cities`, listingUrl);
  const property = {
    id: "p1", title: "320 Kings Rd, Athens, GA 30606", price: 375000, bedrooms: 4, bathrooms: 2, sqft: 1985,
    location: "Athens, GA 30606", features: [], url: listingUrl, listedAt: new Date().toISOString(),
    source: "realtor.com", schools,
  };

  const result = await new SchoolRatingService("test-key", mockFetch, "")
    .enrichProperty(property, "Athens, GA", { strictAssignment: true });

  assert.deepEqual(result.schools?.map((school) => [school.name, school.rating, school.relationship]), [
    ["Timothy Elementary School", 7, "listing-associated"],
    ["Clarke Middle School", 4, "listing-associated"],
    ["Clarke Central High School", 5, "listing-associated"],
  ]);
  assert.equal(requestedUrls.length, 3);
  assert.ok(requestedUrls.every((url) => /realtor\.com\/local\/schools\//.test(url)));
});

test("recursively extracts complete schools from nested Realtor page JSON", () => {
  const content = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { property: { neighborhood: { schools: [
      {
        name: "Whitehead Road Elementary School", rating: { value: 6 }, grades: "K-5",
        distance_in_miles: 0.5, student_count: 601, review_count: 14,
        href: "/local/schools/Whitehead-Road-Elementary-School-0001",
      },
      {
        school_name: "Burney-Harris-Lyons Middle School", greatSchoolsRating: 7,
        grade_levels: ["6", "8"], distanceMiles: "2.0 mi", students: "647", reviews: 11,
      },
      {
        schoolName: "Clarke Central High School", gsRating: { score: 5 }, gradesServed: "9-12",
        distance_miles: 3.6, enrollment: 1909, reviewCount: 2,
      },
      { name: "Clarke County School District", rating: 10 },
    ] } } } },
  })}</script>`;

  const schools = extractSchoolEvidence(content, "https://www.realtor.com/realestateandhomes-detail/example");

  assert.equal(schools.length, 3);
  assert.deepEqual(schools.map((school) => [school.name, school.rating, school.type]), [
    ["Whitehead Road Elementary School", 6, "elementary"],
    ["Burney-Harris-Lyons Middle School", 7, "middle"],
    ["Clarke Central High School", 5, "high"],
  ]);
  assert.deepEqual(
    schools.map((school) => [school.grades, school.distanceMiles, school.studentCount, school.reviewCount]),
    [["K-5", 0.5, 601, 14], ["6-8", 2, 647, 11], ["9-12", 3.6, 1909, 2]],
  );
  assert.ok(schools.every((school) => school.relationship === "listing-associated"));
});

test("recovers school arrays embedded in escaped Next.js flight payloads", () => {
  const payload = JSON.stringify({ schools: [{
    name: "Example Elementary School", rating: 8, grades: "PK-5", distance_in_miles: 1.25,
  }] }).replace(/"/g, '\\"');
  const content = `<script>self.__next_f.push([1,"${payload}"])</script>`;
  const schools = extractSchoolEvidence(content, "https://www.realtor.com/realestateandhomes-detail/example");
  assert.deepEqual(schools.map((school) => [school.name, school.rating, school.grades, school.distanceMiles]), [
    ["Example Elementary School", 8, "PK-5", 1.25],
  ]);
});

test("targeted Firecrawl lookup is domain-limited and cached", async () => {
  let calls = 0;
  const mockFetch = (async (_url: string, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    if (String(_url).endsWith("/v2/scrape")) {
      return new Response(JSON.stringify({ data: { markdown: "# Clarke Central High School\n5/10 GreatSchools Rating\n## Nearby Schools\n4/10 Other School" } }), { status: 200 });
    }
    assert.deepEqual(body.includeDomains, ["realtor.com", "greatschools.org"]);
    return new Response(JSON.stringify({
      data: { web: [{
        title: "Homes for Sale near Clarke Central High School",
        description: "Clarke Central High School, Athens, GA - possibly stale rating",
        markdown: "# Clarke Central High School\nAthens, GA\n5/10 GreatSchools Rating\n## Nearby Schools\n4/10 Other School",
        url: "https://www.realtor.com/local/schools/Clarke-Central-High-School-0718577361",
      }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const service = new SchoolRatingService("test-key", mockFetch);

  const first = await service.lookupSchool("Clarke Central High School", "Athens, GA");
  const second = await service.lookupSchool("Clarke Central High School", "Athens, GA");
  assert.equal(first[0]?.name, "Clarke Central High School");
  assert.equal(first[0]?.rating, 5);
  assert.equal(second[0]?.sourceUrl.includes("greatschools.org"), true);
  assert.equal(calls, 1);
});

test("does not attribute a district ranking or nearby-school score to the requested school", async () => {
  const mockFetch = (async (input: string | URL) => new Response(JSON.stringify(String(input).endsWith("/v2/scrape") ? {
    data: { markdown: "# Burney-Harris-Lyons Middle School\n7/10 GreatSchools Rating\n## Nearby Schools\n4/10 Cleveland Road Elementary School" },
  } : {
    data: { web: [
      {
        title: "Best Middle Schools in Clarke County School District",
        description: "Burney-Harris-Lyons Middle School appears in this district. Top school: 9/10 GreatSchools Rating.",
        url: "https://www.greatschools.org/best-middle-schools/georgia/athens/clarke-county-school-district/",
      },
      {
        title: "Burney-Harris-Lyons Middle School",
        description: "Burney-Harris-Lyons Middle School, Athens, GA. 7/10 GreatSchools Rating.",
        url: "https://www.greatschools.org/georgia/athens/424-Burney-Harris-Lyons-Middle-School/",
      },
    ] },
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  const service = new SchoolRatingService("test-key", mockFetch);

  const result = await service.lookupSchool("Burney-Harris-Lyons Middle School", "Athens, GA");

  assert.equal(result.length, 1);
  assert.equal(result[0]?.rating, 7);
  assert.match(result[0]?.sourceUrl || "", /\/424-Burney-Harris-Lyons-Middle-School\/?$/);
});

test("resolves known official-name aliases without changing the assigned school name", async () => {
  let requestedUrl = "";
  const mockFetch = (async (_input: string | URL, init?: RequestInit) => {
    requestedUrl = String(JSON.parse(String(init?.body || "{}")).url || "");
    return new Response(JSON.stringify({ data: {
      markdown: "# Whit Davis Road Elementary School\nAthens, GA\n5/10 GreatSchools Rating",
    } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const result = await new SchoolRatingService("test-key", mockFetch).lookupSchool("Whit Davis Elementary School", "Athens, GA");

  assert.match(requestedUrl, /431-Whit-Davis-Road-Elementary-School/);
  assert.equal(result[0]?.name, "Whit Davis Elementary School");
  assert.equal(result[0]?.rating, 5);
});

test("target school rating extraction stops before nearby schools", () => {
  assert.equal(extractTargetSchoolRating(
    "# Burney-Harris-Lyons Middle School\n## Nearby Schools\n4/10 GreatSchools Rating Cleveland Road Elementary",
    "Burney-Harris-Lyons Middle School",
  ), undefined);
  assert.equal(extractTargetSchoolRating(
    "# Clarke Central High School\n5/10 GreatSchools Rating\n## Nearby Schools\n4/10 Other School",
    "Clarke Central High School",
  ), 5);
  assert.equal(extractTargetSchoolRating(
    `# Timothy Elementary School\n${"Profile details without a score. ".repeat(60)}8/10 GreatSchools Rating\nOconee County Elementary School`,
    "Timothy Elementary School",
  ), undefined);
  assert.equal(extractTargetSchoolRating(
    `# Timothy Elementary School\n7/10 GreatSchools Rating\n${"More profile details. ".repeat(100)}8/10 GreatSchools Rating\nNearby School`,
    "Timothy Elementary School",
  ), 7);
});

test("parses the rating formats used by Realtor and GreatSchools pages", () => {
  assert.equal(extractGreatSchoolsRating("6 out of 10 GreatSchools Rating"), 6);
  assert.equal(extractGreatSchoolsRating("Clarke Middle School 5/10 GreatSchools Rating"), 5);
  assert.equal(extractGreatSchoolsRating("GreatSchools Rating: 8/10"), 8);
  assert.equal(extractGreatSchoolsRating("Parent review: 10 out of 10"), undefined);
});

test("strict mode rejects school evidence from a non-exact Realtor property result", async () => {
  let calls = 0;
  const mockFetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: { web: [{
      title: "2 Other St, Athens, GA 30606",
      url: "https://www.realtor.com/realestateandhomes-detail/2-Other-St_Athens_GA_30606",
      description: "8/10 Other Elementary School",
    }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const service = new SchoolRatingService("test-key", mockFetch, "");
  const property = {
    id: "p1", title: "1 Missing St, Athens, GA", price: 1, bedrooms: 1, bathrooms: 1, sqft: 1,
    location: "Athens, GA", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  };

  const enriched = await service.enrichProperty(property, "Athens, GA", { strictAssignment: true });

  assert.equal(calls, 1);
  assert.equal(enriched.schools?.length || 0, 0);
});

test("strict mode accepts complete ratings from an exact Realtor property result", async () => {
  const mockFetch = (async () => new Response(JSON.stringify({ data: { web: [{
    title: "1 Main St, Athens, GA 30606",
    url: "https://www.realtor.com/realestateandhomes-detail/1-Main-St_Athens_GA_30606",
    markdown: `Schools
      8 10 8 out of 10 Example Elementary School Grades K-5
      6 10 6 out of 10 Example Middle School Grades 6-8
      5 10 5 out of 10 Example High School Grades 9-12`,
  }] } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  const service = new SchoolRatingService("test-key", mockFetch, "");
  const property = {
    id: "p1", title: "1 Main St, Athens, GA 30606", price: 1, bedrooms: 1, bathrooms: 1, sqft: 1,
    location: "Athens, GA 30606", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  };

  const enriched = await service.enrichProperty(property, "Athens, GA", { strictAssignment: true });

  assert.deepEqual(enriched.schools?.map((school) => [school.type, school.rating, school.relationship]), [
    ["elementary", 8, "listing-associated"], ["middle", 6, "listing-associated"], ["high", 5, "listing-associated"],
  ]);
});

test("persists school ratings across service restarts", async () => {
  let calls = 0;
  const mockFetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: {
      markdown: "# Clarke Middle School\nAthens, GA\n4/10 GreatSchools Rating",
    } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const cacheFile = join(mkdtempSync(join(tmpdir(), "school-cache-")), "ratings.json");

  const first = await new SchoolRatingService("test-key", mockFetch, cacheFile)
    .lookupSchool("Clarke Middle School", "Athens, GA");
  const second = await new SchoolRatingService("test-key", mockFetch, cacheFile)
    .lookupSchool("Clarke Middle School", "Athens, GA");

  assert.equal(first[0]?.rating, 4);
  assert.equal(second[0]?.rating, 4);
  assert.equal(calls, 1);
});
