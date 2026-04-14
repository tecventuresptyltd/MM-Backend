import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { MainOffer } from "../shared/types.js";
import { callableOptions } from "../shared/callableOptions.js";
import {
    normaliseActiveOffers,
    normaliseOfferFlowState,
    writeActiveOffersV2,
    writeOfferFlowState,
    pruneExpiredSpecialOffers,
} from "./offerState.js";
import { loadOfferSlotIndex, OfferSlotIndex } from "./offerCatalog.js";
import { createSlotOffer, scheduleOfferTransition } from "./offerScheduler.js";

const needsOfferRestoration = (activeOffers: any, now: number): boolean => {
    if (!activeOffers.rotating || !Array.isArray(activeOffers.rotating) || activeOffers.rotating.length === 0) {
        return true;
    }

    let needsRepair = false;
    for (const main of activeOffers.rotating) {
        if (!["active", "cooldown", "purchase_delay"].includes(main.state)) {
            needsRepair = true;
        }
        if (main.state === "active" && main.expiresAt <= now) {
            needsRepair = true;
        }
        if (main.state !== "active" && main.nextOfferAt) {
            const timeSinceTransition = now - main.nextOfferAt;
            if (timeSinceTransition > 48 * 60 * 60 * 1000) {
                needsRepair = true;
            }
        }
    }
    return needsRepair;
};

const sanitizeMainOfferArray = (offers: MainOffer[]): MainOffer[] => {
    return JSON.parse(JSON.stringify(offers));
};

const restorePlayerOffers = async (
    uid: string,
    slotIndex: OfferSlotIndex,
    now: number,
): Promise<boolean> => {
    try {
        const result = await db.runTransaction(async (transaction) => {
            const activeRef = db.doc(`Players/${uid}/Offers/Active`);
            const stateRef = db.doc(`Players/${uid}/Offers/State`);

            const [activeSnap, stateSnap] = await Promise.all([
                transaction.get(activeRef),
                transaction.get(stateRef),
            ]);

            const activeOffers = normaliseActiveOffers(activeSnap.data());
            const flowState = normaliseOfferFlowState(stateSnap.data());

            const prunedSpecial = pruneExpiredSpecialOffers(activeOffers.special || [], now);
            const specialNeedsPruning = prunedSpecial.length !== (activeOffers.special || []).length;

            const mainNeedsRestoration = needsOfferRestoration(activeOffers, now);

            if (!mainNeedsRestoration && !specialNeedsPruning) {
                return null;
            }

            let rotating = activeOffers.rotating || [];
            
            if (mainNeedsRestoration) {
                rotating = [
                    createSlotOffer("micro_hook", slotIndex, now),
                    createSlotOffer("sweet_spot", slotIndex, now),
                    createSlotOffer("whale", slotIndex, now),
                ];
            }

            writeActiveOffersV2(transaction, uid, {
                rotating: sanitizeMainOfferArray(rotating),
                special: prunedSpecial,
            }, now);

            if (mainNeedsRestoration) {
                writeOfferFlowState(transaction, uid, { starterShown: true }, now);
            }

            return mainNeedsRestoration ? { rotating } : { fixed: true };
        });

        if (!result) return false;

        if ("rotating" in result && result.rotating) {
            for (const offer of result.rotating) {
                if (offer.category) {
                    await scheduleOfferTransition(uid, offer.category, offer.expiresAt, "offer_expired").catch(e => logger.warn(e));
                }
            }
        }

        return true;
    } catch (error) {
        logger.error(`Failed to fix offers for ${uid}:`, error);
        return false;
    }
};

export const runOfferSafetyCheck = async (): Promise<{ scanned: number; restored: number; errors: number; }> => {
    const stats = { scanned: 0, restored: 0, errors: 0 };
    const now = Date.now();

    try {
        const slotIndex = await loadOfferSlotIndex();

        const playersSnap = await db.collection("Players").select().get();

        const BATCH_SIZE = 20;
        const playerDocs = playersSnap.docs;

        for (let i = 0; i < playerDocs.length; i += BATCH_SIZE) {
            const batch = playerDocs.slice(i, i + BATCH_SIZE);

            const results = await Promise.allSettled(
                batch.map(async (doc: FirebaseFirestore.DocumentSnapshot) => {
                    const uid = doc.id;
                    if (!uid) return { restored: false, error: false };

                    stats.scanned++;
                    const restored = await restorePlayerOffers(uid, slotIndex, now);
                    return { restored, error: false };
                })
            );

            results.forEach((result) => {
                if (result.status === "fulfilled") {
                    if (result.value.restored) stats.restored++;
                    if (result.value.error) stats.errors++;
                } else {
                    stats.errors++;
                }
            });
        }
        return stats;
    } catch (error) {
        throw error;
    }
};

export const offerSafetyNetJob = onSchedule(
    { region: REGION, schedule: "every day 02:00", timeZone: "Etc/UTC", timeoutSeconds: 540, memory: "512MiB" },
    async () => {
        const stats = await runOfferSafetyCheck();
        if (stats.restored > 10) logger.warn(`High restoration count: ${stats.restored}`);
    }
);

export const runOfferSafetyNet = onCall(
    callableOptions({ timeoutSeconds: 540, memory: "512MiB" }),
    async (request) => {
        const uid = request.auth?.uid;
        if (!uid) throw new HttpsError("unauthenticated", "Must be authenticated");
        const stats = await runOfferSafetyCheck();
        return { success: true, ...stats, message: `Scanned ${stats.scanned} players, restored ${stats.restored} offers` };
    }
);
