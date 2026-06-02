import * as fs from 'fs';

const carsCatalog = JSON.parse(fs.readFileSync('seeds/Atul-Final-Seeds/CarsCatalog.json', 'utf8'));

const EXPECTED_TIER_FLOORS: Record<number, number> = {
  1: 5.0,
  2: 13.5,
  3: 22.0,
  4: 30.5,
  5: 39.0
};

console.log('--- STARTING VALIDATION ---');
let errors = 0;

for (const [id, car] of Object.entries(carsCatalog.cars) as any) {
  const tier = car.tier;
  const l1 = car.levels['1'];
  if (!l1) {
    console.error(`❌ Car ${id} (${car.displayName || car.i18n?.en}) has no Level 1 data!`);
    errors++;
    continue;
  }

  const sum = l1.topSpeed + l1.acceleration + l1.handling + l1.boostRegen + l1.boostPower;
  const roundedSum = Math.round(sum * 100) / 100;
  const expectedFloor = EXPECTED_TIER_FLOORS[tier];

  if (roundedSum !== expectedFloor) {
    console.error(`❌ Car ${id} (${car.i18n?.en || car.displayName}) Tier ${tier} Level 1 stats sum to ${roundedSum}, expected ${expectedFloor}!`);
    errors++;
  } else {
    console.log(`✅ Car ${id} (${car.i18n?.en || car.displayName}) Tier ${tier} Level 1 stats sum to exactly ${expectedFloor}`);
  }
}

if (errors > 0) {
  console.error(`\n❌ Validation failed with ${errors} error(s)!`);
  process.exit(1);
} else {
  console.log('\n✅ All catalogs validated successfully! Level 1 stats are perfectly balanced across all tiers!');
  process.exit(0);
}
