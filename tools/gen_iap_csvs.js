const fs = require('fs');
const csv = fs.readFileSync('tools/offers_breakdown.csv', 'utf8');
const lines = csv.split('\n');

let play = 'Product ID,Name,Description,Price (USD)\n';
let app = 'Reference Name,Product ID,Type,Price (USD),Display Name,Description\n';

for (let i = 1; i < lines.length; i++) {
  const row = lines[i].split(',');
  if (!row[0] || !row[1]) continue;
  const id = row[0].trim();
  const name = row[1].trim();
  const price = (row[4] || '').replace('$', '').trim();
  if (!price) continue;

  const productId = 'io.tecventures.mysticmotors.iap.' + id;
  const desc = name + ' - Special Offer';

  play += productId + ',' + name + ',' + desc + ',' + price + '\n';
  app += name + ',' + productId + ',Consumable,' + price + ',' + name + ',' + desc + '\n';
}

fs.writeFileSync('tools/IAP_PlayStore.csv', play);
fs.writeFileSync('tools/IAP_AppStore.csv', app);
console.log('Done! Created tools/IAP_PlayStore.csv and tools/IAP_AppStore.csv');
