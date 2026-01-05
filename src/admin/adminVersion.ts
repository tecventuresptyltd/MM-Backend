import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { REGION } from "../shared/region.js";

/**
 * Get current app version.
 * This function uses the Admin SDK which bypasses App Check,
 * allowing the admin website to read version status without App Check.
 * 
 * @returns Current version configuration
 */
export const getAdminVersionStatus = onCall(
    { region: REGION, enforceAppCheck: false },
    async (request) => {
        console.log("[getAdminVersionStatus] Starting...");

        // Check if user is authenticated
        if (!request.auth) {
            console.log("[getAdminVersionStatus] No auth context - unauthenticated");
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const uid = request.auth.uid;
        console.log("[getAdminVersionStatus] Checking user:", uid);

        // Verify user is an admin
        const adminDoc = await admin.firestore()
            .collection("AdminUsers")
            .doc(uid)
            .get();

        if (!adminDoc.exists || adminDoc.data()?.role !== "admin") {
            console.log("[getAdminVersionStatus] User is not an admin");
            throw new HttpsError("permission-denied", "User must be an admin");
        }

        try {
            const versionDoc = await admin.firestore()
                .doc("GameConfig/appVersion")
                .get();

            if (!versionDoc.exists) {
                console.log("[getAdminVersionStatus] No version document found");
                const envVersion = process.env.MIN_SUPPORTED_APP_VERSION || "1.0.0";
                return {
                    exists: false,
                    data: {
                        minimumVersion: envVersion,
                    }
                };
            }

            const data = versionDoc.data();
            console.log("[getAdminVersionStatus] Returning version data");

            return {
                exists: true,
                data: {
                    minimumVersion: data?.minimumVersion || "1.0.0",
                    updatedAt: data?.updatedAt?.toMillis?.() || data?.updatedAt || null,
                    updatedBy: data?.updatedBy || null,
                }
            };
        } catch (error) {
            console.error("[getAdminVersionStatus] Firestore error:", error);
            throw new HttpsError("internal", "Failed to get version status");
        }
    }
);

/**
 * Get version history.
 * This function uses the Admin SDK which bypasses App Check,
 * allowing the admin website to read version history without App Check.
 * 
 * @returns List of version history records
 */
export const getVersionHistory = onCall(
    { region: REGION, enforceAppCheck: false },
    async (request) => {
        console.log("[getVersionHistory] Starting...");

        // Check if user is authenticated
        if (!request.auth) {
            console.log("[getVersionHistory] No auth context - unauthenticated");
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const uid = request.auth.uid;
        const { limit: requestLimit } = request.data || {};
        const pageLimit = requestLimit || 20;

        console.log("[getVersionHistory] Checking user:", uid, "limit:", pageLimit);

        // Verify user is an admin
        const adminDoc = await admin.firestore()
            .collection("AdminUsers")
            .doc(uid)
            .get();

        if (!adminDoc.exists || adminDoc.data()?.role !== "admin") {
            console.log("[getVersionHistory] User is not an admin");
            throw new HttpsError("permission-denied", "User must be an admin");
        }

        try {
            const snapshot = await admin.firestore()
                .collection("VersionHistory")
                .orderBy("changedAt", "desc")
                .limit(pageLimit)
                .get();

            console.log("[getVersionHistory] Found", snapshot.size, "documents");

            const history = snapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    oldVersion: data.oldVersion || null,
                    newVersion: data.newVersion || null,
                    changedBy: data.changedBy || null,
                    changedAt: data.changedAt || null,
                };
            });

            return { history };
        } catch (error) {
            console.error("[getVersionHistory] Firestore error:", error);
            throw new HttpsError("internal", "Failed to get version history");
        }
    }
);
