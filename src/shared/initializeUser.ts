import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { loadStarterRewards } from "./starterRewards.js";
import { loadStarterSpellIds } from "./catalogHelpers.js";
import { resolveInventoryContext } from "./inventory.js";
import { getReferralConfig, listSkusByFilter, resolveSkuOrThrow } from "../core/config.js";
import { createDefaultReferralStats } from "../referral/constants.js";
import {
  prepareReferralCodePlan,
  applyReferralCodePlan,
} from "../referral/codes.js";
import {
  createTxSkuDocState,
  createTxInventorySummaryState,
  txIncSkuQty,
  txUpdateInventorySummary,
} from "../inventory/index.js";
import { runReadThenWrite } from "../core/tx.js";
import { ReferralConfig } from "../referral/types.js";
import { getLevelInfo } from "./xp.js";
import { refreshPlayerLeaderboardSnapshots } from "../Socials/liveLeaderboard.js";

const db = admin.firestore();

const STARTER_INIT_RECEIPT_ID = "initializeUser.starterRewards";
const FULL_INVENTORY_EMAIL_MATCH = "2011421";
interface InitializeOptions {
  isGuest?: boolean;
  email?: string | null;
  opId?: string | null;
  authUser?: admin.auth.UserRecord | null;
}

const DEFAULT_PROFILE = (displayName: string, now: admin.firestore.FieldValue) => {
  const levelInfo = getLevelInfo(0);
  const expRequiredForNextLevel = levelInfo.expInLevel + levelInfo.expToNext;
  return {
    displayName,
    avatarId: 1,
    exp: 0,
    level: 1,
    expProgress: levelInfo.expInLevel,
    expToNextLevel: expRequiredForNextLevel,
    expProgressDisplay: `${levelInfo.expInLevel} / ${expRequiredForNextLevel}`,
    trophies: 0,
    highestTrophies: 0,
    careerCoins: 0,
    totalWins: 0,
    totalRaces: 0,
    clanId: null as string | null,
    clanName: null as string | null,
    clanBadge: null as string | null,
    dailyStreak: 0,
    dailyCooldownUntil: null,
    boosters: {},
    referralCode: null as string | null,
    referredBy: null,
    referralStats: createDefaultReferralStats(),
    bindingRewardClaimed: false,
    bindingRewardGrantedAt: null as admin.firestore.FieldValue | null,
    updatedAt: now,
  };
};

const DEFAULT_ECONOMY = (now: admin.firestore.FieldValue) => ({
  coins: 1000,
  gems: 0,
  spellTokens: 0,
  createdAt: now,
  updatedAt: now,
});

const buildDefaultSpellDecks = (
  defaultSpellIds: string[],
  now: admin.firestore.FieldValue,
) => {
  const deckSize = 5;
  const starterDeck = Array.from(
    { length: deckSize },
    (_, idx) => defaultSpellIds[idx] ?? "",
  );
  return {
    active: 1,
    decks: {
      "1": { name: "Starter", spells: starterDeck },
      "2": { name: "Deck 2", spells: ["", "", "", "", ""] },
      "3": { name: "Deck 3", spells: ["", "", "", "", ""] },
      "4": { name: "Deck 4", spells: ["", "", "", "", ""] },
      "5": { name: "Deck 5", spells: ["", "", "", "", ""] },
    },
    updatedAt: now,
  };
};

const buildDefaultSpells = (
  defaultSpellIds: string[],
  now: admin.firestore.FieldValue,
) => {
  const levels: Record<string, number> = {};
  const unlockedAt: Record<string, admin.firestore.FieldValue> = {};
  defaultSpellIds.forEach((spellId) => {
    levels[spellId] = 1;
    unlockedAt[spellId] = now;
  });
  return {
    levels,
    unlockedAt,
    updatedAt: now,
  };
};

const DEFAULT_GARAGE = (now: admin.firestore.FieldValue) => ({
  cars: {
    car_h4ayzwf31g: {
      upgradeLevel: 0,
    },
  },
  updatedAt: now,
});

const DEFAULT_COSMETIC_SKUS: Record<
  "wheels" | "decal" | "spoiler" | "boost" | "underglow",
  string | null
> = {
  wheels: "sku_7d5rvqx6",
  decal: "sku_7ad7grzz",
  spoiler: "sku_agyhv8pk",
  boost: "sku_rwt6nbsq",
  underglow: "sku_z9tnvvdsrn",
};

const DEFAULT_COSMETIC_SKU_IDS = Object.values(DEFAULT_COSMETIC_SKUS).filter(
  (skuId): skuId is string => typeof skuId === "string" && skuId.trim().length > 0,
);

const DEFAULT_LOADOUT_COSMETICS = {
  wheelsSkuId: DEFAULT_COSMETIC_SKUS.wheels,
  decalSkuId: DEFAULT_COSMETIC_SKUS.decal,
  spoilerSkuId: DEFAULT_COSMETIC_SKUS.spoiler,
  boostSkuId: DEFAULT_COSMETIC_SKUS.boost,
  underglowSkuId: DEFAULT_COSMETIC_SKUS.underglow,
};

const DEFAULT_LOADOUT = (now: admin.firestore.FieldValue) => ({
  carId: "car_h4ayzwf31g",
  activeSpellDeck: 1,
  cosmetics: {
    ...DEFAULT_LOADOUT_COSMETICS,
  },
  updatedAt: now,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const dedupeDocumentRefs = (
  refs: Array<FirebaseFirestore.DocumentReference>,
): Array<FirebaseFirestore.DocumentReference> => {
  const map = new Map<string, FirebaseFirestore.DocumentReference>();
  refs.forEach((ref) => {
    map.set(ref.path, ref);
  });
  return Array.from(map.values());
};

async function waitForDocuments(
  refs: Array<FirebaseFirestore.DocumentReference | null | undefined>,
  attempts = 8,
  delayMs = 25,
): Promise<Set<string>> {
  const deduped = dedupeDocumentRefs(
    refs.filter((ref): ref is FirebaseFirestore.DocumentReference => Boolean(ref)),
  );
  if (deduped.length === 0) {
    return new Set();
  }
  let missing = new Set<string>();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshots = await Promise.all(
      deduped.map(async (ref) => {
        try {
          return await ref.get();
        } catch (error) {
          return null;
        }
      }),
    );
    missing = new Set<string>();
    snapshots.forEach((snap, idx) => {
      if (!snap || !snap.exists) {
        missing.add(deduped[idx].path);
      }
    });
    if (missing.size === 0) {
      return missing;
    }
    if (attempt < attempts - 1) {
      await sleep(delayMs * (attempt + 1));
    }
  }
  return missing;
}

export async function waitForUserBootstrap(uid: string): Promise<Set<string>> {
  const playerRef = db.doc(`Players/${uid}`);
  const profileRef = playerRef.collection("Profile").doc("Profile");
  const economyRef = playerRef.collection("Economy").doc("Stats");
  const spellDecksRef = playerRef.collection("SpellDecks").doc("Decks");
  const spellsRef = playerRef.collection("Spells").doc("Levels");
  const garageRef = playerRef.collection("Garage").doc("Cars");
  const loadoutRef = playerRef.collection("Loadouts").doc("Active");
  const dailyRef = playerRef.collection("Daily").doc("Status");
  const socialRef = playerRef.collection("Social").doc("Profile");
  const progressRef = playerRef.collection("Progress").doc("Initial");
  const maintenanceRef = playerRef.collection("Maintenance").doc("UnseenRewards");
  const referralsUnseenRef = playerRef.collection("Referrals").doc("UnseenRewards");

  const inventoryCtx = resolveInventoryContext(uid);
  const starterRewards = await loadStarterRewards();

  return await waitForDocuments([
    playerRef,
    profileRef,
    economyRef,
    spellDecksRef,
    spellsRef,
    garageRef,
    loadoutRef,
    dailyRef,
    socialRef,
    progressRef,
    maintenanceRef,
    inventoryCtx.summaryRef,
    db.doc(`Players/${uid}/Inventory/${starterRewards.crateSkuId}`),
    starterRewards.keySkuId
      ? db.doc(`Players/${uid}/Inventory/${starterRewards.keySkuId}`)
      : undefined,
    ...DEFAULT_COSMETIC_SKU_IDS.map((skuId) =>
      db.doc(`Players/${uid}/Inventory/${skuId}`),
    ),
  ]);
}


export async function initializeUserIfNeeded(
  uid: string,
  providers: string[] = [],
  opts?: InitializeOptions,
): Promise<void> {
  const playerRef = db.doc(`Players/${uid}`);
  const profileRef = playerRef.collection("Profile").doc("Profile");
  const economyRef = playerRef.collection("Economy").doc("Stats");
  const spellDecksRef = playerRef.collection("SpellDecks").doc("Decks");
  const spellsRef = playerRef.collection("Spells").doc("Levels");
  const garageRef = playerRef.collection("Garage").doc("Cars");
  const loadoutRef = playerRef.collection("Loadouts").doc("Active");
  const dailyRef = playerRef.collection("Daily").doc("Status");
  const socialRef = playerRef.collection("Social").doc("Profile");
  const progressRef = playerRef.collection("Progress").doc("Initial");
  const maintenanceRef = playerRef.collection("Maintenance").doc("UnseenRewards");
  const inventoryCtx = resolveInventoryContext(uid);
  const receiptId = opts?.opId ?? STARTER_INIT_RECEIPT_ID;

  try {
    const providersRef = db.doc(`AccountsProviders/${uid}`);

    const [playerSnap, accountProvidersSnap] = await Promise.all([
      playerRef.get(),
      providersRef.get(),
    ]);

    const playerData = playerSnap.exists ? (playerSnap.data() ?? {}) : null;
    const existingEmail =
      playerData && typeof playerData.email === "string" ? playerData.email : null;

    const providerSet = new Set<string>();
    const appendProviders = (values: unknown): void => {
      if (!Array.isArray(values)) {
        return;
      }
      for (const value of values) {
        if (typeof value === "string" && value.trim().length > 0) {
          providerSet.add(value.trim());
        }
      }
    };

    appendProviders(playerData?.authProviders);
    if (accountProvidersSnap.exists) {
      appendProviders((accountProvidersSnap.data() ?? {}).providers);
    }
    for (const provider of providers) {
      if (typeof provider === "string" && provider.trim().length > 0) {
        providerSet.add(provider.trim());
      }
    }

    const inferredGuest =
      opts?.isGuest ?? (!opts?.authUser && providerSet.size === 0);

    if (inferredGuest) {
      providerSet.add("anonymous");
    }

    const email = opts?.email ?? existingEmail ?? null;

    const starterRewards = await loadStarterRewards();
    const starterSpellIds = (await loadStarterSpellIds())
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0);

    let referralConfig: ReferralConfig;
    try {
      referralConfig = await getReferralConfig();
    } catch (error) {
      console.warn(
        "[initializeUserIfNeeded] ReferralConfig missing, using fallback defaults.",
        error instanceof Error ? error.message : error,
      );
      referralConfig = {
        codeLength: 6,
        alphabet: "0123456789ABCDEFGHJKMNPQRSTVWXYZ",
        maxClaimPerInvitee: 1,
        maxClaimsPerInviter: 1000,
        inviteeRewards: [
          { skuId: starterRewards.keySkuId, qty: 1 },
        ],
        inviterRewards: [],
        blockSelfReferral: true,
        blockCircularReferral: true,
      };
    }

    if (starterSpellIds.length < 5) {
      throw new Error("Starter spell catalog must provide at least 5 spells.");
    }

    const defaultSpellIds = Array.from(new Set(starterSpellIds)).slice(0, 5);
    if (defaultSpellIds.length < 5) {
      throw new Error("Starter spell catalog must provide at least 5 unique spells.");
    }

    const shouldGrantFullInventory =
      typeof email === "string" &&
      email.toLowerCase().includes(FULL_INVENTORY_EMAIL_MATCH.toLowerCase());

    const fullGrantPlan = shouldGrantFullInventory
      ? await (async () => {
        const [cosmeticSkus, crateSkus, keySkus, boosterSkus] = await Promise.all([
          listSkusByFilter({ category: "cosmetic" }),
          listSkusByFilter({ category: "crate" }),
          listSkusByFilter({ category: "key" }),
          listSkusByFilter({ category: "booster" }),
        ]);

        const toSkuIds = (values: Array<{ skuId?: string | null } | null | undefined>) =>
          Array.from(
            new Set(
              values
                .map((entry) => (entry?.skuId ?? "").trim())
                .filter((skuId): skuId is string => skuId.length > 0),
            ),
          );

        const cosmeticSkuIds = toSkuIds(cosmeticSkus);
        const crateSkuIds = toSkuIds(crateSkus);
        const keySkuIds = toSkuIds(keySkus);
        const boosterSkuIds = toSkuIds(boosterSkus);

        const skuMeta: Record<string, { stackable: boolean; type: string | null }> = {};
        const captureMeta = (
          entries: Array<{ skuId: string; stackable: boolean; type: string | null }>,
        ) => {
          entries.forEach((entry) => {
            if (!entry?.skuId) {
              return;
            }
            skuMeta[entry.skuId] = {
              stackable: entry.stackable,
              type: entry.type,
            };
          });
        };

        captureMeta([
          ...cosmeticSkus.map((sku) => ({
            skuId: sku.skuId,
            stackable: Boolean(sku.stackable),
            type: sku.type ?? sku.category ?? null,
          })),
          ...crateSkus.map((sku) => ({
            skuId: sku.skuId,
            stackable: Boolean(sku.stackable),
            type: sku.type ?? sku.category ?? null,
          })),
          ...keySkus.map((sku) => ({
            skuId: sku.skuId,
            stackable: Boolean(sku.stackable),
            type: sku.type ?? sku.category ?? null,
          })),
          ...boosterSkus.map((sku) => ({
            skuId: sku.skuId,
            stackable: Boolean(sku.stackable),
            type: sku.type ?? sku.category ?? null,
          })),
        ]);

        return {
          cosmeticSkuIds,
          crateSkuIds,
          keySkuIds,
          boosterSkuIds,
          skuMeta,
        };
      })()
      : null;

    const defaultCosmeticSkuMeta = await Promise.all(
      DEFAULT_COSMETIC_SKU_IDS.map(async (skuId) => {
        const sku = await resolveSkuOrThrow(skuId);
        const itemId =
          typeof sku.itemId === "string" && sku.itemId.trim().length > 0
            ? sku.itemId.trim()
            : null;
        if (!itemId) {
          throw new Error(`Default cosmetic SKU ${skuId} is missing itemId in catalog.`);
        }
        return { skuId, itemId };
      }),
    );
    const defaultCosmeticItemIdMap = new Map(
      defaultCosmeticSkuMeta.map(({ skuId, itemId }) => [skuId, itemId] as const),
    );

    const crateRef = playerRef.collection("Inventory").doc(starterRewards.crateSkuId);
    const keyRef = playerRef.collection("Inventory").doc(starterRewards.keySkuId);
    const receiptRef = playerRef.collection("Receipts").doc(receiptId);

    const summaryRef = inventoryCtx.summaryRef;
    const useItemIdInventory = process.env.USE_ITEMID_V2 === "true";
    const legacyItemsRef = useItemIdInventory
      ? playerRef.collection("Inventory").doc("Items")
      : null;
    const legacyConsumablesRef = useItemIdInventory
      ? playerRef.collection("Inventory").doc("Consumables")
      : null;

    await runReadThenWrite(
      db,
      async (tx) => {
        const timestamp = admin.firestore.FieldValue.serverTimestamp();
        const cosmeticInventoryRefs = DEFAULT_COSMETIC_SKU_IDS.map((skuId) =>
          playerRef.collection("Inventory").doc(skuId),
        );

        const legacyItemsDocPromise = legacyItemsRef
          ? tx.get(legacyItemsRef)
          : Promise.resolve(null);
        const legacyConsumablesDocPromise = legacyConsumablesRef
          ? tx.get(legacyConsumablesRef)
          : Promise.resolve(null);

        const baseDocs = await Promise.all([
          tx.get(playerRef),
          tx.get(profileRef),
          tx.get(economyRef),
          tx.get(spellDecksRef),
          tx.get(spellsRef),
          tx.get(garageRef),
          tx.get(loadoutRef),
          tx.get(dailyRef),
          tx.get(socialRef),
          tx.get(progressRef),
          tx.get(maintenanceRef),
          tx.get(referralsUnseenRef),
          tx.get(receiptRef),
          tx.get(crateRef),
          tx.get(keyRef),
          tx.get(summaryRef),
          legacyItemsDocPromise,
          legacyConsumablesDocPromise,
        ]);
        const [
          playerDoc,
          profileDoc,
          economyDoc,
          spellDecksDoc,
          spellsDoc,
          garageDoc,
          loadoutDoc,
          dailyDoc,
          socialDoc,
          progressDoc,
          maintenanceDoc,
          referralsUnseenDoc,
          receiptDoc,
          crateDoc,
          keyDoc,
          summaryDoc,
          legacyItemsDoc,
          legacyConsumablesDoc,
        ] = baseDocs;
        const cosmeticDocs = await Promise.all(
          cosmeticInventoryRefs.map((ref) => tx.get(ref)),
        );

        const crateState = createTxSkuDocState(
          db,
          uid,
          starterRewards.crateSkuId,
          crateDoc,
        );
        const keyState = createTxSkuDocState(
          db,
          uid,
          starterRewards.keySkuId,
          keyDoc,
        );
        const defaultCosmetics = DEFAULT_COSMETIC_SKU_IDS.map((skuId, idx) => ({
          skuId,
          snapshot: cosmeticDocs[idx],
          state: createTxSkuDocState(db, uid, skuId, cosmeticDocs[idx]),
        }));

        const skuStateById: Record<string, ReturnType<typeof createTxSkuDocState>> = {
          [starterRewards.crateSkuId]: crateState,
          [starterRewards.keySkuId]: keyState,
        };
        defaultCosmetics.forEach(({ skuId, state }) => {
          skuStateById[skuId] = state;
        });

        if (fullGrantPlan) {
          const allSkuIds = Array.from(
            new Set([
              ...fullGrantPlan.cosmeticSkuIds,
              ...fullGrantPlan.crateSkuIds,
              ...fullGrantPlan.keySkuIds,
              ...fullGrantPlan.boosterSkuIds,
            ]),
          );
          const missingSkuIds = allSkuIds.filter(
            (skuId) => !Object.prototype.hasOwnProperty.call(skuStateById, skuId),
          );
          if (missingSkuIds.length > 0) {
            const missingRefs = missingSkuIds.map((skuId) =>
              playerRef.collection("Inventory").doc(skuId),
            );
            const missingDocs = await Promise.all(
              missingRefs.map((ref) => tx.get(ref)),
            );
            missingDocs.forEach((snapshot, idx) => {
              const skuId = missingSkuIds[idx];
              skuStateById[skuId] = createTxSkuDocState(
                db,
                uid,
                skuId,
                snapshot,
              );
            });
          }
        }

        const referralPlan = await prepareReferralCodePlan({
          transaction: tx,
          uid,
          profileRef,
          profileSnap: profileDoc,
          config: referralConfig,
          timestamp,
        });

        return {
          timestamp,
          docs: {
            playerDoc,
            profileDoc,
            economyDoc,
            spellDecksDoc,
            spellsDoc,
            garageDoc,
            loadoutDoc,
            dailyDoc,
            socialDoc,
            progressDoc,
            maintenanceDoc,
            receiptDoc,
            crateDoc,
            keyDoc,
          },
          crateState,
          keyState,
          summaryState: createTxInventorySummaryState(summaryRef, summaryDoc),
          defaultCosmetics,
          fullGrant: fullGrantPlan
            ? {
              ...fullGrantPlan,
              skuStates: skuStateById,
            }
            : null,
          referralPlan,
          legacy: useItemIdInventory
            ? {
              itemsRef: legacyItemsRef,
              itemsCounts:
                (legacyItemsDoc?.exists
                  ? ((legacyItemsDoc.data() ?? {}) as { counts?: Record<string, number> })
                    .counts
                  : undefined) ?? {},
              consumablesRef:
                legacyConsumablesDoc?.exists === true ? legacyConsumablesRef : null,
              consumableCounts:
                legacyConsumablesDoc?.exists === true
                  ? ((legacyConsumablesDoc?.data() ?? {}) as {
                    counts?: Record<string, number>;
                  }).counts ?? {}
                  : {},
            }
            : null,
        };
      },
      async (tx, reads) => {
        const {
          timestamp,
          docs: {
            playerDoc,
            profileDoc,
            economyDoc,
            spellDecksDoc,
            spellsDoc,
            garageDoc,
            loadoutDoc,
            dailyDoc,
            socialDoc,
            progressDoc,
            maintenanceDoc,
            receiptDoc,
            crateDoc,
            keyDoc,
          },
          crateState,
          keyState,
          summaryState,
          defaultCosmetics,
          referralPlan,
          fullGrant,
          legacy,
        } = reads;

        // READS ABOVE, WRITES BELOW. DO NOT MOVE/ADD tx.get AFTER THIS LINE.

        const identityPayload = {
          uid,
          email,
          authProviders: Array.from(providerSet),
          isGuest: inferredGuest,
          isGameAdmin: false, // Default to non-admin
        };

        if (!playerDoc.exists) {
          tx.set(
            playerRef,
            { ...identityPayload, createdAt: timestamp, updatedAt: timestamp },
            { merge: false },
          );
        } else {
          tx.set(
            playerRef,
            { ...identityPayload, updatedAt: timestamp },
            { merge: true },
          );
        }

        tx.set(
          providersRef,
          {
            providers: Array.from(providerSet),
            updatedAt: timestamp,
          },
          { merge: true },
        );

        const displayName = inferredGuest ? "Guest" : "New Racer";

        if (!profileDoc.exists) {
          const profilePayload = DEFAULT_PROFILE(displayName, timestamp);
          profilePayload.referralCode = referralPlan.code;
          tx.set(profileRef, profilePayload, { merge: false });
        }

        if (!economyDoc.exists) {
          tx.set(economyRef, DEFAULT_ECONOMY(timestamp), { merge: false });
        }

        if (!spellDecksDoc.exists) {
          tx.set(
            spellDecksRef,
            buildDefaultSpellDecks(defaultSpellIds, timestamp),
            { merge: false },
          );
        }

        if (!spellsDoc.exists) {
          tx.set(
            spellsRef,
            buildDefaultSpells(defaultSpellIds, timestamp),
            { merge: false },
          );
        }

        if (!garageDoc.exists) {
          tx.set(garageRef, DEFAULT_GARAGE(timestamp), { merge: false });
        }

        if (!loadoutDoc.exists) {
          tx.set(loadoutRef, DEFAULT_LOADOUT(timestamp), { merge: false });
        }

        if (!dailyDoc.exists) {
          tx.set(
            dailyRef,
            { streak: 0, cooldownUntil: null, updatedAt: timestamp },
            { merge: false },
          );
        }

        if (!socialDoc.exists) {
          tx.set(
            socialRef,
            { friends: [], referralCode: null, updatedAt: timestamp },
            { merge: false },
          );
        }

        if (!progressDoc.exists) {
          tx.set(
            progressRef,
            { tutorialComplete: false, updatedAt: timestamp },
            { merge: false },
          );
        }

        if (!maintenanceDoc.exists) {
          tx.set(
            maintenanceRef,
            { unseenRewards: [], totalUnseen: 0, updatedAt: timestamp },
            { merge: false },
          );
        }

        if (!referralsUnseenDoc.exists) {
          tx.set(
            referralsUnseenRef,
            { unseenRewards: [], totalUnseen: 0, updatedAt: timestamp },
            { merge: false },
          );
        }

        tx.set(
          socialRef,
          { referralCode: referralPlan.code, updatedAt: timestamp },
          { merge: true },
        );

        const ensureMetadata = (
          ref: FirebaseFirestore.DocumentReference,
          snap: FirebaseFirestore.DocumentSnapshot,
          skuId: string,
        ) => {
          if (!snap.exists) {
            return;
          }
          const data = snap.data() ?? {};
          if (typeof data.skuId !== "string" || data.skuId !== skuId) {
            tx.set(ref, { skuId }, { merge: true });
          }
        };

        ensureMetadata(crateRef, crateDoc, starterRewards.crateSkuId);
        ensureMetadata(keyRef, keyDoc, starterRewards.keySkuId);
        defaultCosmetics.forEach(({ state, snapshot, skuId }) => {
          ensureMetadata(state.ref, snapshot, skuId);
        });

        let crateTotal = crateState.quantity;
        let keyTotal = keyState.quantity;
        const summaryChanges: Record<string, number> = {};
        const cosmeticReceiptGrants: Array<{
          skuId: string;
          itemId: string | null;
          quantity: number;
          total: number;
        }> = [];

        if (crateTotal < 1) {
          const adjustment = await txIncSkuQty(
            tx,
            db,
            uid,
            starterRewards.crateSkuId,
            1,
            { state: crateState, timestamp },
          );
          crateTotal = adjustment.next;
          summaryChanges[starterRewards.crateSkuId] =
            (summaryChanges[starterRewards.crateSkuId] ?? 0) + 1;
        }

        if (keyTotal < 1) {
          const adjustment = await txIncSkuQty(
            tx,
            db,
            uid,
            starterRewards.keySkuId,
            1,
            { state: keyState, timestamp },
          );
          keyTotal = adjustment.next;
          summaryChanges[starterRewards.keySkuId] =
            (summaryChanges[starterRewards.keySkuId] ?? 0) + 1;
        }

        for (const cosmetic of defaultCosmetics) {
          const ownedQuantity = Math.max(0, Number(cosmetic.state.quantity ?? 0));
          if (ownedQuantity < 1) {
            const adjustment = await txIncSkuQty(
              tx,
              db,
              uid,
              cosmetic.skuId,
              1,
              { state: cosmetic.state, timestamp, itemType: "cosmetic" },
            );
            summaryChanges[cosmetic.skuId] =
              (summaryChanges[cosmetic.skuId] ?? 0) + 1;
          }
          cosmeticReceiptGrants.push({
            skuId: cosmetic.skuId,
            itemId: defaultCosmeticItemIdMap.get(cosmetic.skuId) ?? null,
            quantity: 1,
            total: cosmetic.state.quantity,
          });
        }

        if (fullGrant?.skuStates && fullGrant.skuMeta) {
          const skuStates = fullGrant.skuStates;
          const skuMeta = fullGrant.skuMeta;

          const applyTargetQty = async (
            skuId: string,
            targetQty: number,
          ): Promise<void> => {
            const state = skuStates[skuId];
            if (!state) {
              return;
            }
            const currentQty = Math.max(0, Number(state.quantity ?? 0));
            const meta = skuMeta[skuId];
            const safeTarget = meta?.stackable === false ? Math.min(targetQty, 1) : targetQty;
            const delta = Math.max(0, safeTarget - currentQty);
            if (delta <= 0) {
              return;
            }
            await txIncSkuQty(tx, db, uid, skuId, delta, {
              state,
              timestamp,
              itemType: meta?.type ?? null,
            });
            summaryChanges[skuId] = (summaryChanges[skuId] ?? 0) + delta;
          };

          for (const skuId of fullGrant.cosmeticSkuIds) {
            await applyTargetQty(skuId, 1);
          }

          const bulkSkuIds = Array.from(
            new Set([
              ...fullGrant.crateSkuIds,
              ...fullGrant.keySkuIds,
              ...fullGrant.boosterSkuIds,
            ]),
          );
          for (const skuId of bulkSkuIds) {
            await applyTargetQty(skuId, 100);
          }
        }

        if (Object.keys(summaryChanges).length > 0) {
          await txUpdateInventorySummary(tx, db, uid, summaryChanges, {
            state: summaryState,
            timestamp,
          });
        }

        const cosmeticTotals = defaultCosmetics.map(({ skuId, state }) => ({
          skuId,
          quantity: Math.max(0, Number(state.quantity ?? 0)),
        }));

        if (legacy) {
          const crateTotalLegacy = crateState.quantity;
          const keyTotalLegacy = keyState?.quantity ?? 0;

          if (legacy.itemsRef) {
            const itemCounts = { ...legacy.itemsCounts };
            itemCounts[starterRewards.crateItemId] = crateTotalLegacy;
            if (starterRewards.keyItemId) {
              itemCounts[starterRewards.keyItemId] = keyTotalLegacy;
            }
            cosmeticTotals.forEach(({ skuId, quantity }) => {
              const itemId = defaultCosmeticItemIdMap.get(skuId);
              if (itemId) {
                itemCounts[itemId] = quantity;
              }
            });
            tx.set(
              legacy.itemsRef,
              {
                counts: itemCounts,
                updatedAt: timestamp,
              },
              { merge: true },
            );
          }

          if (legacy.consumablesRef) {
            const consumableCounts = { ...legacy.consumableCounts };
            consumableCounts[starterRewards.crateSkuId] = crateTotalLegacy;
            if (starterRewards.keySkuId) {
              consumableCounts[starterRewards.keySkuId] = keyTotalLegacy;
            }
            tx.set(
              legacy.consumablesRef,
              {
                counts: consumableCounts,
                updatedAt: timestamp,
              },
              { merge: true },
            );
          }
        }

        if (!receiptDoc.exists) {
          tx.set(
            receiptRef,
            {
              opId: receiptId,
              status: "completed",
              reason: STARTER_INIT_RECEIPT_ID,
              result: {
                grants: [
                  {
                    itemId: starterRewards.crateItemId,
                    skuId: starterRewards.crateSkuId,
                    quantity: 1,
                    total: crateTotal,
                  },
                  {
                    itemId: starterRewards.keyItemId,
                    skuId: starterRewards.keySkuId,
                    quantity: 1,
                    total: keyTotal,
                  },
                  ...cosmeticReceiptGrants,
                ],
              },
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            { merge: false },
          );
        }

        applyReferralCodePlan(tx, referralPlan);
      },
    );
  } catch (err) {
    console.error("initializeUserIfNeeded failed", {
      uid,
      cause: (err as Error)?.message,
    });
    throw new HttpsError(
      "internal",
      `Failed to initialize user bootstrap for uid=${uid}`,
      err as Error,
    );
  }

  try {
    await refreshPlayerLeaderboardSnapshots(uid);
  } catch (error) {
    console.warn("[initializeUserIfNeeded] failed to refresh leaderboards", {
      uid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
