/**
 * Quick script to count total referrals across all players in PRODUCTION
 * Run with: npx tsx tools/countTotalReferrals.ts
 * 
 * Requires the production service account key file at:
 * ../backend-production-mystic-motors-prod.json
 */

import * as admin from "firebase-admin";
import * as fs from "fs";
import * as path from "path";

const serviceAccountPath = path.join(__dirname, '..', 'backend-production-mystic-motors-prod.json');

if (!fs.existsSync(serviceAccountPath)) {
    console.error('❌ ERROR: Production service account key not found!');
    console.error('📍 Expected location:', serviceAccountPath);
    console.error('\n📝 To download the service account key:');
    console.error('   1. Go to Google Cloud Console → IAM & Admin → Service Accounts');
    console.error('   2. Find: backend-production@mystic-motors-prod.iam.gserviceaccount.com');
    console.error('   3. Click "Manage Keys" → "Add Key" → "Create new key" → JSON');
    console.error('   4. Save as: backend-production-mystic-motors-prod.json in the repo root\n');
    process.exit(1);
}

const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'mystic-motors-prod'
});

const db = admin.firestore();

async function countTotalReferrals() {
    console.log("Fetching all player documents...");

    const players = await db.collection("Players").select("referralStats.sent").get();

    let total = 0;
    let playersWithReferrals = 0;

    for (const doc of players.docs) {
        const sent = doc.get("referralStats.sent") || 0;
        if (sent > 0) {
            playersWithReferrals++;
            total += sent;
        }
    }

    console.log("\n=== Referral Summary ===");
    console.log(`Total players scanned: ${players.size}`);
    console.log(`Players with at least 1 referral: ${playersWithReferrals}`);
    console.log(`Total referrals: ${total}`);
}

countTotalReferrals()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("Error:", err);
        process.exit(1);
    });
