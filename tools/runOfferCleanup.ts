#!/usr/bin/env node
/**
 * Admin script to trigger the offer safety net cleanup.
 * This runs the same logic as the scheduled offerSafetyNetJob but immediately.
 * 
 * Usage: npx ts-node tools/runOfferCleanup.ts
 */

import * as admin from "firebase-admin";
import * as path from "path";
import * as fs from "fs";

// Initialize Firebase Admin with production credentials
const serviceAccountPath = path.join(__dirname, "../env/mystic-motors-prod-firebase-adminsdk.json");

if (!fs.existsSync(serviceAccountPath)) {
    console.error("❌ Service account file not found at:", serviceAccountPath);
    console.error("Please ensure the production service account file exists.");
    process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf-8"));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: "mystic-motors-prod",
});

const db = admin.firestore();

// Import the safety net logic directly
import { runOfferSafetyCheck } from "../src/shop/offerSafetyNet.js";

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
