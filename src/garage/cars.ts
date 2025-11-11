import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import { getCarsCatalog } from "../core/config.js";

const db = admin.firestore();

// --- Purchase Car ---

interface PurchaseCarRequest {
  carId: string;
  opId: string;
}

interface PurchaseCarResponse {
  success: boolean;
  opId: string;
  carId: string;
}

export const purchaseCar = onCall({ region: REGION }, async (request) => {
  const { carId, opId } = request.data as PurchaseCarRequest;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!carId || !opId) {
    throw new HttpsError("invalid-argument", "Missing required parameters.");
  }

  try {
    const idempotencyResult = await checkIdempotency(uid, opId);
    if (idempotencyResult) {
      return idempotencyResult;
    }

    await createInProgressReceipt(uid, opId, "purchaseCar");

    const carsCatalog = await getCarsCatalog();
    const carData = carsCatalog[carId];
    if (!carData) {
      throw new HttpsError("not-found", "Car not found in GameData.");
    }
    const price = carData.basePrice;

    return await runTransactionWithReceipt<PurchaseCarResponse>(
      uid,
      opId,
      "purchaseCar",
      async (transaction) => {
        const playerStatsRef = db.doc(`/Players/${uid}/Economy/Stats`);
        const playerCarRef = db.doc(`/Players/${uid}/Garage/${carId}`);

        const playerStatsDoc = await transaction.get(playerStatsRef);
        const playerCarDoc = await transaction.get(playerCarRef);

        if (!playerStatsDoc.exists) {
          throw new HttpsError("not-found", "Player stats not found.");
        }
        if (playerCarDoc.exists) {
          throw new HttpsError("already-exists", "Player already owns this car.");
        }

        const playerStats = playerStatsDoc.data()!;
        if (playerStats.coins < price) {
          throw new HttpsError("failed-precondition", "Insufficient coins.");
        }

        transaction.update(playerStatsRef, {
          coins: admin.firestore.FieldValue.increment(-price),
        });

        transaction.set(
          playerCarRef,
          {
            carId,
            upgradeLevel: 0,
            tuning: {},
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        return {
          success: true,
          opId,
          carId,
        };
      }
    );
  } catch (error) {
    const e = error as Error;
    throw new HttpsError("internal", e.message, e);
  }
});

// --- Upgrade Car ---

interface UpgradeCarRequest {
  carId: string;
  opId: string;
}

interface UpgradeCarResponse {
  success: boolean;
  opId: string;
  carId: string;
  levelAfter: number;
}

export const upgradeCar = onCall({ region: REGION }, async (request) => {
  const { carId, opId } = request.data as UpgradeCarRequest;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!carId || !opId) {
    throw new HttpsError("invalid-argument", "Missing required parameters.");
  }

  try {
    const idempotencyResult = await checkIdempotency(uid, opId);
    if (idempotencyResult) {
      return idempotencyResult;
    }

    await createInProgressReceipt(uid, opId, "upgradeCar");

    const carsCatalog = await getCarsCatalog();
    const carData = carsCatalog[carId];
    if (!carData) {
      throw new HttpsError("not-found", "Car not found in GameData.");
    }

    return await runTransactionWithReceipt<UpgradeCarResponse>(
      uid,
      opId,
      "upgradeCar",
      async (transaction) => {
        const playerStatsRef = db.doc(`/Players/${uid}/Economy/Stats`);
        const playerCarRef = db.doc(`/Players/${uid}/Garage/${carId}`);

        const playerStatsDoc = await transaction.get(playerStatsRef);
        const playerCarDoc = await transaction.get(playerCarRef);

        if (!playerStatsDoc.exists) {
          throw new HttpsError("not-found", "Player stats not found.");
        }
        if (!playerCarDoc.exists) {
          throw new HttpsError("not-found", "Player does not own this car.");
        }

        const playerStats = playerStatsDoc.data()!;
        const playerCar = playerCarDoc.data()!;
        const currentLevel = playerCar.upgradeLevel || 0;
        const nextLevel = currentLevel + 1;
        const upgradeCost = carData.levels?.[String(nextLevel)]?.priceCoins;

        if (upgradeCost === undefined) {
          throw new HttpsError("failed-precondition", "Car is already at max level.");
        }
        if (playerStats.coins < upgradeCost) {
          throw new HttpsError("failed-precondition", "Insufficient coins.");
        }

        transaction.update(playerStatsRef, {
          coins: admin.firestore.FieldValue.increment(-upgradeCost),
        });

        transaction.update(playerCarRef, {
          upgradeLevel: nextLevel,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
          success: true,
          opId,
          carId,
          levelAfter: nextLevel,
        };
      }
    );
  } catch (error) {
    const e = error as Error;
    throw new HttpsError("internal", e.message, e);
  }
});
