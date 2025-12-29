import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region";
import { assertIsAdmin } from "../shared/adminAuth";

const db = admin.firestore();

// --- Set Minimum Version ---

interface SetMinimumVersionRequest {
    version: string;
}

interface SetMinimumVersionResponse {
    success: boolean;
    version: string;
    updatedAt: number;
    updatedBy: string;
}

/**
 * Validates version string format (e.g., "1.2.3")
 */
function validateVersionFormat(version: string): boolean {
    const versionRegex = /^\d+\.\d+\.\d+$/;
    return versionRegex.test(version);
}

export const setMinimumVersion = onCall({ region: REGION }, async (request) => {
    const uid = request.auth?.uid;

    if (!uid) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
    }

    // Verify admin privileges
    await assertIsAdmin(uid);

    const { version } = request.data as SetMinimumVersionRequest;

    if (!version || typeof version !== "string") {
        throw new HttpsError("invalid-argument", "version is required and must be a string.");
    }

    if (!validateVersionFormat(version)) {
        throw new HttpsError(
            "invalid-argument",
            "version must be in format X.Y.Z (e.g., '1.2.3')."
        );
    }

    const versionRef = db.doc("/GameConfig/appVersion");
    const timestamp = Date.now();

    // Get current version before updating (for history tracking)
    const currentVersionDoc = await versionRef.get();
    const oldVersion = currentVersionDoc.exists ? currentVersionDoc.data()?.minimumVersion : null;

    // Create history entry
    const historyRef = db.collection("/VersionHistory").doc();
    await historyRef.set({
        oldVersion: oldVersion,
        newVersion: version,
        changedBy: uid,
        changedAt: timestamp,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update the current version
    const versionData = {
        minimumVersion: version,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: uid,
    };

    await versionRef.set(versionData, { merge: true });

    return {
        success: true,
        version,
        updatedAt: timestamp,
        updatedBy: uid,
    } as SetMinimumVersionResponse;
});

// --- Get Minimum Version ---

interface GetMinimumVersionResponse {
    version: string;
    updatedAt?: number;
    updatedBy?: string;
}

export const getMinimumVersion = onCall({ region: REGION }, async (request) => {
    const uid = request.auth?.uid;

    if (!uid) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
    }

    // Verify admin privileges
    await assertIsAdmin(uid);

    const versionRef = db.doc("/GameConfig/appVersion");
    const versionDoc = await versionRef.get();

    if (!versionDoc.exists) {
        // Return default or environment variable version
        const envVersion = process.env.MIN_SUPPORTED_APP_VERSION || "1.0.0";
        return {
            version: envVersion,
        } as GetMinimumVersionResponse;
    }

    const data = versionDoc.data();
    return {
        version: data?.minimumVersion || "1.0.0",
        updatedAt: data?.updatedAt?.toMillis?.(),
        updatedBy: data?.updatedBy,
    } as GetMinimumVersionResponse;
});
