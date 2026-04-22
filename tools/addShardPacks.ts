import * as fs from 'fs';
import * as path from 'path';

const seedsDir = path.join(__dirname, '../seeds/Atul-Final-Seeds');
const itemsCatalogPath = path.join(seedsDir, 'ItemsCatalog.json');
const skusCatalogPath = path.join(seedsDir, 'ItemSkusCatalog.json');

const itemsCatalog = JSON.parse(fs.readFileSync(itemsCatalogPath, 'utf8'));
const skusCatalog = JSON.parse(fs.readFileSync(skusCatalogPath, 'utf8'));

const shardPacks = [
  { amount: 50, price: 10, skuId: 'sku_shrd_50_pkg' },
  { amount: 100, price: 20, skuId: 'sku_shrd_100_pkg' },
  { amount: 500, price: 100, skuId: 'sku_shrd_500_pkg' },
  { amount: 1000, price: 200, skuId: 'sku_shrd_1000_pkg' },
];

const newItemId = 'curr_spell_shards';

itemsCatalog.items[newItemId] = {
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
  variants: shardPacks.map(p => ({
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

for (const p of shardPacks) {
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

fs.writeFileSync(itemsCatalogPath, JSON.stringify(itemsCatalog, null, 2));
fs.writeFileSync(skusCatalogPath, JSON.stringify(skusCatalog, null, 2));

console.log("Catalogs updated successfully.");
