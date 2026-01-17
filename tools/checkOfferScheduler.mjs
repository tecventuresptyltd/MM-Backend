/**
 * Diagnostic script to check offer scheduler health.
 * Run with: node tools/checkOfferScheduler.mjs
 */
import { initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Initialize with Application Default Credentials
initializeApp({
    credential: applicationDefault(),
    projectId: "mystic-motors-prod",
});

const db = getFirestore();

async function main() {
    console.log("🔍 Checking Offer Scheduler Health...\n");
    const now = Date.now();

    // 1. Check TransitionQueue for overdue entries
    console.log("📋 Checking TransitionQueue for overdue entries...");
    const overdueQuery = await db
        .collection("System/Offers/TransitionQueue")
        .where("transitionAt", "<=", now)
        .limit(50)
        .get();

    console.log(`   Found ${overdueQuery.size} overdue transitions\n`);

    if (overdueQuery.size > 0) {
        console.log("🚨 OVERDUE TRANSITIONS:");
        overdueQuery.docs.forEach(doc => {
            const data = doc.data();
            const overdueBy = now - data.transitionAt;
            const overdueMinutes = Math.floor(overdueBy / 60000);
            console.log(`   - UID: ${data.uid}`);
            console.log(`     Type: ${data.transitionType}`);
            console.log(`     Scheduled: ${new Date(data.transitionAt).toISOString()}`);
            console.log(`     Overdue by: ${overdueMinutes} minutes`);
            console.log("");
        });
    }

    // 2. Check total queue size
    console.log("📊 Checking total queue size...");
    const allQueue = await db
        .collection("System/Offers/TransitionQueue")
        .limit(1000)
        .get();
    console.log(`   Total entries in queue: ${allQueue.size}\n`);

    // 3. Sample upcoming transitions
    console.log("⏰ Sample upcoming transitions:");
    const upcomingQuery = await db
        .collection("System/Offers/TransitionQueue")
        .where("transitionAt", ">", now)
        .orderBy("transitionAt")
        .limit(10)
        .get();

    upcomingQuery.docs.forEach(doc => {
        const data = doc.data();
        const inMinutes = Math.floor((data.transitionAt - now) / 60000);
        console.log(`   - ${data.transitionType} for ${data.uid} in ${inMinutes} minutes`);
    });

    console.log("\n✅ Diagnostic complete!");

    if (overdueQuery.size > 10) {
        console.log("\n🚨 CRITICAL: Many overdue transitions! Scheduler may not be running.");
    } else if (overdueQuery.size > 0) {
        console.log("\n⚠️  WARNING: Some overdue transitions. May be normal lag or scheduler hiccup.");
    } else {
        console.log("\n✅ No overdue transitions - scheduler appears healthy.");
    }
}

main().catch(console.error);
