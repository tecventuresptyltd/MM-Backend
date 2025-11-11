import * as admin from "firebase-admin";

export const db = admin.firestore();

// --- Account Helper Collections ---

export interface DeviceAnchorDoc {
  uid: string;
  platform?: "ios" | "android" | "windows" | "mac" | "linux";
  appVersion?: string;
  createdAt: admin.firestore.Timestamp;
  lastSeenAt: admin.firestore.Timestamp;
}

export interface EmailDoc {
  uid: string;
  createdAt: admin.firestore.Timestamp;
  updatedAt: admin.firestore.Timestamp;
}

export interface ProviderDoc {
  providers: string[];
  lastLinkedAt: admin.firestore.Timestamp;
}

// --- Player Document Additions ---

export interface PlayerDoc {
  uid: string;
  isGuest: boolean;
  authProviders: string[];
  createdAt: admin.firestore.Timestamp;
  updatedAt: admin.firestore.Timestamp;
  // Other existing fields like displayName, email, etc.
}

export interface PlayerMetaInitDoc {
  initialized: boolean;
  version: string;
  createdAt: admin.firestore.Timestamp;
}

// --- Transactional Wrapper ---

export async function withTransaction<T>(
  work: (transaction: admin.firestore.Transaction) => Promise<T>
): Promise<T> {
  return db.runTransaction(work);
}
