// functions/test/helpers/cleanup.ts
if (process.env.USE_UNIFIED_SKUS === undefined) {
  process.env.USE_UNIFIED_SKUS = "true";
}
if (process.env.USE_ITEMID_V2 === undefined) {
  process.env.USE_ITEMID_V2 = "false";
}

import fetch from "node-fetch";
import * as admin from "firebase-admin";
import { seedGameDataCatalogs } from "../../seeds/seedGameData";
import { loadStarterRewards } from "../../src/shared/starterRewards";
import { loadStarterSpellIds } from "../../src/shared/catalogHelpers";
import { initializeUserIfNeeded } from "../../src/shared/initializeUser";
import { __resetCachedFlagsForTests } from "../../src/core/flags";
import { __resetCatalogCacheForTests } from "../../src/core/config";

const resetTestFeatureFlags = () => {
  __resetCachedFlagsForTests();
  __resetCatalogCacheForTests();
};

resetTestFeatureFlags();

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || "demo-test";

let catalogSeedPromise: Promise<void> | null = null;

export const ensureCatalogsSeeded = async (): Promise<void> => {
  if (!catalogSeedPromise) {
    console.log("[cleanup] ensureCatalogsSeeded: seeding GameData catalogs");
    resetTestFeatureFlags();
    catalogSeedPromise = seedGameDataCatalogs().catch((error) => {
      catalogSeedPromise = null;
      throw error;
    });
  }
  await catalogSeedPromise;
  console.log("[cleanup] ensureCatalogsSeeded: catalogs ready");
};

export async function wipeFirestore() {
  const fsHost = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:6767";
  // Firestore emulator wipe
  await fetch(`http://${fsHost}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, {
    method: "DELETE",
  });
  catalogSeedPromise = null;
  resetTestFeatureFlags();
}

export async function wipeAuth() {
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:6768";
  // Auth emulator wipe
  await fetch(`http://${authHost}/emulator/v1/projects/${PROJECT_ID}/accounts`, {
    method: "DELETE",
  });
  resetTestFeatureFlags();
}

export async function seedMinimalPlayer(uid: string) {
  const db = admin.firestore();
  resetTestFeatureFlags();
  await ensureCatalogsSeeded();
  const starterSpellIds = await loadStarterSpellIds();
  const starterDeckIds = Array.from(new Set(starterSpellIds)).slice(0, 5);
  const starterRewards = await loadStarterRewards();
  await initializeUserIfNeeded(uid, ["anonymous"], { isGuest: true });

  // Ensure starter deck aligns with unified starter spells.
  const deckSize = 5;
  const starterDeck = Array.from(
    { length: deckSize },
    (_, idx) => starterDeckIds[idx] ?? "",
  );
  const now = admin.firestore.FieldValue.serverTimestamp();

  await db.doc(`Players/${uid}/SpellDecks/Decks`).set(
    {
      active: 1,
      decks: {
        "1": { name: "Primary", spells: starterDeck },
      },
      updatedAt: now,
    },
    { merge: true },
  );

  const levels: Record<string, number> = {};
  const unlockedAt: Record<string, unknown> = {};
  starterDeckIds.forEach((spellId) => {
    levels[spellId] = 1;
    unlockedAt[spellId] = now;
  });

  await db.doc(`Players/${uid}/Spells/Levels`).set(
    {
      levels,
      unlockedAt,
      updatedAt: now,
    },
    { merge: false },
  );

  // Ensure starter inventory quantities exist for downstream tests.
  const starterInventory = [starterRewards.crateSkuId, starterRewards.keySkuId];
  for (const skuId of starterInventory) {
    await db.doc(`Players/${uid}/Inventory/${skuId}`).set(
      {
        skuId,
        qty: 1,
        quantity: 1,
        createdAt: now,
        updatedAt: now,
      },
      { merge: true },
    );
  }

  await db.doc(`Players/${uid}/Inventory/Consumables`).set(
    {
      counts: {
        [starterRewards.crateSkuId]: 1,
        [starterRewards.keySkuId]: 1,
      },
      updatedAt: now,
    },
    { merge: true },
  );

  await db.doc(`Players/${uid}/Inventory/Cosmetics`).set(
    {
      owned: {},
      updatedAt: now,
    },
    { merge: true },
  );

  await db.doc(`Players/${uid}/Economy/Stats`).set(
    {
      gems: 5000,
      updatedAt: now,
    },
    { merge: true },
  );
}
