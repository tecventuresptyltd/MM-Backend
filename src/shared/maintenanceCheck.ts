import { HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

/**
 * Server-side maintenance check with game admin bypass
 * 
 * This function enforces maintenance mode by:
 * 1. Using SERVER timestamps (immune to client time manipulation)
 * 2. Checking if user is a game admin (can bypass for testing)
 * 3. Throwing error if maintenance is active and user is not admin
 * 
 * @param uid - User ID to check admin status for
 * @throws HttpsError if maintenance is active and user is not admin
 */
export async function assertNotInMaintenance(uid?: string): Promise<void> {
    const db = admin.firestore();

    // Get maintenance status
    const maintenanceRef = db.doc('/GameConfig/maintenance');
    const maintenanceDoc = await maintenanceRef.get();

    if (!maintenanceDoc.exists) {
        return; // No maintenance config = allow
    }

    const data = maintenanceDoc.data()!;
    const enabled = data.enabled || data.maintenance || false;

    if (!enabled) {
        return; // Maintenance disabled = allow
    }

    // Check if maintenance is currently enforced (using SERVER time)
    const scheduledTime = data.scheduledMaintenanceTime;
    const now = Date.now(); // SERVER timestamp - cannot be manipulated!

    // If scheduled time exists and hasn't passed yet, allow (warning period)
    if (scheduledTime && now < scheduledTime) {
        return; // Still in warning period
    }

    // Maintenance is enforced - check if user is a game admin
    if (uid) {
        const playerRef = db.doc(`/Players/${uid}`);
        const playerDoc = await playerRef.get();

        if (playerDoc.exists) {
            const playerData = playerDoc.data();
            const isGameAdmin = playerData?.isGameAdmin === true;

            if (isGameAdmin) {
                // Game admin bypass - allow access for testing
                console.log(`Game admin ${uid} bypassing maintenance`);
                return;
            }
        }
    }

    // Maintenance is active and user is not admin - BLOCK!
    throw new HttpsError(
        'unavailable',
        'Game is currently undergoing maintenance. Please try again later.',
        {
            maintenanceActive: true,
            rewardGems: data.rewardGems || 0,
            rewardAvailable: data.rewardAvailable || false,
        }
    );
}

/**
 * Check if a user is a game admin
 * @param uid - User ID to check
 * @returns true if user is a game admin
 */
export async function isGameAdmin(uid: string): Promise<boolean> {
    const db = admin.firestore();
    const playerRef = db.doc(`/Players/${uid}`);
    const playerDoc = await playerRef.get();

    if (!playerDoc.exists) {
        return false;
    }

    const playerData = playerDoc.data();
    return playerData?.isGameAdmin === true;
}
