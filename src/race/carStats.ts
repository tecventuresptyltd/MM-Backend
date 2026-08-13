import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { getCarsCatalog, getCarTuningConfig } from "../core/config.js";
import { resolveCarStats, resolveCarLevel } from "./lib/stats.js";

const db = admin.firestore();

/**
 * ═══════════════════════════════════════════════════════════════
 * getCarStats — read-only physics stats for a car
 * ═══════════════════════════════════════════════════════════════
 *
 * Why this exists:
 *   A car's real physics values (top speed, acceleration, handling, boost) are
 *   computed server-side and returned by prepareRace as its `carStats.real` block.
 *   The open-world lobby needs the same numbers, but prepareRace is NOT a read —
 *   it mints a raceId and pre-deducts trophies, so calling it to look up stats
 *   would charge the player every time they entered the lobby.
 *
 *   This function returns the identical block with no writes and no side effects.
 *
 * Drift safety:
 *   It calls the SAME shared helpers prepareRace uses — resolveCarLevel() and
 *   resolveCarStats() from ./lib/stats.js. There is no second copy of the formula.
 *   Do not inline the maths here; if the two ever diverge, cars will handle
 *   differently in the lobby than in a race and that is very hard to spot.
 *
 * Note on aiLevel / performanceRanges:
 *   Those are bot-only fields that prepareRace bolts on after resolveCarStats.
 *   The player payload has never included them, so this function doesn't either.
 *   The Unity client reads missing keys as 0, which matches race behaviour exactly.
 */

// #region Types

interface GetCarStatsRequest {
  /** Optional. Defaults to the player's currently equipped car. */
  carId?: string;
  /** Optional. Defaults to the player's owned upgrade level for that car. */
  carLevel?: number;
}

// #endregion

// #region Callable

export const getCarStats = onCall(
  callableOptions({ memory: "256MiB", cpu: 1, concurrency: 80 }),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "User must be authenticated.");
    }

    const { carId: requestedCarId, carLevel: requestedLevel } =
      (request.data ?? {}) as GetCarStatsRequest;

    if (requestedCarId !== undefined && typeof requestedCarId !== "string") {
      throw new HttpsError("invalid-argument", "carId must be a string when provided.");
    }
    if (
      requestedLevel !== undefined &&
      (typeof requestedLevel !== "number" || !Number.isFinite(requestedLevel) || requestedLevel < 0)
    ) {
      throw new HttpsError("invalid-argument", "carLevel must be a non-negative number when provided.");
    }

    // One round trip for both player docs, and the catalogs are served from the
    // in-memory 60s cache in core/config.ts — so a repeat call is effectively free.
    const loadoutRef = db.doc(`/Players/${uid}/Loadouts/Active`);
    const garageRef = db.doc(`/Players/${uid}/Garage/Cars`);

    const [[loadoutDoc, garageDoc], carsCatalog, tuning] = await Promise.all([
      db.getAll(loadoutRef, garageRef),
      getCarsCatalog(),
      getCarTuningConfig(),
    ]);

    const loadout = loadoutDoc.data() ?? {};
    const garage = garageDoc.data() ?? {};

    // Resolve the car the same way prepareRace does: explicit id → equipped car → first in catalog.
    const carId: string = requestedCarId || loadout.carId || Object.keys(carsCatalog)[0];
    const car = carsCatalog[carId];
    if (!car) {
      throw new HttpsError("not-found", `Car '${carId}' not found in catalog.`);
    }

    // Same level-resolution precedence as prepareRace (carLevel → starLevel → upgradeLevel → 1).
    const ownedCar = (garage.cars ?? {})[carId];
    const level = Number(
      requestedLevel ??
      ownedCar?.carLevel ??
      ownedCar?.starLevel ??
      ownedCar?.upgradeLevel ??
      1
    );

    const carLevelData = resolveCarLevel(car, level);
    const stats = resolveCarStats(carLevelData, tuning, false);

    logger.info("[getCarStats] Resolved", { uid, carId, level, real: stats.real });

    return {
      carId,
      carLevel: level,
      real: stats.real,
      display: stats.display,
    };
  }
);

// #endregion
