import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { REGION } from "../region.js";

/**
 * Verify if the authenticated user is an admin.
 * This function uses the Admin SDK which bypasses App Check,
 * allowing the admin website to check admin status without App Check.
 * 
 * @returns Admin status and permissions
 */
export const verifyAdminStatus = onCall(
    { region: REGION, enforceAppCheck: false },
    async (request) => {
        console.log("[verifyAdminStatus] Starting admin verification...");

        // Check if user is authenticated
        if (!request.auth) {
            console.log("[verifyAdminStatus] No auth context - unauthenticated");
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const uid = request.auth.uid;
        const email = request.auth.token?.email || "unknown";
        console.log("[verifyAdminStatus] Checking user:", uid, email);

        try {
            const adminDoc = await admin.firestore()
                .collection("AdminUsers")
                .doc(uid)
                .get();

            if (!adminDoc.exists) {
                console.log("[verifyAdminStatus] User is NOT an admin - doc does not exist");
                return {
                    isAdmin: false,
                    canViewAnalytics: false,
                };
            }

            const data = adminDoc.data();
            console.log("[verifyAdminStatus] Admin doc found:", JSON.stringify(data));

            const isAdmin = data?.role === "admin";

            return {
                isAdmin,
                canViewAnalytics: data?.canViewAnalytics === true,
                displayName: data?.displayName || email,
                email: data?.email || email,
                photoURL: data?.photoURL,
                role: data?.role,
            };
        } catch (error) {
            console.error("[verifyAdminStatus] Firestore error:", error);
            throw new HttpsError("internal", "Failed to verify admin status");
        }
    }
);
