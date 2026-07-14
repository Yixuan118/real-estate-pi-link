import { firecrawlSkill } from './backend/src/skills/firecrawl-skill.ts';

const criteria = {
  location: "Seattle",
  maxPrice: 1000000,
  minBedrooms: 3,
  propertyType: "house",
  mustHave: [],
  updatedAt: new Date().toISOString()
};

const result = await firecrawlSkill.searchProperties(criteria);
console.log(JSON.stringify(result, null, 2));
