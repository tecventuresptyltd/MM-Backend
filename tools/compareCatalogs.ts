import * as fs from 'fs';
import * as path from 'path';

const seedsDir = path.join(__dirname, '..', 'seeds', 'Atul-Final-Seeds');
const carsCatalogPath = path.join(seedsDir, 'CarsCatalog.json');
const tiersCatalogPath = path.join(seedsDir, 'TiersCatalog.json');

const carsCatalog = JSON.parse(fs.readFileSync(carsCatalogPath, 'utf8'));
const tiersCatalog = JSON.parse(fs.readFileSync(tiersCatalogPath, 'utf8'));

console.log('--- COMPARING TIERS AND CARS CATALOGS ---');

const ARCHETYPE_MAP: Record<string, string> = {
  'tank': 'guardian',
  'speedster': 'phantom',
  'specialist': 'arcanist'
};

for (const [tierId, tier] of Object.entries(tiersCatalog.tiers) as any) {
  console.log(`\n=================== ${tier.displayName} (${tierId}) ===================`);
  for (const bundledCar of tier.bundledCars) {
    const carId = bundledCar.carId;
    const car = carsCatalog.cars[carId];
    if (!car) {
      console.log(`❌ Car ${carId} (${bundledCar.displayName}) in TiersCatalog not found in CarsCatalog!`);
      continue;
    }

    const expectedArchetype = ARCHETYPE_MAP[car.archetype] || car.archetype;
    const actualArchetype = bundledCar.archetype;

    const namesMatch = car.i18n.en === bundledCar.displayName;
    const archetypesMatch = expectedArchetype === actualArchetype;
    const tiersMatch = car.tier === tier.order;

    console.log(`Car ID: ${carId}`);
    console.log(`  Name in TiersCatalog: "${bundledCar.displayName}"`);
    console.log(`  Name in CarsCatalog (i18n.en): "${car.i18n.en}" | (displayName): "${car.displayName}"`);
    console.log(`  Names Match: ${namesMatch ? '✅' : '❌ DELTA'}`);
    console.log(`  Archetype in TiersCatalog: "${actualArchetype}"`);
    console.log(`  Archetype in CarsCatalog: "${car.archetype}" (maps to "${expectedArchetype}")`);
    console.log(`  Archetypes Match: ${archetypesMatch ? '✅' : '❌ DELTA'}`);
    console.log(`  Tier in TiersCatalog: ${tier.order}`);
    console.log(`  Tier in CarsCatalog: ${car.tier}`);
    console.log(`  Tiers Match: ${tiersMatch ? '✅' : '❌ DELTA'}`);

    const lvl1 = car.levels['1'];
    const sum = lvl1.topSpeed + lvl1.acceleration + lvl1.handling + lvl1.boostRegen + lvl1.boostPower;
    console.log(`  Level 1 Stats: topSpeed=${lvl1.topSpeed}, acceleration=${lvl1.acceleration}, handling=${lvl1.handling}, boostRegen=${lvl1.boostRegen}, boostPower=${lvl1.boostPower}`);
    console.log(`  Level 1 Stats Sum: ${sum}`);
  }
}

process.exit(0);
