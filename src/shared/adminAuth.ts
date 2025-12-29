import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

const db = admin.firestore();

/**
 * Verifies that the authenticated user has admin privileges.
 * Checks if the user's UID exists in the /AdminUsers collection.
 * 
 * @param uid - The Firebase Auth UID to check
 * @throws HttpsError if user is not an admin
 */
export async function assertIsAdmin(uid: string): Promise<void> {
  const adminUserRef = db.doc(`/AdminUsers/${uid}`);
  const adminUserDoc = await adminUserRef.get();

  if (!adminUserDoc.exists) {
    throw new HttpsError(
      "permission-denied",
      "User does not have admin privileges."
    );
  }

  const adminData = adminUserDoc.data();
  if (adminData?.role !== "admin") {
    throw new HttpsError(
      "permission-denied",
      "User does not have admin role."
    );
  }
}

/**
 * Checks if a user is an admin without throwing an error.
 * 
 * @param uid - The Firebase Auth UID to check
 * @returns true if user is an admin, false otherwise
 */
export async function isAdmin(uid: string): Promise<boolean> {
  try {
    const adminUserRef = db.doc(`/AdminUsers/${uid}`);
    const adminUserDoc = await adminUserRef.get();
    
    if (!adminUserDoc.exists) {
      return false;
    }

    const adminData = adminUserDoc.data();
    return adminData?.role === "admin";
  } catch (error) {
    console.error("[isAdmin] Error checking admin status:", error);
    return false;
  }
}
