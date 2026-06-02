const fs = require('fs');

const normalizedPath = 'seeds/Atul-Final-Seeds/gameDataCatalogs.v3.normalized.json';
const carsCatalogPath = 'seeds/Atul-Final-Seeds/CarsCatalog.json';

const normalized = JSON.parse(fs.readFileSync(normalizedPath, 'utf8'));
const carsCatalog = JSON.parse(fs.readFileSync(carsCatalogPath, 'utf8'));

let found = false;
for (const entry of normalized) {
  if (entry.path === '/GameData/v1/catalogs/CarsCatalog') {
    entry.data = carsCatalog;
    found = true;
    break;
  }
}

if (!found) {
  console.error('CarsCatalog not found in normalized catalog!');
  process.exit(1);
}

fs.writeFileSync(normalizedPath, JSON.stringify(normalized, null, 2));
console.log('✅ gameDataCatalogs.v3.normalized.json successfully updated with new CarsCatalog!');
