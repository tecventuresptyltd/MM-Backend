const fs = require('fs');
const csv = fs.readFileSync('tools/offers_breakdown.csv', 'utf8');
const lines = csv.split('\n');
let out = 'Product ID,Published State,Purchase Type,Auto Translate,Locale; Title; Description,Auto Fill Prices,Price\n';
for (let i = 1; i < lines.length; i++) {
  const row = lines[i].split(',');
  if (!row[0] || !row[1]) continue;
  const id = 'io.tecventures.mysticmotors.iap.' + row[0].trim();
  const title = row[1].trim();
  const priceRaw = (row[4] || '').replace('$', '').trim();
  if (!priceRaw) continue;
  const priceMicros = Math.floor(parseFloat(priceRaw) * 1000000);
  out += `${id},published,managed_by_android,true,en_US; ${title}; ${title} Special Offer,true,${priceMicros}\n`;
}
fs.writeFileSync('tools/GooglePlay_IAP_Import.csv', out);
console.log('CSV created at tools/GooglePlay_IAP_Import.csv');
