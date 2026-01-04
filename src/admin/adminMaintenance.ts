import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { REGION } from "../shared/region.js";

/**
 * Get current maintenance status.
 * This function uses the Admin SDK which bypasses App Check,
 * allowing the admin website to read maintenance status without App Check.
 * 
 * @returns Current maintenance configuration
 */
export const getAdminMaintenanceStatus = onCall(
    { region: REGION, enforceAppCheck: false },
    async (request) => {
        console.log("[getMaintenanceStatus] Starting...");

        // Check if user is authenticated
        if (!request.auth) {
            console.log("[getMaintenanceStatus] No auth context - unauthenticated");
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const uid = request.auth.uid;
        console.log("[getMaintenanceStatus] Checking user:", uid);

        // Verify user is an admin
        const adminDoc = await admin.firestore()
            .collection("AdminUsers")
            .doc(uid)
            .get();

        if (!adminDoc.exists || adminDoc.data()?.role !== "admin") {
            console.log("[getMaintenanceStatus] User is not an admin");
            throw new HttpsError("permission-denied", "User must be an admin");
        }

        try {
            const maintenanceDoc = await admin.firestore()
                .doc("GameConfig/maintenance")
                .get();

            if (!maintenanceDoc.exists) {
                console.log("[getMaintenanceStatus] No maintenance document found");
                return { exists: false, data: null };
            }

            const data = maintenanceDoc.data();
            console.log("[getMaintenanceStatus] Returning maintenance data");

            return {
                exists: true,
                data: {
                    maintenance: data?.maintenance || false,
                    enabled: data?.enabled || false,
                    rewardGems: data?.rewardGems || 100,
                    scheduledMaintenanceTime: data?.scheduledMaintenanceTime || null,
                    delayMinutes: data?.delayMinutes || null,
                    durationMinutes: data?.durationMinutes || null,
                    maintenanceEndTime: data?.maintenanceEndTime || null,
                    activeHistoryId: data?.activeHistoryId || null,
                    updatedAt: data?.updatedAt?.toMillis?.() || data?.updatedAt || null,
                    updatedBy: data?.updatedBy || null,
                }
            };
        } catch (error) {
            console.error("[getMaintenanceStatus] Firestore error:", error);
            throw new HttpsError("internal", "Failed to get maintenance status");
        }
    }
);

/**
 * Get maintenance history.
 * This function uses the Admin SDK which bypasses App Check,
 * allowing the admin website to read maintenance history without App Check.
 * 
 * @returns List of maintenance history records
 */
export const getMaintenanceHistory = onCall(
    { region: REGION, enforceAppCheck: false },
    async (request) => {
        console.log("[getMaintenanceHistory] Starting...");

        // Check if user is authenticated
        if (!request.auth) {
            console.log("[getMaintenanceHistory] No auth context - unauthenticated");
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const uid = request.auth.uid;
        const { startAfter, limit: requestLimit } = request.data || {};
        const pageLimit = requestLimit || 10;

        console.log("[getMaintenanceHistory] Checking user:", uid, "limit:", pageLimit);

        // Verify user is an admin
        const adminDoc = await admin.firestore()
            .collection("AdminUsers")
            .doc(uid)
            .get();

        if (!adminDoc.exists || adminDoc.data()?.role !== "admin") {
            console.log("[getMaintenanceHistory] User is not an admin");
            throw new HttpsError("permission-denied", "User must be an admin");
        }

        try {
            let query = admin.firestore()
                .collection("MaintenanceHistory")
                .orderBy("startedAt", "desc")
                .limit(pageLimit);

            // Handle pagination
            if (startAfter) {
                query = query.startAfter(startAfter);
            }

            const snapshot = await query.get();
            console.log("[getMaintenanceHistory] Found", snapshot.size, "documents");

            const history = snapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    startedAt: data.startedAt || null,
                    startedBy: data.startedBy || null,
                    endedAt: data.endedAt || null,
                    endedBy: data.endedBy || null,
                    duration: data.duration || null,
                    immediate: data.immediate ?? true,
                    delayMinutes: data.delayMinutes || 0,
                    rewardGems: data.rewardGems || 100,
                    durationMinutes: data.durationMinutes || null,
                    scheduledActivationTime: data.scheduledActivationTime || null,
                };
            });

            return { history };
        } catch (error) {
            console.error("[getMaintenanceHistory] Firestore error:", error);
            throw new HttpsError("internal", "Failed to get maintenance history");
        }
    }
);
