import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { REGION } from "../shared/region";

const db = admin.firestore();

/**
 * Scheduled function that runs every minute to:
 * 1. Check if scheduled maintenance should be activated
 * 2. Check if active maintenance duration has expired and should be disabled
 */
export const activateScheduledMaintenance = onSchedule({
    schedule: "*/1 * * * *", // Every minute (Cloud Scheduler minimum granularity)
    timeZone: "UTC",
    region: REGION,
}, async (event) => {
    try {
        const maintenanceRef = db.doc("/GameConfig/maintenance");
        const doc = await maintenanceRef.get();

        if (!doc.exists) {
            console.log("No maintenance config found");
            return;
        }

        const data = doc.data();
        const scheduledTime = data?.scheduledMaintenanceTime;
        const maintenanceEndTime = data?.maintenanceEndTime;
        const maintenanceActive = data?.maintenance;
        const now = Date.now();

        // Priority 1: Check if maintenance duration has expired (end first before activating new one)
        if (maintenanceActive && maintenanceEndTime && now >= maintenanceEndTime) {
            console.log(`Ending maintenance (ended at ${maintenanceEndTime}, now is ${now})`);

            await maintenanceRef.update({
                maintenance: false,
                maintenanceEndTime: admin.firestore.FieldValue.delete(),
                durationMinutes: admin.firestore.FieldValue.delete(),
                startedAt: admin.firestore.FieldValue.delete(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            console.log("Maintenance automatically ended after duration expired");
            return; // Exit after ending maintenance
        }

        // Priority 2: Check if it's time to activate scheduled maintenance
        if (scheduledTime && now >= scheduledTime) {
            console.log(`Activating scheduled maintenance (scheduled for ${scheduledTime}, now is ${now})`);

            // Activate maintenance
            await maintenanceRef.update({
                maintenance: true,  // Activates blocking
                scheduledMaintenanceTime: admin.firestore.FieldValue.delete(), // Remove scheduled time
                activatedAt: now,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            console.log("Scheduled maintenance activated successfully");
        } else if (scheduledTime) {
            const remainingMinutes = Math.ceil((scheduledTime - now) / (60 * 1000));
            console.log(`Scheduled maintenance not ready yet (${remainingMinutes} minutes remaining)`);
        }
    } catch (error) {
        console.error("Error in activateScheduledMaintenance:", error);
        throw error;
    }
});
