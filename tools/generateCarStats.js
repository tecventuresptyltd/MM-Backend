const fs = require('fs');

const carsCatalogPath = 'seeds/Atul-Final-Seeds/CarsCatalog.json';
const data = JSON.parse(fs.readFileSync(carsCatalogPath, 'utf8'));

// Budget totals for Level 1 stats
const TIER_BUDGETS = {
  1: 5.0,
  2: 13.75,
  3: 22.5,
  4: 31.25,
  5: 40.0
};

// Percentage split for each archetype
const ARCHETYPES = {
  speedster: { topSpeed: 0.30, acceleration: 0.25, handling: 0.15, boostRegen: 0.10, boostPower: 0.20 },
  tank:      { topSpeed: 0.15, acceleration: 0.15, handling: 0.25, boostRegen: 0.25, boostPower: 0.20 },
  specialist:{ topSpeed: 0.20, acceleration: 0.20, handling: 0.20, boostRegen: 0.20, boostPower: 0.20 }
};

const CAR_MAPPING = {
  // T1
  'car_h4ayzwf31g': { tier: 1, archetype: 'tank' },
  'car_1wp1gr2p': { tier: 1, archetype: 'speedster' },
  'car_4bbp20vv': { tier: 1, archetype: 'specialist' },
  // T2
  'car_3n27817s': { tier: 2, archetype: 'tank' },
  'car_xtm9htbs': { tier: 2, archetype: 'speedster' },
  'car_a9x2mkp3': { tier: 2, archetype: 'specialist' },
  // T3
  'car_jh5tqxqk': { tier: 3, archetype: 'tank' },
  'car_0yhea29t': { tier: 3, archetype: 'speedster' },
  'car_p4n7mm2z': { tier: 3, archetype: 'specialist' },
  // T4
  'car_8m8qttmy': { tier: 4, archetype: 'tank' },
  'car_rqjrt91b': { tier: 4, archetype: 'speedster' },
  'car_kztq00ve': { tier: 4, archetype: 'specialist' },
  // T5
  'car_d2ap3yms': { tier: 5, archetype: 'tank' },
  'car_enmdcw5t': { tier: 5, archetype: 'speedster' },
  'car_2n5hnes4': { tier: 5, archetype: 'specialist' }
};

for (const [id, mapping] of Object.entries(CAR_MAPPING)) {
  const car = data.cars[id];
  if (!car) continue;

  car.tier = mapping.tier;
  car.archetype = mapping.archetype;
  
  // Set class tag for the client matching our archetype name
  car.class = mapping.archetype;

  const budget = TIER_BUDGETS[mapping.tier];
  const modifiers = ARCHETYPES[mapping.archetype];

  // Flat additive growth per level per stat (User requested +2.0 max by level 10)
  // There are 9 upgrades from Level 1 to Level 10, so +2.0 / 9 = ~0.222 per level
  const totalGrowth = 2.0;
  const levelsCount = Object.keys(car.levels).length; // Usually 10
  const incrementPerLevel = totalGrowth / (levelsCount - 1); 

  // Calculate base stats (Level 1)
  const baseStats = {
    topSpeed: budget * modifiers.topSpeed,
    acceleration: budget * modifiers.acceleration,
    handling: budget * modifiers.handling,
    boostRegen: budget * modifiers.boostRegen,
    boostPower: budget * modifiers.boostPower
  };

  for (let levelStr of Object.keys(car.levels)) {
    const levelInt = parseInt(levelStr, 10);
    const flatBonus = incrementPerLevel * (levelInt - 1);

    car.levels[levelStr].topSpeed = parseFloat((baseStats.topSpeed + flatBonus).toFixed(2));
    car.levels[levelStr].acceleration = parseFloat((baseStats.acceleration + flatBonus).toFixed(2));
    car.levels[levelStr].handling = parseFloat((baseStats.handling + flatBonus).toFixed(2));
    car.levels[levelStr].boostRegen = parseFloat((baseStats.boostRegen + flatBonus).toFixed(2));
    car.levels[levelStr].boostPower = parseFloat((baseStats.boostPower + flatBonus).toFixed(2));
  }
}

// Write the file back
fs.writeFileSync(carsCatalogPath, JSON.stringify(data, null, 4));
console.log('✅ CarsCatalog.json updated with flat +2.0 scaled stats!');
