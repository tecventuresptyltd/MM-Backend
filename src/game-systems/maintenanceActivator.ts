import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { REGION } from "../shared/region";

const db = admin.firestore();

/**
 * Scheduled function that runs every minute to check if scheduled maintenance should be activated.
 * When scheduledMaintenanceTime is reached, automatically sets enabled and maintenance to true.
 */
export const activateScheduledMaintenance = onSchedule({
    schedule: "*/1 * * * *", // Every minute
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

        // No scheduled maintenance, nothing to do
        if (!scheduledTime) {
            return;
        }

        const now = Date.now();

        // Check if it's time to activate
        if (now >= scheduledTime) {
            console.log(`Activating scheduled maintenance (scheduled for ${scheduledTime}, now is ${now})`);

            // Activate maintenance
            await maintenanceRef.update({
                maintenance: true,  // Only this field - activates blocking
                scheduledMaintenanceTime: admin.firestore.FieldValue.delete(), // Remove scheduled time
                activatedAt: now,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            console.log("Scheduled maintenance activated successfully");
        } else {
            const remainingMinutes = Math.ceil((scheduledTime - now) / (60 * 1000));
            console.log(`Scheduled maintenance not ready yet (${remainingMinutes} minutes remaining)`);
        }
    } catch (error) {
        console.error("Error in activateScheduledMaintenance:", error);
        throw error;
    }
});
