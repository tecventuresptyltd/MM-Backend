import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region";
import { assertIsAdmin } from "../shared/adminAuth";

const db = admin.firestore();

// --- Set Maintenance Mode ---

interface SetMaintenanceModeRequest {
    enabled: boolean;
    rewardAvailable?: boolean;
    rewardGems?: number;
    immediate?: boolean; // If true, activate immediately. If false, schedule with delay
    delayMinutes?: number; // Number of minutes to delay (if not immediate). Default: 15
    durationMinutes?: number; // NEW: How long maintenance will last (in minutes)
}

interface SetMaintenanceModeResponse {
    success: boolean;
    maintenance: {
        enabled: boolean;
        rewardAvailable?: boolean;
        rewardGems?: number;
        scheduledMaintenanceTime?: number; // Timestamp when maintenance will be enforced
        delayMinutes?: number; // Number of minutes until enforcement
        durationMinutes?: number; // NEW: Duration in minutes
        maintenanceEndTime?: number; // NEW: When maintenance will end
        updatedAt: number;
        updatedBy: string;
    };
}

export const setMaintenanceMode = onCall({ region: REGION }, async (request) => {
    const uid = request.auth?.uid;

    if (!uid) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
    }

    // Verify admin privileges
    await assertIsAdmin(uid);

    const { enabled, rewardAvailable, rewardGems, immediate, delayMinutes, durationMinutes } = request.data as SetMaintenanceModeRequest;

    if (typeof enabled !== "boolean") {
        throw new HttpsError("invalid-argument", "enabled must be a boolean.");
    }

    if (rewardAvailable !== undefined && typeof rewardAvailable !== "boolean") {
        throw new HttpsError("invalid-argument", "rewardAvailable must be a boolean.");
    }

    if (rewardGems !== undefined && (typeof rewardGems !== "number" || rewardGems < 0)) {
        throw new HttpsError("invalid-argument", "rewardGems must be a non-negative number.");
    }

    if (immediate !== undefined && typeof immediate !== "boolean") {
        throw new HttpsError("invalid-argument", "immediate must be a boolean.");
    }

    if (delayMinutes !== undefined && (typeof delayMinutes !== "number" || delayMinutes <= 0)) {
        throw new HttpsError("invalid-argument", "delayMinutes must be a positive number.");
    }
    if (durationMinutes !== undefined && (typeof durationMinutes !== "number" || durationMinutes <= 0)) {
        throw new HttpsError("invalid-argument", "durationMinutes must be a positive number.");
    }

    const maintenanceRef = db.doc("/GameConfig/maintenance");
    const timestamp = Date.now();

    // Use provided delay or default to 15 minutes
    const effectiveDelayMinutes = delayMinutes || 15;

    // Calculate scheduled maintenance time if not immediate
    const scheduledMaintenanceTime = enabled && immediate === false
        ? timestamp + (effectiveDelayMinutes * 60 * 1000) // Convert minutes to milliseconds
        : null;

    // Calculate maintenance start time (immediate = now, scheduled = future)
    const maintenanceStartTime = enabled
        ? (immediate !== false ? timestamp : scheduledMaintenanceTime!)
        : null;

    // Calculate maintenance end time based on duration
    const maintenanceEndTime = enabled && durationMinutes
        ? maintenanceStartTime! + (durationMinutes * 60 * 1000)
        : null;

    const maintenanceData: any = {
        maintenance: enabled,
        enabled,
        rewardAvailable: rewardAvailable || false,
        rewardGems: rewardGems || 100,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: uid,
    };

    // Add scheduledMaintenanceTime and delayMinutes only if maintenance is being enabled with a delay
    if (scheduledMaintenanceTime) {
        maintenanceData.scheduledMaintenanceTime = scheduledMaintenanceTime;
        maintenanceData.delayMinutes = effectiveDelayMinutes;
    } else if (enabled) {
        // If immediate maintenance, remove any scheduled time
        maintenanceData.scheduledMaintenanceTime = admin.firestore.FieldValue.delete();
    } else {
        // If turning off maintenance, clear the scheduled time
        maintenanceData.scheduledMaintenanceTime = admin.firestore.FieldValue.delete();
    }

    // Add duration fields if maintenance is being enabled
    if (enabled && durationMinutes) {
        maintenanceData.durationMinutes = durationMinutes;
        maintenanceData.maintenanceEndTime = maintenanceEndTime;
        maintenanceData.startedAt = immediate !== false ? timestamp : scheduledMaintenanceTime;
    } else {
        // Clear duration fields when disabling
        maintenanceData.durationMinutes = admin.firestore.FieldValue.delete();
        maintenanceData.maintenanceEndTime = admin.firestore.FieldValue.delete();
        maintenanceData.startedAt = admin.firestore.FieldValue.delete();
    }

    // Track maintenance history
    if (enabled) {
        // Starting maintenance - create new history entry
        // IMPORTANT: Use current timestamp for startedAt (when we enabled it)
        // NOT the scheduledMaintenanceTime (when it will activate)
        const historyRef = db.collection("/MaintenanceHistory").doc();
        await historyRef.set({
            startedAt: timestamp, // Current time when maintenance was enabled
            scheduledActivationTime: scheduledMaintenanceTime || null, // Future time when it will activate (if scheduled)
            startedBy: uid,
            endedAt: null,
            endedBy: null,
            duration: null,
            delayMinutes: scheduledMaintenanceTime ? effectiveDelayMinutes : 0,
            immediate: immediate !== false, // default to true if not specified
            rewardGems: rewardGems || 100,
            durationMinutes: durationMinutes || null, // Track planned duration
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Store the history ID for later updates
        maintenanceData.activeHistoryId = historyRef.id;
    } else {
        // Ending maintenance - update the active history entry
        const currentMaintenanceDoc = await maintenanceRef.get();
        const currentData = currentMaintenanceDoc.data();

        if (currentData?.activeHistoryId) {
            const historyRef = db.collection("/MaintenanceHistory").doc(currentData.activeHistoryId);
            const historyDoc = await historyRef.get();

            if (historyDoc.exists) {
                const historyData = historyDoc.data();
                const startedAt = historyData?.startedAt || timestamp;
                const duration = timestamp - startedAt;

                await historyRef.update({
                    endedAt: timestamp,
                    endedBy: uid,
                    duration,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            }
        }

        // Clear the active history ID
        maintenanceData.activeHistoryId = admin.firestore.FieldValue.delete();
    }

    await maintenanceRef.set(maintenanceData, { merge: true });

    const response: SetMaintenanceModeResponse = {
        success: true,
        maintenance: {
            enabled,
            rewardAvailable: rewardAvailable || false,
            rewardGems: rewardGems || 100,
            updatedAt: timestamp,
            updatedBy: uid,
        },
    };

    if (scheduledMaintenanceTime) {
        response.maintenance.scheduledMaintenanceTime = scheduledMaintenanceTime;
        response.maintenance.delayMinutes = effectiveDelayMinutes;
    }

    if (durationMinutes) {
        response.maintenance.durationMinutes = durationMinutes;
        response.maintenance.maintenanceEndTime = maintenanceEndTime!;
    }

    return response;
});

