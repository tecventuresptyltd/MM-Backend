import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { CrateSlotEntry, UserCrateSlotsDoc } from "../shared/typesV2.js";

const db = admin.firestore();

export const FIRST_HOUR_STARTING_GEMS = 30;
export const FIRST_HOUR_CRATE_RACE = 2;
export const FIRST_HOUR_SPELL_BONUS_RACES = 5;
export const FIRST_HOUR_SHARD_TARGET = 30;
export const FIRST_HOUR_BONUS_SPELL_ID = "spell_2382r2jk";

const DOUBLE_COIN_MODES = new Set(["ELIMINATION", "POLICE", "INFECTED"]);

export const FIRST_HOUR_STEPS = [
  "spell_deck",
  "car_upgrade",
  "crate_open",
  "customize",
  "mastery_intro",
  "spell_upgrade",
  "speed_up",
  "invite_friend",
  "clans_intro",
  "rank_rewards",
  "daily_tomorrow",
  "challenges_rewards",
] as const;

export interface FirstHourState {
  active: boolean;
  racesCompleted: number;
  starterCratePending: boolean;
  starterCrateSkuId: string | null;
  starterCrateRarity: string;
  modeFirstRaceDone: Record<string, boolean>;
}

export interface FirstHourRacePlan {
  raceNumber: number;
  fillCarXp: boolean;
  spellBonusTargetRatio: number;
  shardTarget: number;
  doubleCoins: boolean;
  suppressRandomDrop: boolean;
  grantStarterCrate: boolean;
}

export interface FirstHourRaceOutcome {
  raceNumber: number;
  carBonusXp: number;
  spellBonusXp: number;
  shardTopUp: number;
  bonusCoins: number;
  starterCrateGranted: boolean;
}

export const firstHourRef = (uid: string): FirebaseFirestore.DocumentReference =>
  db.doc(`Players/${uid}/Progress/FirstHour`);

export const readFirstHourState = (
  snap: FirebaseFirestore.DocumentSnapshot,
): FirstHourState | null => {
  if (!snap.exists) {
    return null;
  }
  const data = snap.data() ?? {};
  if (data.active !== true) {
    return null;
  }
  return {
    active: true,
    racesCompleted: Math.max(0, Math.floor(Number(data.racesCompleted ?? 0))),
    starterCratePending: data.starterCratePending === true,
    starterCrateSkuId: typeof data.starterCrateSkuId === "string" ? data.starterCrateSkuId : null,
    starterCrateRarity: typeof data.starterCrateRarity === "string" ? data.starterCrateRarity : "common",
    modeFirstRaceDone: (data.modeFirstRaceDone ?? {}) as Record<string, boolean>,
  };
};

export const planFirstHourRace = (
  state: FirstHourState | null,
  gamemode: string,
): FirstHourRacePlan | null => {
  if (!state) {
    return null;
  }
  const raceNumber = state.racesCompleted + 1;
  return {
    raceNumber,
    fillCarXp: raceNumber === 1,
    spellBonusTargetRatio:
      raceNumber <= FIRST_HOUR_SPELL_BONUS_RACES ? raceNumber / FIRST_HOUR_SPELL_BONUS_RACES : 0,
    shardTarget: raceNumber === FIRST_HOUR_SPELL_BONUS_RACES ? FIRST_HOUR_SHARD_TARGET : 0,
    doubleCoins: DOUBLE_COIN_MODES.has(gamemode) && state.modeFirstRaceDone[gamemode] !== true,
    suppressRandomDrop: raceNumber <= FIRST_HOUR_CRATE_RACE,
    grantStarterCrate:
      raceNumber === FIRST_HOUR_CRATE_RACE && state.starterCratePending && !!state.starterCrateSkuId,
  };
};

export const writeFirstHourRaceOutcome = (
  tx: FirebaseFirestore.Transaction,
  uid: string,
  gamemode: string,
  outcome: FirstHourRaceOutcome,
): void => {
  const update: Record<string, unknown> = {
    racesCompleted: outcome.raceNumber,
    [`modeFirstRaceDone.${gamemode}`]: true,
    lastRaceAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (outcome.starterCrateGranted) {
    update.starterCratePending = false;
  }
  tx.update(firstHourRef(uid), update);
};

export interface FirstHourEnrolmentInput {
  uid: string;
  firstHourSnap: FirebaseFirestore.DocumentSnapshot;
  profileSnap: FirebaseFirestore.DocumentSnapshot;
  decksSnap: FirebaseFirestore.DocumentSnapshot;
  crateSlotsSnap: FirebaseFirestore.DocumentSnapshot;
  starterCrateSkuId: string;
  starterCrateRarity: string;
}

export const isEligibleForFirstHour = (input: FirstHourEnrolmentInput): boolean => {
  if (input.firstHourSnap.exists) {
    return false;
  }
  const totalRaces = Number(input.profileSnap.data()?.totalRaces ?? 0);
  return totalRaces === 0;
};

const removeStarterCrateFromSlots = (
  tx: FirebaseFirestore.Transaction,
  input: FirstHourEnrolmentInput,
): boolean => {
  if (!input.crateSlotsSnap.exists) {
    return false;
  }
  const slotsData = input.crateSlotsSnap.data() as UserCrateSlotsDoc;
  const slots = (slotsData.slots ?? []) as (CrateSlotEntry | null)[];
  const index = slots.findIndex(
    (slot) => !!slot && slot.crateSkuId === input.starterCrateSkuId && !slot.isUnlocking,
  );
  if (index < 0) {
    return false;
  }
  const nextSlots = slots.map((slot, i) => (i === index ? null : slot));
  tx.update(input.crateSlotsSnap.ref, {
    slots: nextSlots,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return true;
};

const clearSpellDecks = (
  tx: FirebaseFirestore.Transaction,
  decksSnap: FirebaseFirestore.DocumentSnapshot,
): void => {
  if (!decksSnap.exists) {
    return;
  }
  const decks = (decksSnap.data()?.decks ?? {}) as Record<string, { spells?: string[] }>;
  const update: Record<string, unknown> = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  for (const deckKey of Object.keys(decks)) {
    update[`decks.${deckKey}.spells`] = ["", "", ""];
  }
  tx.update(decksSnap.ref, update);
};

export const enrolFirstHourInTx = (
  tx: FirebaseFirestore.Transaction,
  input: FirstHourEnrolmentInput,
  economyRef: FirebaseFirestore.DocumentReference,
): void => {
  const starterCrateRemoved = removeStarterCrateFromSlots(tx, input);
  clearSpellDecks(tx, input.decksSnap);
  tx.update(economyRef, {
    gems: admin.firestore.FieldValue.increment(FIRST_HOUR_STARTING_GEMS),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  tx.set(firstHourRef(input.uid), {
    active: true,
    version: 1,
    racesCompleted: 0,
    starterCratePending: starterCrateRemoved,
    starterCrateSkuId: input.starterCrateSkuId,
    starterCrateRarity: input.starterCrateRarity,
    modeFirstRaceDone: {},
    stepsDone: {},
    enrolledAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info("[firstHour] Enrolled player", { uid: input.uid, starterCrateRemoved });
};

export const markFirstHourStep = onCall(
  callableOptions({ minInstances: getMinInstances(false), cpu: 1, concurrency: 80 }),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "User is not authenticated.");
    }
    const step = request.data?.step;
    if (typeof step !== "string" || !(FIRST_HOUR_STEPS as readonly string[]).includes(step)) {
      throw new HttpsError("invalid-argument", "Unknown first-hour step.");
    }
    const ref = firstHourRef(uid);
    const snap = await ref.get();
    if (!snap.exists) {
      return { success: true, enrolled: false };
    }
    await ref.update({
      [`stepsDone.${step}`]: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: true, enrolled: true, step };
  },
);
