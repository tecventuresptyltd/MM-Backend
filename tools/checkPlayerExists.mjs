/**
 * Check if player exists and list their subcollections.
 * Run with: node tools/checkPlayerExists.mjs
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Initialize with Application Default Credentials
initializeApp({
    credential: applicationDefault(),
    projectId: "mystic-motors-prod",
});

const db = getFirestore();

// User's UID from screenshot
const uid = "axfjDX2iShXTCJady5cUneblZZk2";

async function main() {
    console.log(`🔍 Checking player document for: ${uid}\n`);

    // 1. Check if Players/{uid} exists
    const playerDoc = await db.doc(`Players/${uid}`).get();
    console.log(`📋 Players/${uid} exists: ${playerDoc.exists ? "YES" : "NO"}`);
    if (playerDoc.exists) {
        console.log("Data:", JSON.stringify(playerDoc.data(), null, 2).substring(0, 500));
    }

    // 2. Check Profile
    const profileDoc = await db.doc(`Players/${uid}/Profile/Profile`).get();
    console.log(`\n📋 Players/${uid}/Profile/Profile exists: ${profileDoc.exists ? "YES" : "NO"}`);
    if (profileDoc.exists) {
        console.log("Data:", JSON.stringify(profileDoc.data(), null, 2).substring(0, 500));
    }

    // 3. List subcollections under Offers
    console.log(`\n📂 Checking Offers subcollections...`);

    const activeDoc = await db.doc(`Players/${uid}/Offers/Active`).get();
    console.log(`   Active: ${activeDoc.exists ? "EXISTS" : "MISSING"}`);

    const stateDoc = await db.doc(`Players/${uid}/Offers/State`).get();
    console.log(`   State: ${stateDoc.exists ? "EXISTS" : "MISSING"}`);

    const historyDoc = await db.doc(`Players/${uid}/Offers/History`).get();
    console.log(`   History: ${historyDoc.exists ? "EXISTS" : "MISSING"}`);

    // Check if the player has any offers at all by listing the docs
    console.log(`\n📂 Listing all docs under Players/${uid}/Offers/...`);
    const offersCollection = await db.collection(`Players/${uid}/Offers`).get();
    console.log(`   Found ${offersCollection.size} documents`);
    offersCollection.docs.forEach(doc => {
        console.log(`   - ${doc.id}: ${JSON.stringify(doc.data()).substring(0, 200)}`);
    });

    console.log("\n✅ Check complete!");
}

main().catch(console.error);
