import { HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { getOffersCatalog } from "../core/config.js";
import { db } from "../shared/firestore.js";
import { ActiveOffers, Offer } from "../shared/types.js";

export interface RotationSet {
  id: string;
  offerIds: string[];
}

export interface RotationSpecial extends RotationSet {
  featuredOfferId: string;
  trigger: "purchase" | "mastery" | "win_streak" | "mythical_crate" | "weekend";
  durationMs: number;
  rank?: number;
  repeatEveryRanks?: number;
}

export interface RotationConfig {
  enabled: boolean;
  version: string;
  defaultRangeId: string;
  periodMs: number;
  selectionMode?: "manual" | "automatic";
  specialTiePeriodMs?: number;
  ranges: { id: string; label: string; sets: RotationSet[] }[];
  specialSets: RotationSpecial[];
}

export interface RotationState {
  version: string;
  rangeId: string;
  day: number;
  cursors: Record<string, number>;
  selectedSpecialSetId: string | null;
  specials: Record<string, { expiresAt: number; consumed: boolean }>;
  milestones: string[];
  milestoneRanks?: Record<string, number>;
  eventTimes: Record<string, number>;
  masteryInitialized?: boolean;
  revision: number;
  selectionMode?: "manual" | "automatic";
  automaticCursor?: number;
}

export interface RotationView {
  version: string;
  revision: number;
  rangeId: string;
  setId: string;
  selectedSpecialSetId: string | null;
  nextRotationAt: number;
  availableRanges: { id: string; label: string }[];
  availableSpecialSets: { setId: string; offerId: string; expiresAt: number }[];
  serverNow: number;
  selectionMode?: "manual" | "automatic";
}

export type CuratedOffers = ActiveOffers & { rotation: RotationView };
export type RotationEvent = { type: "mastery" | "win_streak" | "mythical_crate" | "purchase"; occurredAt: number; rank?: number; previousRank?: number };
export const rotationStateRef = (uid: string) => db.doc(`Players/${uid}/Offers/Rotation`);
let configCache: { data: RotationConfig | null; at: number } | undefined;

export const isSandboxRotationEnvironment = (): boolean => {
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || admin.app().options.projectId;
  return project === "mystic-motors-sandbox" || (project === "demo-test" && !!process.env.FIRESTORE_EMULATOR_HOST);
};

export const resetRotationConfigCache = (): void => { configCache = undefined; };

export const validateRotationConfig = (config: RotationConfig, offers: Record<string, Offer>): void => {
  if (!config.version || config.periodMs !== 86400000 || !Array.isArray(config.ranges) || !Array.isArray(config.specialSets)) {
    throw new Error("Invalid shop rotation configuration.");
  }
  if (config.selectionMode !== undefined && !["manual", "automatic"].includes(config.selectionMode)) throw new Error("Invalid shop selection mode.");
  if (config.selectionMode === "automatic" && (!Number.isSafeInteger(config.specialTiePeriodMs) || config.specialTiePeriodMs! <= 0)) throw new Error("Invalid special rotation interval.");
  const ranges = new Set(config.ranges.map(range => range.id));
  if (ranges.size !== config.ranges.length || !ranges.has(config.defaultRangeId)) throw new Error("Invalid shopping ranges.");
  const sets = [...config.ranges.flatMap(range => range.sets), ...config.specialSets];
  if (new Set(sets.map(set => set.id)).size !== sets.length || config.ranges.some(range => !range.sets.length)) throw new Error("Invalid rotation sets.");
  for (const set of sets) {
    if (set.offerIds.length !== 3 || new Set(set.offerIds).size !== 3) throw new Error(`Set ${set.id} needs three distinct offers.`);
    let lastPrice = -1;
    for (const id of set.offerIds) {
      const offer = offers[id];
      if (!offer?.productId || !offer.entitlements?.length || !Number.isFinite(offer.price) || offer.price! <= lastPrice) {
        throw new Error(`Invalid or unordered offer ${id} in ${set.id}.`);
      }
      lastPrice = offer.price!;
    }
  }
  for (const special of config.specialSets) {
    if (!special.offerIds.includes(special.featuredOfferId) || !Number.isFinite(special.durationMs) || special.durationMs <= 0) throw new Error(`Invalid special ${special.id}.`);
    if (special.repeatEveryRanks !== undefined && (special.trigger !== "mastery" || !Number.isSafeInteger(special.rank) || special.rank! <= 0 || !Number.isSafeInteger(special.repeatEveryRanks) || special.repeatEveryRanks <= 0)) throw new Error(`Invalid milestone recurrence ${special.id}.`);
  }
};

export const getRotationConfig = async (): Promise<RotationConfig | null> => {
  if (!isSandboxRotationEnvironment()) return null;
  const now = Date.now();
  if (configCache && now - configCache.at < 60000) return configCache.data;
  const snapshot = await db.doc("GameData/v1/config/ShopRotationConfig").get();
  const data = snapshot.data() as RotationConfig | undefined;
  if (!data?.enabled) {
    configCache = { data: null, at: now };
    return null;
  }
  validateRotationConfig(data, await getOffersCatalog());
  configCache = { data, at: now };
  return data;
};

export const automaticRotationSets = (config: RotationConfig): { rangeId: string; set: RotationSet }[] => {
  const result: { rangeId: string; set: RotationSet }[] = [];
  const maximum = Math.max(...config.ranges.map(range => range.sets.length));
  for (let index = 0; index < maximum; index++) {
    for (const range of config.ranges) {
      if (range.sets[index]) result.push({ rangeId: range.id, set: range.sets[index] });
    }
  }
  return result;
};

const automaticSpecialSelection = (state: RotationState, config: RotationConfig, now: number): { id: string | null; nextSwitchAt?: number } => {
  const eligible = config.specialSets.filter(set => {
    const window = state.specials[set.id];
    return window && !window.consumed && window.expiresAt > now;
  });
  if (!eligible.length) return { id: null };
  const earliest = Math.min(...eligible.map(set => state.specials[set.id].expiresAt));
  const tied = eligible.filter(set => state.specials[set.id].expiresAt === earliest);
  if (tied.length === 1) return { id: tied[0].id };
  const interval = config.specialTiePeriodMs!;
  const slice = Math.floor(now / interval);
  return { id: tied[slice % tied.length].id, nextSwitchAt: (slice + 1) * interval };
};

const reconcileAutomaticSelection = (state: RotationState, config: RotationConfig, now: number): void => {
  if (config.selectionMode !== "automatic") return;
  const ordinary = automaticRotationSets(config)[state.automaticCursor ?? 0];
  const specialId = automaticSpecialSelection(state, config, now).id;
  if (state.rangeId !== ordinary.rangeId || state.selectedSpecialSetId !== specialId) state.revision++;
  state.rangeId = ordinary.rangeId;
  state.selectedSpecialSetId = specialId;
};

export const prepareRotationState = (raw: RotationState | undefined, config: RotationConfig, now: number): RotationState => {
  const day = Math.floor(now / config.periodMs);
  const state: RotationState = raw ? JSON.parse(JSON.stringify(raw)) : {
    version: config.version, rangeId: config.defaultRangeId, day, cursors: {}, selectedSpecialSetId: null,
    specials: {}, milestones: [], eventTimes: {}, revision: 0,
  };
  state.revision ??= 0;
  if (state.version !== config.version) state.revision++;
  state.version = config.version;
  if (!config.ranges.some(range => range.id === state.rangeId)) state.rangeId = config.defaultRangeId;
  const elapsed = Math.max(0, day - state.day);
  const selectionMode = config.selectionMode ?? "manual";
  if (selectionMode === "automatic") {
    const sequence = automaticRotationSets(config);
    if (state.selectionMode !== "automatic" || !Number.isSafeInteger(state.automaticCursor) || state.automaticCursor! < 0) {
      const currentSet = config.ranges.find(range => range.id === state.rangeId)?.sets[state.cursors[state.rangeId] ?? 0];
      state.automaticCursor = Math.max(0, sequence.findIndex(entry => entry.set.id === currentSet?.id));
    }
    state.automaticCursor = (state.automaticCursor! + elapsed) % sequence.length;
  }
  if ((state.selectionMode ?? "manual") !== selectionMode) state.revision++;
  state.selectionMode = selectionMode;
  state.revision += elapsed;
  for (const range of config.ranges) state.cursors[range.id] = ((state.cursors[range.id] ?? 0) + elapsed) % range.sets.length;
  state.day = Math.max(state.day, day);
  const dayStart = day * config.periodMs;
  if (new Date(now).getUTCDay() === 6) {
    for (const special of config.specialSets.filter(entry => entry.trigger === "weekend")) {
      if ((state.specials[special.id]?.expiresAt ?? 0) <= dayStart) {
        state.specials[special.id] = { expiresAt: dayStart + special.durationMs, consumed: false };
      }
    }
  }
  const selected = state.selectedSpecialSetId && state.specials[state.selectedSpecialSetId];
  if (!selected || selected.consumed || selected.expiresAt <= now || !config.specialSets.some(set => set.id === state.selectedSpecialSetId)) {
    if (state.selectedSpecialSetId) state.revision++;
    state.selectedSpecialSetId = null;
  }
  reconcileAutomaticSelection(state, config, now);
  return state;
};

export const applyRotationEvent = (state: RotationState, config: RotationConfig, event: RotationEvent, now: number): void => {
  const recurringMastery = event.type === "mastery" && config.specialSets.some(set => set.trigger === "mastery" && set.repeatEveryRanks !== undefined);
  if (!Number.isFinite(event.occurredAt) || event.occurredAt <= 0 || event.occurredAt > now || (!recurringMastery && event.occurredAt <= (state.eventTimes[event.type] ?? 0))) return;
  if (event.type === "mastery" && (!Number.isSafeInteger(event.rank) || event.rank! < 0 || (event.previousRank !== undefined && (!Number.isSafeInteger(event.previousRank) || event.previousRank < 0)))) return;
  state.eventTimes[event.type] = Math.max(state.eventTimes[event.type] ?? 0, event.occurredAt);
  for (const special of config.specialSets) {
    if (special.trigger !== event.type) continue;
    if (special.trigger === "mastery") {
      if (!special.rank || (event.rank ?? 0) < special.rank) continue;
      if (special.repeatEveryRanks !== undefined) {
        const milestoneRank = special.rank + Math.floor((event.rank! - special.rank) / special.repeatEveryRanks) * special.repeatEveryRanks;
        const processedRank = state.milestoneRanks?.[special.id] ?? (state.milestones.includes(special.id) ? special.rank : 0);
        if (milestoneRank <= processedRank || (event.previousRank !== undefined && milestoneRank <= event.previousRank)) continue;
        state.milestoneRanks ??= {};
        state.milestoneRanks[special.id] = milestoneRank;
        if (!state.milestones.includes(special.id)) state.milestones.push(special.id);
        const expiresAt = event.occurredAt + special.durationMs;
        if (expiresAt > now) {
          state.specials[special.id] = { expiresAt, consumed: false };
          state.revision++;
        }
        continue;
      }
      if (state.milestones.includes(special.id)) continue;
      state.milestones.push(special.id);
    }
    const expiresAt = event.occurredAt + special.durationMs;
    if (expiresAt <= now || (state.specials[special.id]?.expiresAt ?? 0) > event.occurredAt) continue;
    state.specials[special.id] = { expiresAt, consumed: false };
  }
};

export const renderRotation = (state: RotationState, config: RotationConfig, now: number): CuratedOffers => {
  const range = config.ranges.find(entry => entry.id === state.rangeId)!;
  const selected = config.specialSets.find(entry => entry.id === state.selectedSpecialSetId);
  const set = selected ?? (config.selectionMode === "automatic" ? automaticRotationSets(config)[state.automaticCursor ?? 0].set : range.sets[state.cursors[range.id] ?? 0]);
  const dailyRotationAt = (Math.floor(now / config.periodMs) + 1) * config.periodMs;
  const tieSwitchAt = config.selectionMode === "automatic" ? automaticSpecialSelection(state, config, now).nextSwitchAt : undefined;
  const nextRotationAt = config.selectionMode === "automatic"
    ? Math.min(dailyRotationAt, tieSwitchAt ?? Infinity, selected ? state.specials[selected.id].expiresAt : Infinity)
    : dailyRotationAt;
  const expiresAt = selected ? state.specials[selected.id].expiresAt : dailyRotationAt;
  return {
    rotating: set.offerIds.map((offerId, index) => ({ offerId, category: `curated_${index}`, expiresAt, state: "active" as const, tier: 0, isStarter: false })),
    special: [], updatedAt: now,
    rotation: {
      version: config.version, revision: state.revision, rangeId: range.id, setId: set.id, selectedSpecialSetId: selected?.id ?? null,
      nextRotationAt, serverNow: now,
      selectionMode: config.selectionMode ?? "manual",
      availableRanges: config.ranges.map(entry => ({ id: entry.id, label: entry.label })),
      availableSpecialSets: config.specialSets.filter(entry => {
        const window = state.specials[entry.id];
        return window && !window.consumed && window.expiresAt > now;
      }).map(entry => ({ setId: entry.id, offerId: entry.featuredOfferId, expiresAt: state.specials[entry.id].expiresAt })),
    },
  };
};

export const writeRotation = (transaction: FirebaseFirestore.Transaction, uid: string, state: RotationState, config: RotationConfig, now: number): CuratedOffers => {
  reconcileAutomaticSelection(state, config, now);
  const result = renderRotation(state, config, now);
  transaction.set(rotationStateRef(uid), state);
  transaction.set(db.doc(`Players/${uid}/Offers/Active`), result);
  return result;
};

export const getCuratedOffers = async (uid: string, config: RotationConfig, selection: unknown = {}): Promise<CuratedOffers> => {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new HttpsError("invalid-argument", "Invalid shop selection.");
  const { rangeId, specialSetId } = selection as { rangeId?: unknown; specialSetId?: unknown };
  if (rangeId !== undefined && !config.ranges.some(range => range.id === rangeId)) throw new HttpsError("invalid-argument", "Unknown shopping range.");
  if (specialSetId !== undefined && specialSetId !== null && typeof specialSetId !== "string") throw new HttpsError("invalid-argument", "Invalid special selection.");
  return db.runTransaction(async transaction => {
    const [snapshot, profile] = await transaction.getAll(rotationStateRef(uid), db.doc(`Players/${uid}/Profile/Profile`));
    const now = Date.now();
    const state = prepareRotationState(snapshot.data() as RotationState | undefined, config, now);
    if (!state.masteryInitialized) {
      applyRotationEvent(state, config, { type: "mastery", rank: Number(profile.get("masteryRank") ?? 0), occurredAt: now }, now);
      state.masteryInitialized = true;
    }
    if (config.selectionMode !== "automatic" && rangeId !== undefined) {
      if (state.rangeId !== rangeId || state.selectedSpecialSetId) state.revision++;
      state.rangeId = rangeId as string;
      state.selectedSpecialSetId = null;
    }
    if (config.selectionMode !== "automatic" && specialSetId !== undefined) {
      const window = typeof specialSetId === "string" ? state.specials[specialSetId] : undefined;
      if (specialSetId !== null && (!config.specialSets.some(set => set.id === specialSetId) || !window || window.consumed || window.expiresAt <= now)) {
        throw new HttpsError("failed-precondition", "This special offer is not available.");
      }
      if (state.selectedSpecialSetId !== specialSetId) state.revision++;
      state.selectedSpecialSetId = specialSetId as string | null;
    }
    return writeRotation(transaction, uid, state, config, now);
  });
};

export const recordRotationEvent = async (uid: string, event: RotationEvent): Promise<void> => {
  const config = await getRotationConfig();
  if (!config) return;
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(rotationStateRef(uid));
    const now = Date.now();
    const state = prepareRotationState(snapshot.data() as RotationState | undefined, config, now);
    applyRotationEvent(state, config, event, now);
    if (snapshot.exists && JSON.stringify(snapshot.data()) === JSON.stringify(state)) return;
    writeRotation(transaction, uid, state, config, now);
  });
};

export const applyRotationPurchase = (state: RotationState, config: RotationConfig, offerId: string, active: CuratedOffers | undefined, now: number, presentation?: unknown): void => {
  if (!presentation || typeof presentation !== "object") return;
  const shown = presentation as Record<string, unknown>;
  const currentView = renderRotation(state, config, now);
  const currentOffer = currentView.rotating!.find(entry => entry.offerId === offerId);
  if (!currentOffer || shown.version !== config.version || shown.setId !== currentView.rotation.setId ||
      shown.rangeId !== state.rangeId || shown.revision !== state.revision || shown.expiresAt !== currentOffer.expiresAt || currentOffer.expiresAt <= now) return;
  const selected = config.specialSets.find(set => set.id === state.selectedSpecialSetId);
  if (selected) {
    if (selected.featuredOfferId === offerId) {
      state.specials[selected.id].consumed = true;
      state.selectedSpecialSetId = null;
      state.revision++;
    }
  } else {
    const current = renderRotation(state, config, now);
    if (active?.rotation?.setId === current.rotation.setId && active.rotation.rangeId === state.rangeId &&
        active.rotating?.some(offer => offer.offerId === offerId && offer.expiresAt > now)) {
      const range = config.ranges.find(entry => entry.id === state.rangeId)!;
      if (config.selectionMode === "automatic") state.automaticCursor = ((state.automaticCursor ?? 0) + 1) % automaticRotationSets(config).length;
      else state.cursors[range.id] = (state.cursors[range.id] + 1) % range.sets.length;
      state.revision++;
    }
  }
};
