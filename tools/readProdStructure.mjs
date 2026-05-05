/**
 * READ-ONLY: Enumerate the full structure of the production Firestore database.
 * This script makes ZERO writes. It only reads documents to map:
 *   - All top-level collections
 *   - All subcollections (recursively)
 *   - Field names, types, and sample values for each document type
 *
 * Run: node tools/readProdStructure.mjs
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const credFile = join(__dirname, '..', 'backend-production-mystic-motors-prod.json');
const serviceAccount = JSON.parse(readFileSync(credFile, 'utf8'));

initializeApp({
  credential: cert(serviceAccount),
  projectId: 'mystic-motors-prod',
});

const db = getFirestore();

// ─── Helpers ──────────────────────────────────────────────────────
function describeValue(v) {
  if (v === null || v === undefined) return { type: 'null', sample: null };
  if (v instanceof Date || (v && v.toDate)) return { type: 'Timestamp', sample: (v.toDate ? v.toDate().toISOString() : v.toISOString()) };
  if (v && v._path) return { type: 'DocumentReference', sample: v.path };
  if (v && typeof v.latitude === 'number') return { type: 'GeoPoint', sample: `${v.latitude},${v.longitude}` };
  if (Array.isArray(v)) {
    const itemTypes = [...new Set(v.slice(0, 5).map(i => typeof i))];
    return { type: `Array<${itemTypes.join('|')}>`, sample: v.length <= 3 ? v : `[${v.length} items]` };
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    return { type: 'Map', sample: `{${keys.length} keys: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? '...' : ''}}` };
  }
  return { type: typeof v, sample: v };
}

function describeFields(data) {
  const result = {};
  for (const [key, val] of Object.entries(data)) {
    const desc = describeValue(val);
    result[key] = desc;
    // If it's a map, recurse one level to show inner keys
    if (desc.type === 'Map' && val && typeof val === 'object' && !Array.isArray(val)) {
      result[key].children = {};
      for (const [ik, iv] of Object.entries(val)) {
        result[key].children[ik] = describeValue(iv);
      }
    }
  }
  return result;
}

// ─── Recursive structure walker ───────────────────────────────────
const MAX_DOCS_PER_COLLECTION = 3; // Sample size
const MAX_DEPTH = 5;

async function walkCollection(collRef, depth = 0) {
  const indent = '  '.repeat(depth);
  const info = { path: collRef.path, documents: [] };

  const snap = await collRef.limit(MAX_DOCS_PER_COLLECTION).get();
  console.log(`${indent}📂 ${collRef.path}  (${snap.size} sampled)`);

  for (const doc of snap.docs) {
    const docInfo = {
      id: doc.id,
      fields: describeFields(doc.data()),
      subcollections: [],
    };

    // List subcollections
    if (depth < MAX_DEPTH) {
      const subColls = await doc.ref.listCollections();
      for (const subColl of subColls) {
        const subInfo = await walkCollection(subColl, depth + 1);
        docInfo.subcollections.push(subInfo);
      }
    }

    info.documents.push(docInfo);
  }

  return info;
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('🔍 Reading PRODUCTION Firestore structure (READ-ONLY)...\n');

  // 1. List all top-level collections
  const topCollections = await db.listCollections();
  console.log(`Found ${topCollections.length} top-level collections:\n`);
  for (const col of topCollections) {
    console.log(`  • ${col.id}`);
  }
  console.log('');

  // 2. Walk each collection recursively
  const fullStructure = {};
  for (const col of topCollections) {
    fullStructure[col.id] = await walkCollection(col);
    console.log(''); // Spacer
  }

  // 3. Write the full structure to a JSON file for analysis
  const outputPath = join(__dirname, '..', 'prod_db_structure.json');
  writeFileSync(outputPath, JSON.stringify(fullStructure, null, 2));
  console.log(`\n✅ Full structure written to: ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Error:', err);
    process.exit(1);
  });
