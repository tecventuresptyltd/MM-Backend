/**
 * Daily Rewards Cloud Functions
 *
 * Two callables:
 *   getDailyRewardStatus  — read-only. Returns the ladder, what is claimable, and timers.
 *   claimDailyReward      — claims the current slot (transactional + idempotent).
 *
 * ── How a "day" is decided ───────────────────────────────────────────────────
 * A game day is an absolute integer index derived from the *server* clock only
 * (see lib/dayIndex.ts). The player's device clock and timezone are never read,
 * so moving the device clock, changing timezone, or crossing DST has no effect.
 * A claim is permitted only when today's index is strictly greater than the
 * index we persisted on the last claim.
 *
 * ── Data model ───────────────────────────────────────────────────────────────
 *   /Players/{uid}/DailyRewards/Status
 *     streakDay           : number  — slot (1..cycleLength) to claim NEXT
 *     lastClaimedDayIndex : number  — absolute game-day index of the last claim
 *     lastClaimedAt       : Timestamp
 *     totalClaims         : number
 *     cycleCount          : number  — completed loops of the ladder
 *     configVersion       : string
 *
 *   /Players/{uid}/DailyRewards/Status/Log/{dayIndex}
 *     One immutable doc per claimed day. Doubles as an audit trail for player
 *     support and as a second, independent guard against double claims: the
 *     transaction creates it with `create` semantics, so a duplicate day fails
 *     even if the Status doc were ever corrupted or hand-edited.
 *
 * ── Missed days ──────────────────────────────────────────────────────────────
 * `graceDays` (config) missed days are forgiven. Beyond that the ladder resets
 * to slot 1. Nothing is scheduled — lapsing is evaluated lazily at read/claim
 * time, so there is no cron job and no per-player timer to drift.
 */

import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { DailyRewardsConfig, getDailyRewardsConfig } from "../core/configV2.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runReadThenWriteWithReceipt } from "../core/transactions.js";
import { db } from "../shared/firestore.js";
import { callableOptions } from "../shared/callableOptions.js";
import {
    applyRewardBundle,
    describeRewardLines,
    prepareRewardBundle,
} from "../shared/rewardBundle.js";
import {
    DailyRewardStatusState,
    DayBoundaryConfig,
    dayIndexStartMs,
    nextSlotAfter,
    resolveClaimState,
} from "./lib/dayIndex.js";

// =============================================================================
// HELPERS
// =============================================================================

interface DailyRewardStatusDoc extends DailyRewardStatusState {
    lastClaimedAt: FirebaseFirestore.Timestamp | null;
    totalClaims: number;
    cycleCount: number;
    configVersion: string;
}

const getStatusRef = (uid: string): FirebaseFirestore.DocumentReference =>
    db.doc(`Players/${uid}/DailyRewards/Status`);

const getLogRef = (uid: string, dayIndex: number): FirebaseFirestore.DocumentReference =>
    getStatusRef(uid).collection("Log").doc(String(dayIndex));

const boundaryConfig = (config: DailyRewardsConfig): DayBoundaryConfig => ({
    cycleLength: config.cycleLength,
    resetOffsetMinutes: config.resetOffsetMinutes,
    graceDays: config.graceDays,
    loopCycle: config.loopCycle,
});

const readStatus = (
    snap: FirebaseFirestore.DocumentSnapshot,
): DailyRewardStatusDoc | null => {
    if (!snap.exists) {
        return null;
    }
    const data = snap.data() as Partial<DailyRewardStatusDoc>;
    const lastClaimedDayIndex = Number(data.lastClaimedDayIndex);
    return {
        streakDay: Number(data.streakDay ?? 1),
        lastClaimedDayIndex: Number.isFinite(lastClaimedDayIndex) ? lastClaimedDayIndex : null,
        lastClaimedAt: data.lastClaimedAt ?? null,
        totalClaims: Number(data.totalClaims ?? 0),
        cycleCount: Number(data.cycleCount ?? 0),
        configVersion: String(data.configVersion ?? ""),
    };
};

/**
 * Server clock, with an emulator-only override so tests can walk through days
 * without waiting. Gated on FUNCTIONS_EMULATOR so it can never be reached from
 * a deployed function, no matter what a client sends.
 */
const resolveNowMs = (data: unknown): number => {
    if (process.env.FUNCTIONS_EMULATOR === "true") {
        const override = Number((data as { __testNowMs?: unknown })?.__testNowMs);
        if (Number.isFinite(override) && override > 0) {
            return override;
        }
    }
    return Date.now();
};

const getSlotOrThrow = (config: DailyRewardsConfig, slot: number) => {
    const entry = config.slots[String(slot)];
    if (!entry) {
        throw new HttpsError("internal", `DailyRewardsConfig is missing slot ${slot}.`);
    }
    return entry;
};

// =============================================================================
// getDailyRewardStatus  (read-only — never mutates, so polling is harmless)
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

        const nowMs = resolveNowMs(request.data);
        const status = readStatus(statusSnap);
        const state = resolveClaimState(status, boundaryConfig(config), nowMs);

        // Per-slot display state for the calendar UI. "claimed" means "already
        // banked in the current run of the ladder", which is every slot before
        // the one now pending — unless the streak just lapsed, in which case the
        // run restarts and nothing is claimed yet.
        const claimedThrough = state.streakBroken ? 0 : state.slot - 1;

        const ladder = Object.values(config.slots)
            .sort((a, b) => a.day - b.day)
            .map((slot) => {
                let slotState: "claimed" | "claimable" | "locked";
                if (slot.day === state.slot && state.isClaimable) {
                    slotState = "claimable";
                } else if (slot.day <= claimedThrough) {
                    slotState = "claimed";
                } else {
                    slotState = "locked";
                }
                return {
                    day: slot.day,
                    isMilestone: slot.isMilestone,
                    state: slotState,
                    rewards: describeRewardLines(slot.rewards),
                };
            });

        return {
            // Returned so the client can run its countdown off the server clock
            // instead of the device clock.
            serverNowMs: nowMs,
            streakDay: state.slot,
            cycleLength: config.cycleLength,
            isClaimable: state.isClaimable,
            nextClaimAtMs: state.nextClaimAtMs,
            msUntilNextClaim: Math.max(0, state.nextClaimAtMs - nowMs),
            streakExpiresAtMs: state.streakExpiresAtMs,
            // True when the ladder has fallen back to slot 1 because the player
            // lapsed. Lets the popup say "your streak reset" instead of silently
            // showing day 1 again.
            streakBroken: state.streakBroken,
            totalClaims: status?.totalClaims ?? 0,
            cycleCount: status?.cycleCount ?? 0,
            graceDays: config.graceDays,
            configVersion: config.version,
            ladder,
        };
    },
);

// =============================================================================
// claimDailyReward  (transactional + idempotent)
// =============================================================================

export const claimDailyReward = onCall(
    callableOptions({ memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const uid = request.auth?.uid;
        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        const { opId } = (request.data ?? {}) as { opId?: unknown };
        if (typeof opId !== "string" || !opId.trim()) {
            throw new HttpsError("invalid-argument", "opId must be a non-empty string.");
        }

        const reason = "dailyReward.claim";

        // Retry of a call that already went through → replay the stored result
        // instead of granting twice.
        const cachedResult = await checkIdempotency(uid, opId).catch(() => {
            throw new HttpsError("aborted", "This claim is already being processed.");
        });
        if (cachedResult) {
            return cachedResult;
        }

        await createInProgressReceipt(uid, opId, reason);

        const config = await getDailyRewardsConfig();
        const bounds = boundaryConfig(config);
        const nowMs = resolveNowMs(request.data);

        try {
            return await runReadThenWriteWithReceipt(
                uid,
                opId,
                reason,
                // ── READ PHASE ── every read the write phase depends on happens here.
                async (transaction) => {
                    const statusRef = getStatusRef(uid);
                    const statusSnap = await transaction.get(statusRef);
                    const status = readStatus(statusSnap);
                    const state = resolveClaimState(status, bounds, nowMs);

                    if (!state.isClaimable) {
                        throw new HttpsError(
                            "failed-precondition",
                            `Daily reward already claimed. Next claim at ${new Date(
                                state.nextClaimAtMs,
                            ).toISOString()}.`,
                        );
                    }

                    const slot = getSlotOrThrow(config, state.slot);

                    // Independent double-claim guard. If this day already has a log
                    // entry, the Status doc and the log disagree — refuse rather
                    // than pay out twice.
                    const logRef = getLogRef(uid, state.todayIndex);
                    const logSnap = await transaction.get(logRef);
                    if (logSnap.exists) {
                        throw new HttpsError(
                            "failed-precondition",
                            "Daily reward already claimed for today.",
                        );
                    }

                    const bundle = await prepareRewardBundle(transaction, uid, slot.rewards);

                    return { statusRef, logRef, status, state, slot, bundle };
                },
                // ── WRITE PHASE ── no reads beyond this point.
                async (transaction, reads) => {
                    const { statusRef, logRef, status, state, slot, bundle } = reads;

                    const timestamp = admin.firestore.Timestamp.fromMillis(nowMs);
                    const granted = await applyRewardBundle(transaction, uid, bundle, {
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    });

                    const nextSlot = nextSlotAfter(state.slot, bounds);
                    const cycleCompleted = state.slot >= config.cycleLength;
                    const nextClaimAtMs = dayIndexStartMs(
                        state.todayIndex + 1,
                        config.resetOffsetMinutes,
                    );
                    const streakExpiresAtMs = dayIndexStartMs(
                        state.todayIndex + 2 + config.graceDays,
                        config.resetOffsetMinutes,
                    );

                    transaction.set(statusRef, {
                        streakDay: nextSlot,
                        lastClaimedDayIndex: state.todayIndex,
                        lastClaimedAt: timestamp,
                        totalClaims: (status?.totalClaims ?? 0) + 1,
                        cycleCount: (status?.cycleCount ?? 0) + (cycleCompleted ? 1 : 0),
                        configVersion: config.version,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    });

                    transaction.create(logRef, {
                        dayIndex: state.todayIndex,
                        slot: state.slot,
                        opId,
                        rewards: granted.rewards,
                        streakBroken: state.streakBroken,
                        configVersion: config.version,
                        claimedAt: timestamp,
                    });

                    return {
                        success: true,
                        claimedDay: state.slot,
                        isMilestone: slot.isMilestone,
                        streakBroken: state.streakBroken,
                        nextStreakDay: nextSlot,
                        cycleCompleted,
                        cycleCount: (status?.cycleCount ?? 0) + (cycleCompleted ? 1 : 0),
                        totalClaims: (status?.totalClaims ?? 0) + 1,
                        rewards: granted.rewards,
                        coins: granted.coins,
                        gems: granted.gems,
                        serverNowMs: nowMs,
                        nextClaimAtMs,
                        streakExpiresAtMs,
                    };
                },
            );
        } catch (error) {
            if (error instanceof HttpsError) {
                throw error;
            }
            // Two devices racing on different opIds: one transaction wins, the
            // other loses the contended Status doc or the Log create.
            const message = (error as Error)?.message ?? "";
            if (message.includes("ALREADY_EXISTS") || message.includes("already exists")) {
                throw new HttpsError(
                    "failed-precondition",
                    "Daily reward already claimed for today.",
                );
            }
            console.error("[claimDailyReward] Failed:", error);
            throw new HttpsError("internal", "Failed to claim daily reward.");
        }
    },
);
