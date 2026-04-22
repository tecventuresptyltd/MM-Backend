import * as fs from 'fs';
import * as path from 'path';

const seedsDir = path.join(__dirname, '../seeds/Atul-Final-Seeds');
const itemsCatalogPath = path.join(seedsDir, 'ItemsCatalog.json');
const skusCatalogPath = path.join(seedsDir, 'ItemSkusCatalog.json');
const normalizedPath = path.join(seedsDir, 'gameDataCatalogs.v3.normalized.json');

const generateRandomId = (prefix: string, length = 10) => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = prefix;
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// If there are existing manually added shards, remove them first
const removeManuallyAddedShards = (items: any, skus: any) => {
  if (items) delete items['curr_spell_shards'];
  if (skus) {
    ['sku_shrd_50_pkg', 'sku_shrd_100_pkg', 'sku_shrd_500_pkg', 'sku_shrd_1000_pkg'].forEach(id => {
      delete skus[id];
    });
  }
};

const itemsCatalog = JSON.parse(fs.readFileSync(itemsCatalogPath, 'utf8'));
const skusCatalog = JSON.parse(fs.readFileSync(skusCatalogPath, 'utf8'));
const normalizedCatalog = JSON.parse(fs.readFileSync(normalizedPath, 'utf8'));

removeManuallyAddedShards(itemsCatalog.items, skusCatalog.skus);

const shardPacks = [
  { amount: 50, price: 10 },
  { amount: 100, price: 20 },
  { amount: 500, price: 100 },
  { amount: 1000, price: 200 },
];

const newItemId = generateRandomId('curr_');

const generatedSkus = shardPacks.map(p => ({
  ...p,
  skuId: generateRandomId('sku_')
}));

const itemEntry = {
  itemId: newItemId,
  displayName: "Spell Shards",
  category: "currency",
  type: "currency",
  rarity: "common",
  stackable: true,
  purchasable: true,
  metadata: {
    currency: "spellShards"
  },
  variants: generatedSkus.map(p => ({
    skuId: p.skuId,
    displayName: `${p.amount} Shards`,
    rarity: "common",
    stackable: true,
    purchasable: true,
    gemPrice: p.price,
    subType: "shard",
    variant: {
      shardAmount: p.amount
    }
  }))
};

itemsCatalog.items[newItemId] = itemEntry;

for (const p of generatedSkus) {
  skusCatalog.skus[p.skuId] = {
    skuId: p.skuId,
    itemId: newItemId,
    displayName: `${p.amount} Shards`,
    category: "currency",
    type: "currency",
    rarity: "common",
    stackable: true,
    subType: "shard",
    purchasable: {
      currency: "gems",
      amount: p.price
    },
    metadata: {
      currency: "spellShards"
    },
    variant: {
      shardAmount: p.amount
    },
    gemPrice: p.price,
    durationSeconds: null
  };
}

// Update normalized catalog
for (const entry of normalizedCatalog) {
  if (entry.path === '/GameData/v1/catalogs/ItemsCatalog') {
    removeManuallyAddedShards(entry.data.items, null);
    entry.data.items[newItemId] = itemEntry;
  } else if (entry.path === '/GameData/v1/catalogs/ItemSkusCatalog') {
    removeManuallyAddedShards(null, entry.data.skus);
    for (const p of generatedSkus) {
      entry.data.skus[p.skuId] = skusCatalog.skus[p.skuId];
    }
  }
}

fs.writeFileSync(itemsCatalogPath, JSON.stringify(itemsCatalog, null, 2));
fs.writeFileSync(skusCatalogPath, JSON.stringify(skusCatalog, null, 2));
fs.writeFileSync(normalizedPath, JSON.stringify(normalizedCatalog, null, 2));

console.log("Catalogs updated successfully with random SKUs!");
