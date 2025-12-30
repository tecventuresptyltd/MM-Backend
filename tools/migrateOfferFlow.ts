/**
 * One-time migration to initialize offer flow for existing players.
 * 
 * Run this script to:
 * 1. Create Offers/Active document with first daily offer
 * 2. Create Offers/State document for flow tracking
 * 
 * Usage:
 * npm run migrate-offers -- --env prod
 */

import * as admin from "firebase-admin";
import { loadOfferLadderIndex } from "../src/shop/offerCatalog.js";
import {
    OFFER_VALIDITY_MS,
    normaliseOfferFlowState,
    writeActiveOffersV2,
    writeOfferFlowState,
} from "../src/shop/offerState.js";
import { MainOffer } from "../src/shared/types.js";

// Initialize Firebase Admin
if (!admin.apps.length) {
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!serviceAccountPath) {
        console.error("Error: GOOGLE_APPLICATION_CREDENTIALS environment variable not set");
        process.exit(1);
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccountPath),
    });
}

const db = admin.firestore();

/**
 * Select a random daily offer (tier 0)
 */
function selectRandomDailyOffer(index: any): { offerId: string; offerType: number } {
    const ids = index.dailyBaseOfferIds;
    if (ids.length === 0) {
        throw new Error("No daily offers configured in catalog.");
    }
    const randomIndex = Math.floor(Math.random() * ids.length);
    const offerId = ids[randomIndex];
    return { offerId, offerType: randomIndex + 1 };
}

/**
 * Create a daily offer for tier 0
 */
function createInitialDailyOffer(index: any, now: number): MainOffer {
    const { offerId, offerType } = selectRandomDailyOffer(index);
    return {
        offerId,
        offerType,
        expiresAt: now + OFFER_VALIDITY_MS,
        tier: 0,
        state: "active",
        isStarter: false,
    };
}

/**
 * Initialize offers for a single player
 */
async function initializePlayerOffers(uid: string, ladderIndex: any, now: number): Promise<boolean> {
    try {
        const activeRef = db.doc(`Players/${uid}/Offers/Active`);
        const stateRef = db.doc(`Players/${uid}/Offers/State`);

        // Check if already initialized
        const [activeSnap, stateSnap] = await Promise.all([
            activeRef.get(),
            stateRef.get(),
        ]);

        // Skip if already has offers
        if (activeSnap.exists && activeSnap.data()?.main) {
            console.log(`  Player ${uid} already has offers, skipping`);
            return false;
        }

        // Create initial daily offer
        const initialOffer = createInitialDailyOffer(ladderIndex, now);

        await db.runTransaction(async (transaction) => {
            writeActiveOffersV2(transaction, uid, {
                main: initialOffer,
                special: [],
            }, now);

            writeOfferFlowState(transaction, uid, {
                starterEligible: false,  // Existing players skip starter
                starterShown: true,      // Mark as shown so they don't get it
                starterPurchased: false,
                tier: 0,
                offersPurchased: [],
                totalIapPurchases: 0,
            }, now);
        });

        console.log(`  ✅ Initialized offers for ${uid} - Tier 0 daily offer`);
        return true;
    } catch (error) {
        console.error(`  ❌ Failed to initialize offers for ${uid}:`, error);
        return false;
    }
}

/**
 * Main migration function
 */
async function migrateExistingPlayers() {
    console.log("Starting offer flow migration for existing players...\n");

    const now = Date.now();
    const ladderIndex = await loadOfferLadderIndex();

    let processedCount = 0;
    let initializedCount = 0;
    let errorCount = 0;

    // Query all player profiles
    const playersSnapshot = await db.collectionGroup("Profile")
        .where("__name__", "==", "Profile")
        .get();

    console.log(`Found ${playersSnapshot.size} players to process\n`);

    // Process in batches of 10 concurrent operations
    const BATCH_SIZE = 10;
    const playerDocs = playersSnapshot.docs;

    for (let i = 0; i < playerDocs.length; i += BATCH_SIZE) {
        const batch = playerDocs.slice(i, i + BATCH_SIZE);

        const results = await Promise.allSettled(
            batch.map(async (doc) => {
                const uid = doc.ref.parent.parent?.id;
                if (!uid) {
                    console.error(`  ❌ Could not extract UID from ${doc.ref.path}`);
                    return false;
                }

                const initialized = await initializePlayerOffers(uid, ladderIndex, now);
                return initialized;
            })
        );

        results.forEach((result) => {
            processedCount++;
            if (result.status === "fulfilled" && result.value) {
                initializedCount++;
            } else if (result.status === "rejected") {
                errorCount++;
            }
        });

        // Progress update every batch
        console.log(`Progress: ${processedCount}/${playerDocs.length} players processed`);
    }

    console.log("\n" + "=".repeat(50));
    console.log("Migration Complete!");
    console.log("=".repeat(50));
    console.log(`Total processed: ${processedCount}`);
    console.log(`Initialized: ${initializedCount}`);
    console.log(`Already had offers: ${processedCount - initializedCount - errorCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log("=".repeat(50));
}

// Run migration
migrateExistingPlayers()
    .then(() => {
        console.log("\nMigration script completed successfully");
        process.exit(0);
    })
    .catch((error) => {
        console.error("\nMigration script failed:", error);
        process.exit(1);
    });
