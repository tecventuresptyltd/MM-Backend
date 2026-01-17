/**
 * Debug script to check a specific user's offer state.
 * Run with: node tools/debugUserOffer.mjs
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Initialize with Application Default Credentials
initializeApp({
    credential: applicationDefault(),
    projectId: "mystic-motors-prod",
});

const db = getFirestore();
const TRANSITION_QUEUE_PATH = "System/Offers/TransitionQueue";

// User's UID from screenshot
const uid = "axfjDX2iShXTCJady5cUneblZZk2";

async function main() {
    console.log(`🔍 Debugging offer state for user: ${uid}\n`);
    const now = Date.now();

    // 1. Check Active Offers document
    console.log("📋 Active Offers Document:");
    const activeSnap = await db.doc(`Players/${uid}/Offers/Active`).get();
    if (activeSnap.exists) {
        const data = activeSnap.data();
        console.log(JSON.stringify(data, null, 2));

        const main = data?.main;
        if (main) {
            console.log(`\n📊 Main Offer Analysis:`);
            console.log(`   State: ${main.state}`);
            console.log(`   Offer ID: ${main.offerId}`);
            console.log(`   Expires At: ${new Date(main.expiresAt).toISOString()}`);
            console.log(`   Expired: ${main.expiresAt <= now ? "YES" : "NO"}`);
            if (main.expiresAt <= now) {
                const expiredMinutes = Math.floor((now - main.expiresAt) / 60000);
                console.log(`   Expired by: ${expiredMinutes} minutes ago`);
            }
        }
    } else {
        console.log("   Document does not exist!");
    }

    // 2. Check Queue Entry
    console.log("\n📋 Transition Queue Entry:");
    const queueSnap = await db.collection(TRANSITION_QUEUE_PATH).doc(uid).get();
    if (queueSnap.exists) {
        const queueData = queueSnap.data();
        console.log(JSON.stringify(queueData, null, 2));
        console.log(`\n📊 Queue Entry Analysis:`);
        console.log(`   Transition Type: ${queueData.transitionType}`);
        console.log(`   Transition At: ${new Date(queueData.transitionAt).toISOString()}`);
        console.log(`   Is Due: ${queueData.transitionAt <= now ? "YES - SHOULD BE PROCESSED" : "NO - future"}`);
        if (queueData.transitionAt <= now) {
            const overdueMinutes = Math.floor((now - queueData.transitionAt) / 60000);
            console.log(`   Overdue by: ${overdueMinutes} minutes`);
        }
    } else {
        console.log("   NO QUEUE ENTRY EXISTS!");
    }

    // 3. Check Flow State
    console.log("\n📋 Offer Flow State:");
    const stateSnap = await db.doc(`Players/${uid}/Offers/State`).get();
    if (stateSnap.exists) {
        console.log(JSON.stringify(stateSnap.data(), null, 2));
    } else {
        console.log("   Document does not exist!");
    }

    console.log("\n✅ Debug complete!");
}

main().catch(console.error);
