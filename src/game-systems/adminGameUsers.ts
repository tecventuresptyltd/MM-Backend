import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { REGION } from '../shared/region';
import { assertIsAdmin } from '../shared/adminAuth';
import { callableOptions } from '../shared/callableOptions';

interface SearchUsersRequest {
    query: string; // Username, email, or UID
    limit?: number;
}

interface SearchUsersResponse {
    users: Array<{
        uid: string;
        username: string;
        email: string;
        isGameAdmin: boolean;
        createdAt?: number;
    }>;
}

interface SetGameAdminRequest {
    targetUid: string;
    isGameAdmin: boolean;
}

interface SetGameAdminResponse {
    success: boolean;
    uid: string;
    isGameAdmin: boolean;
}

interface GetGameAdminsResponse {
    admins: Array<{
        uid: string;
        username: string;
        email: string;
    }>;
}

/**
 * Search for game users by username, email, or UID
 * Only accessible by Firebase admins
 */
export const searchGameUsers = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
    const { auth } = request;

    if (!auth) {
        throw new HttpsError('unauthenticated', 'User must be authenticated.');
    }

    const uid = auth.uid;

    // Verify Firebase admin privileges
    await assertIsAdmin(uid);

    const { query, limit = 20 } = request.data as SearchUsersRequest;

    if (!query || query.trim().length === 0) {
        throw new HttpsError('invalid-argument', 'Search query cannot be empty');
    }

    const db = admin.firestore();
    const users: SearchUsersResponse['users'] = [];

    console.log(`Searching for player by UID: "${query}"`);

    // Search by exact UID only (simplified for reliability)
    try {
        const playerRootRef = db.doc(`/Players/${query}`);
        const playerRootDoc = await playerRootRef.get();

        if (!playerRootDoc.exists) {
            console.log(`Player ${query} not found`);
            return { users: [] } as SearchUsersResponse;
        }

        const rootData = playerRootDoc.data();

        // Try to get profile info if it exists
        let username = 'Unknown';
        let email = '';
        let createdAt: number | undefined;

        try {
            const playerProfileRef = db.doc(`/Players/${query}/Profile/info`);
            const playerProfileDoc = await playerProfileRef.get();

            if (playerProfileDoc.exists) {
                const profileData = playerProfileDoc.data();
                username = profileData?.username || 'Unknown';
                email = profileData?.email || '';
                createdAt = profileData?.createdAt;
            } else {
                console.log(`Profile/info not found for ${query}, using defaults`);
            }
        } catch (profileError) {
            console.error(`Error reading profile for ${query}:`, profileError);
            // Continue with defaults
        }

        users.push({
            uid: query,
            username,
            email,
            isGameAdmin: rootData?.isGameAdmin === true,
            createdAt,
        });

        console.log(`Found player ${query} - username: ${username}, isGameAdmin: ${rootData?.isGameAdmin}`);
    } catch (error) {
        console.error(`Error searching for UID ${query}:`, error);
    }

    return { users } as SearchUsersResponse;
});

/**
 * Set game admin status for a user
 * Only accessible by Firebase admins
 */
export const setGameAdminStatus = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
    const { auth } = request;

    if (!auth) {
        throw new HttpsError('unauthenticated', 'User must be authenticated.');
    }

    const uid = auth.uid;

    // Verify Firebase admin privileges
    await assertIsAdmin(uid);

    const { targetUid, isGameAdmin } = request.data as SetGameAdminRequest;

    if (!targetUid) {
        throw new HttpsError('invalid-argument', 'Target UID is required');
    }

    if (typeof isGameAdmin !== 'boolean') {
        throw new HttpsError('invalid-argument', 'isGameAdmin must be a boolean');
    }

    const db = admin.firestore();
    const playerRootRef = db.doc(`/Players/${targetUid}`);
    const playerDoc = await playerRootRef.get();

    if (!playerDoc.exists) {
        throw new HttpsError('not-found', 'Player not found');
    }

    // Update isGameAdmin field on root player document
    await playerRootRef.update({
        isGameAdmin,
        gameAdminUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        gameAdminUpdatedBy: uid,
    });

    console.log(`Firebase admin ${uid} set game admin status for ${targetUid} to ${isGameAdmin}`);

    return {
        success: true,
        uid: targetUid,
        isGameAdmin,
    } as SetGameAdminResponse;
});

interface AdminPinPlayerLevelRequest {
    targetUid: string;
    level?: number;
}

/**
 * Pin a player's mastery rank to a specific level permanently.
 * After each race, the level is preserved regardless of XP earned.
 * Pass level=0 to remove the pin and restore normal XP-based progression.
 * Only accessible by Firebase admins.
 */
export const adminPinPlayerLevel = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
    const { auth } = request;

    if (!auth) {
        throw new HttpsError('unauthenticated', 'User must be authenticated.');
    }

    await assertIsAdmin(auth.uid);

    const { targetUid, level = 100 } = request.data as AdminPinPlayerLevelRequest;

    if (!targetUid || typeof targetUid !== 'string') {
        throw new HttpsError('invalid-argument', 'targetUid is required.');
    }

    if (typeof level !== 'number' || level < 0) {
        throw new HttpsError('invalid-argument', 'level must be a non-negative number.');
    }

    const db = admin.firestore();
    const profileRef = db.doc(`/Players/${targetUid}/Profile/Profile`);
    const profileDoc = await profileRef.get();

    if (!profileDoc.exists) {
        throw new HttpsError('not-found', `Player profile not found for uid: ${targetUid}`);
    }

    if (level === 0) {
        // Remove the pin — player returns to normal XP-based progression
        await profileRef.update({
            pinnedMasteryRank: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`Admin ${auth.uid} removed mastery rank pin for player ${targetUid}`);
        return { success: true, uid: targetUid, pinnedMasteryRank: null };
    }

    await profileRef.update({
        pinnedMasteryRank: level,
        masteryRank: level,
        level: level,
        expProgress: 0,
        expToNextLevel: 0,
        expProgressDisplay: 'Max Rank',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Admin ${auth.uid} pinned player ${targetUid} to mastery rank ${level}`);
    return { success: true, uid: targetUid, pinnedMasteryRank: level };
});

/**
 * Get list of all current game admins
 * Only accessible by Firebase admins
 */
export const getGameAdmins = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
    const { auth } = request;

    if (!auth) {
        throw new HttpsError('unauthenticated', 'User must be authenticated.');
    }

    const uid = auth.uid;

    // Verify Firebase admin privileges
    await assertIsAdmin(uid);

    const db = admin.firestore();
    const admins: GetGameAdminsResponse['admins'] = [];

    // Query all players (this could be optimized with an index)
    const playersSnapshot = await db.collection('Players').get();

    for (const playerDoc of playersSnapshot.docs) {
        const rootData = playerDoc.data();

        // Check isGameAdmin on root document
        if (rootData?.isGameAdmin === true) {
            const profileRef = playerDoc.ref.collection('Profile').doc('info');
            const profileDoc = await profileRef.get();

            const profileData = profileDoc.exists ? profileDoc.data() : {};

            admins.push({
                uid: playerDoc.id,
                username: profileData?.username || 'Unknown',
                email: profileData?.email || '',
            });
        }
    }

    return { admins } as GetGameAdminsResponse;
});
