const fs = require('fs');

const nameMap = {
  'offer_adrenaline_pro': 'com.tecventures.mysticmotors.exotic.surge',
  'offer_resource_rush': 'com.tecventures.mysticmotors.gold.flood',
  'offer_mythic_mystery': 'com.tecventures.mysticmotors.fortune.vault',
  'offer_double_clutch': 'com.tecventures.mysticmotors.weekend.circuit',
  'offer_ignition_starter': 'com.tecventures.mysticmotors.gem.ignition',
  'offer_fuel_emergency': 'com.tecventures.mysticmotors.fuel.surge',
  'offer_nitro_surge': 'com.tecventures.mysticmotors.rare.rush',
  'offer_adrenaline_shot': 'com.tecventures.mysticmotors.rare.storm',
  'offer_sprint_starter': 'com.tecventures.mysticmotors.spark.cache',
  'offer_midnight_oil': 'com.tecventures.mysticmotors.night.shift',
  'offer_nitro_boost_plus': 'com.tecventures.mysticmotors.shard.strike',
  'offer_pit_stop_special': 'com.tecventures.mysticmotors.turbo.cache',
  'offer_pro_crew_kit': 'com.tecventures.mysticmotors.legendary.haul',
  'offer_street_legend': 'com.tecventures.mysticmotors.legend.surge',
  'offer_pro_circuit_pack': 'com.tecventures.mysticmotors.grand.circuit',
  'offer_lvl10_milestone': 'com.tecventures.mysticmotors.mastery.surge',
  'offer_lvl20_milestone': 'com.tecventures.mysticmotors.horizon.cache',
  'offer_lvl50_milestone': 'com.tecventures.mysticmotors.apex.vault',
  'offer_mechanics_choice': 'com.tecventures.mysticmotors.garage.circuit',
  'offer_drift_king': 'com.tecventures.mysticmotors.exotic.edge',
  'offer_fast_lane_pack': 'com.tecventures.mysticmotors.speed.vault',
  'offer_weekend_warrior': 'com.tecventures.mysticmotors.exotic.storm',
  'offer_tuners_vault': 'com.tecventures.mysticmotors.legendary.edge',
  'offer_drift_king_upsell': 'com.tecventures.mysticmotors.flash.circuit',
  'offer_the_collector': 'com.tecventures.mysticmotors.mythic.trove',
  'offer_elite_engineer': 'com.tecventures.mysticmotors.legendary.vault',
  'offer_garage_overhaul': 'com.tecventures.mysticmotors.garage.gods',
  'offer_grand_prix_hoard': 'com.tecventures.mysticmotors.grand.haul',
  'offer_the_sovereign': 'com.tecventures.mysticmotors.sovereign.cache',
  'offer_championship_kit': 'com.tecventures.mysticmotors.champions.vault',
};

const csvPath = 'tools/offers_breakdown.csv';
const lines = fs.readFileSync(csvPath, 'utf8').split('\n');

for (let i = 0; i < lines.length; i++) {
  let row = lines[i];
  if (!row.trim()) continue;
  
  // Replace references in the whole row (both the primary ID and any upsell_offer_id references)
  for (const [oldId, newId] of Object.entries(nameMap)) {
    row = row.replace(new RegExp(oldId, 'g'), newId);
  }
  lines[i] = row;
}

fs.writeFileSync(csvPath, lines.join('\n'));
console.log('✅ Updated CSV with new Product IDs!');
