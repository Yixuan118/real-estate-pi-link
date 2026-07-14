import { firecrawlSkill } from './backend/src/skills/firecrawl-skill';

async function main() {
  const criteria = {
    location: "Seattle",
    maxPrice: 1000000,
    minBedrooms: 3,
    propertyType: "house",
    mustHave: [],
    updatedAt: new Date().toISOString()
  };

  const result = await firecrawlSkill.searchProperties(criteria);
  process.stdout.write(JSON.stringify(result));
}

main().catch(e => process.stderr.write(e.message));
