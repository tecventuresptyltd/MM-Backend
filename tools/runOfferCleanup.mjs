#!/usr/bin/env node
/**
 * Admin script to trigger the offer safety net cleanup.
 * 
 * Usage: node tools/runOfferCleanup.mjs
 */

import admin from "firebase-admin";

// Initialize Firebase Admin with Application Default Credentials
// (Uses GOOGLE_APPLICATION_CREDENTIALS or gcloud auth application-default credentials)
admin.initializeApp({
    projectId: "mystic-motors-prod",
});

const db = admin.firestore();

// Import the compiled safety net logic
const { runOfferSafetyCheck } = await import("../lib/shop/offerSafetyNet.js");

async function main() {
    console.log("🚀 Starting Offer Safety Net Cleanup...");
    console.log("📊 Target: mystic-motors-prod");
    console.log("");

    try {
        const stats = await runOfferSafetyCheck();

        console.log("");
        console.log("✅ Cleanup Complete!");
        console.log(`📋 Scanned: ${stats.scanned} players`);
        console.log(`🔧 Restored: ${stats.restored} offers`);
        console.log(`⚠️  Errors: ${stats.errors}`);

        if (stats.restored > 0) {
            console.log("");
            console.log(`🎉 ${stats.restored} players with expired offers have been fixed!`);
        }
    } catch (error) {
        console.error("❌ Cleanup failed:", error);
        process.exit(1);
    }

    process.exit(0);
}

main();
