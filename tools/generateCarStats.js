const fs = require('fs');

const carsCatalogPath = 'seeds/Atul-Final-Seeds/CarsCatalog.json';
const budgetConfigPath = 'seeds/Atul-Final-Seeds/CarStatsBudgetConfig.json';

const carsData = JSON.parse(fs.readFileSync(carsCatalogPath, 'utf8'));
const budgetConfig = JSON.parse(fs.readFileSync(budgetConfigPath, 'utf8'));

const {
  globalFloor = 5.0,
  globalStatCap = 47.5,
  tierCount = 5,
  maxCarLevel = 10,
  maxStarLevel = 10,
  starWeight = 0.6,
  levelWeight = 0.4,
  archetypeProfiles
} = budgetConfig;

const CAR_MAPPING = {
  // T1
  'car_h4ayzwf31g': { tier: 1, archetype: 'guardian' },
  'car_1wp1gr2p': { tier: 1, archetype: 'phantom' },
  'car_4bbp20vv': { tier: 1, archetype: 'arcanist' },
  // T2
  'car_3n27817s': { tier: 2, archetype: 'guardian' },
  'car_xtm9htbs': { tier: 2, archetype: 'phantom' },
  'car_a9x2mkp3': { tier: 2, archetype: 'arcanist' },
  // T3
  'car_jh5tqxqk': { tier: 3, archetype: 'guardian' },
  'car_0yhea29t': { tier: 3, archetype: 'phantom' },
  'car_p4n7mm2z': { tier: 3, archetype: 'arcanist' },
  // T4
  'car_8m8qttmy': { tier: 4, archetype: 'guardian' },
  'car_rqjrt91b': { tier: 4, archetype: 'phantom' },
  'car_kztq00ve': { tier: 4, archetype: 'arcanist' },
  // T5
  'car_d2ap3yms': { tier: 5, archetype: 'guardian' },
  'car_enmdcw5t': { tier: 5, archetype: 'phantom' },
  'car_2n5hnes4': { tier: 5, archetype: 'arcanist' }
};

const budgetPerTier = (globalStatCap - globalFloor) / tierCount;

for (const [id, mapping] of Object.entries(CAR_MAPPING)) {
  const car = carsData.cars[id];
  if (!car) continue;

  car.tier = mapping.tier;
  car.archetype = mapping.archetype;
  car.class = mapping.archetype;

  const profile = archetypeProfiles[mapping.archetype];
  if (!profile) {
    console.error(`Missing profile for archetype: ${mapping.archetype}`);
    continue;
  }

  const tierFloor = globalFloor + (mapping.tier - 1) * budgetPerTier;

  for (let levelStr of Object.keys(car.levels)) {
    const levelInt = parseInt(levelStr, 10);
    const starProgress = maxStarLevel > 1 ? (levelInt - 1) / (maxStarLevel - 1) : 0;
    const levelProgress = maxCarLevel > 1 ? (levelInt - 1) / (maxCarLevel - 1) : 0;

    const starContribution = budgetPerTier * starWeight * starProgress;
    const levelContribution = budgetPerTier * levelWeight * levelProgress;
    const totalBudget = tierFloor + starContribution + levelContribution;

    const round2 = (n) => Math.round(n * 100) / 100;

    car.levels[levelStr].topSpeed = round2(totalBudget * profile.topSpeed);
    car.levels[levelStr].acceleration = round2(totalBudget * profile.acceleration);
    car.levels[levelStr].handling = round2(totalBudget * profile.handling);
    car.levels[levelStr].boostRegen = round2(totalBudget * profile.boostRegen);
    car.levels[levelStr].boostPower = round2(totalBudget * profile.boostPower);

    const avgStat = totalBudget / 5;
    car.levels[levelStr].carRating = Math.round(avgStat * 100);
  }
}

fs.writeFileSync(carsCatalogPath, JSON.stringify(carsData, null, 4));
console.log('✅ CarsCatalog.json updated dynamically from CarStatsBudgetConfig.json!');
