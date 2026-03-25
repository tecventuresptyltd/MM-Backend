/**
 * Daily Rewards Cloud Functions
 *
 * Two functions:
 *   getDailyRewardStatus  — returns current day, claimable status, timers
 *   claimDailyReward      — claims the reward for the current day (transactional + idempotent)
 *
 * Data model:
 *   /Players/{uid}/DailyRewards/Status
 *     currentDay      : number (1-30)
 *     lastClaimedAt   : Timestamp
 *     nextAvailableAt : Timestamp  (lastClaimedAt + 24h)
 *     expiresAt       : Timestamp  (nextAvailableAt + 24h — miss this and streak resets)
 *
 * Rules:
 *   - After claiming Day N, Day N+1 becomes available 24h later
 *   - Day N+1 must be claimed within 24h of becoming available (before expiresAt)
 *   - If expiresAt passes without claiming → reset to Day 1 (ready to claim)
 *   - After Day 30 is claimed → cycle back to Day 1
 *   - No scheduled job needed — expiry is evaluated at read/claim time
 */

import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { getDailyRewardsConfig, DailyRewardDay } from "../core/configV2.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runReadThenWriteWithReceipt } from "../core/transactions.js";
import { db } from "../shared/firestore.js";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { grantInventoryRewards, InventoryGrant } from "../shared/inventoryAwards.js";

// =============================================================================
// CONSTANTS
// =============================================================================

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const MAX_DAY = 30;

// =============================================================================
// HELPERS
// =============================================================================

interface DailyRewardStatusDoc {
    currentDay: number;
    lastClaimedAt: FirebaseFirestore.Timestamp | null;
    nextAvailableAt: FirebaseFirestore.Timestamp | null;
    expiresAt: FirebaseFirestore.Timestamp | null;
}

function getStatusRef(uid: string): FirebaseFirestore.DocumentReference {
    return db.doc(`Players/${uid}/DailyRewards/Status`);
}

/**
 * Resolve the effective daily reward state from Firestore data.
 * If the player missed the window (expiresAt < now), resets to Day 1.
 */
function resolveEffectiveState(
    data: DailyRewardStatusDoc | undefined,
    now: Date,
): { currentDay: number; isClaimable: boolean; nextAvailableAt: Date | null; expiresAt: Date | null; isNewPlayer: boolean } {
    // Brand-new player — never claimed anything
    if (!data || !data.lastClaimedAt) {
        return {
            currentDay: 1,
            isClaimable: true,
            nextAvailableAt: null,
            expiresAt: null,
            isNewPlayer: true,
        };
    }

    const nowMs = now.getTime();
    const expiresAt = data.expiresAt?.toDate() ?? null;
    const nextAvailableAt = data.nextAvailableAt?.toDate() ?? null;

    // Missed the claim window → reset to Day 1
    if (expiresAt && nowMs > expiresAt.getTime()) {
        return {
            currentDay: 1,
            isClaimable: true,
            nextAvailableAt: null,
            expiresAt: null,
            isNewPlayer: false,
        };
    }

    // Currently in the claim window
    if (nextAvailableAt && nowMs >= nextAvailableAt.getTime()) {
        return {
            currentDay: data.currentDay,
            isClaimable: true,
            nextAvailableAt,
            expiresAt,
            isNewPlayer: false,
        };
    }

    // Waiting for the next window to open
    return {
        currentDay: data.currentDay,
        isClaimable: false,
        nextAvailableAt,
        expiresAt,
        isNewPlayer: false,
    };
}

// =============================================================================
// getDailyRewardStatus  (read-only, no transaction needed)
// =============================================================================

export const getDailyRewardStatus = onCall(
    callableOptions({ memory: "256MiB", cpu: 1, concurrency: 80 }),
    async (request) => {
        const uid = request.auth?.uid;
        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        const [statusSnap, config] = await Promise.all([
            getStatusRef(uid).get(),
            getDailyRewardsConfig(),
        ]);

        const data = statusSnap.exists ? (statusSnap.data() as DailyRewardStatusDoc) : undefined;
        const now = new Date();
        const state = resolveEffectiveState(data, now);

        // Look up what they'll get
        const dayKey = `day_${state.currentDay}`;
        const dayConfig = config.rewards[dayKey];

        return {
            currentDay: state.currentDay,
            maxDay: MAX_DAY,
            isClaimable: state.isClaimable,
            isMilestone: dayConfig?.isMilestone ?? false,
            nextAvailableAt: state.nextAvailableAt?.toISOString() ?? null,
            expiresAt: state.expiresAt?.toISOString() ?? null,
            preview: dayConfig ? {
                gems: dayConfig.gems,
                items: dayConfig.items.map((item) => ({
                    type: item.type,
                    id: item.id,
                    quantity: item.quantity,
                    label: item.label ?? item.id,
                })),
            } : null,
        };
    },
);

// =============================================================================
// claimDailyReward  (transactional + idempotent)
// =============================================================================

interface ClaimDailyRewardRequest {
    opId: unknown;
}

export const claimDailyReward = onCall(
    callableOptions({ memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const uid = request.auth?.uid;
        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        const { opId } = request.data as ClaimDailyRewardRequest;
        if (typeof opId !== "string" || !opId.trim()) {
            throw new HttpsError("invalid-argument", "opId must be a non-empty string.");
        }

        const reason = "dailyReward.claim";

        // Idempotency check
        const cachedResult = await checkIdempotency(uid, opId);
        if (cachedResult) {
            return cachedResult;
        }

        await createInProgressReceipt(uid, opId, reason);

        const config = await getDailyRewardsConfig();

        try {
            return await runReadThenWriteWithReceipt(
                uid,
                opId,
                reason,
                // ── READ PHASE ──
                async (transaction) => {
                    const statusRef = getStatusRef(uid);
                    const statusSnap = await transaction.get(statusRef);
                    const economyRef = db.doc(`Players/${uid}/Economy/Stats`);
                    const economySnap = await transaction.get(economyRef);

                    const data = statusSnap.exists
                        ? (statusSnap.data() as DailyRewardStatusDoc)
                        : undefined;

                    const now = new Date();
                    const state = resolveEffectiveState(data, now);

                    if (!state.isClaimable) {
                        throw new HttpsError(
                            "failed-precondition",
                            `Day ${state.currentDay} is not claimable yet. Available at ${state.nextAvailableAt?.toISOString()}.`,
                        );
                    }

                    const dayKey = `day_${state.currentDay}`;
                    const dayConfig: DailyRewardDay | undefined = config.rewards[dayKey];
                    if (!dayConfig) {
                        throw new HttpsError(
                            "internal",
                            `DailyRewardsConfig missing entry for ${dayKey}.`,
                        );
                    }

                    const economyStats = economySnap.exists ? economySnap.data() ?? {} : {};

                    return {
                        statusRef,
                        economyRef,
                        economyStats,
                        state,
                        dayConfig,
                        now,
                    };
                },
                // ── WRITE PHASE ──
                async (transaction, reads) => {
                    const { statusRef, economyRef, economyStats, state, dayConfig, now } = reads;

                    const tsNow = admin.firestore.Timestamp.fromDate(now);
                    const nextAvailableAt = admin.firestore.Timestamp.fromDate(
                        new Date(now.getTime() + TWENTY_FOUR_HOURS_MS),
                    );
                    const expiresAt = admin.firestore.Timestamp.fromDate(
                        new Date(now.getTime() + 2 * TWENTY_FOUR_HOURS_MS),
                    );

                    // Calculate next day (cycle back after Day 30)
                    const nextDay = state.currentDay >= MAX_DAY ? 1 : state.currentDay + 1;

                    // 1. Update streak status doc
                    transaction.set(statusRef, {
                        currentDay: nextDay,
                        lastClaimedAt: tsNow,
                        nextAvailableAt,
                        expiresAt,
                    });

                    // 2. Award gems via Economy/Stats
                    if (dayConfig.gems > 0) {
                        transaction.update(economyRef, {
                            gems: admin.firestore.FieldValue.increment(dayConfig.gems),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        });
                    }

                    // 3. Award inventory items (boosters + speed-ups)
                    const inventoryGrants: InventoryGrant[] = dayConfig.items
                        .filter((item) => item.type === "booster" || item.type === "speedUp")
                        .map((item) => ({
                            skuId: item.id,
                            quantity: item.quantity,
                        }));

                    let grantResults: { skuId: string; quantity: number }[] = [];
                    if (inventoryGrants.length > 0) {
                        grantResults = await grantInventoryRewards(
                            transaction,
                            uid,
                            inventoryGrants,
                            { timestamp: admin.firestore.FieldValue.serverTimestamp() },
                        );
                    }

                    const gemsBefore = Number(economyStats.gems ?? 0);

                    return {
                        success: true,
                        claimedDay: state.currentDay,
                        nextDay,
                        isMilestone: dayConfig.isMilestone ?? false,
                        rewards: {
                            gems: dayConfig.gems,
                            items: grantResults.map((r) => ({
                                skuId: r.skuId,
                                quantity: r.quantity,
                            })),
                        },
                        gemsBefore,
                        gemsAfter: gemsBefore + dayConfig.gems,
                        nextAvailableAt: nextAvailableAt.toDate().toISOString(),
                        expiresAt: expiresAt.toDate().toISOString(),
                    };
                },
            );
        } catch (error) {
            if (error instanceof HttpsError) {
                throw error;
            }
            console.error("[claimDailyReward] Failed:", error);
            throw new HttpsError("internal", "Failed to claim daily reward.");
        }
    },
);
