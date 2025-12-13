import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import {
  playerProfileRef,
  playerLoadoutRef,
  playerSpellDecksRef,
} from "./refs.js";
import { fetchClanSummary } from "./summary.js";

const sanitizeUid = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError("invalid-argument", "uid must be provided.");
  }
  return value.trim();
};

const resolveActiveDeck = (
  loadout: Record<string, unknown> | null,
  spellDecks: Record<string, unknown> | null,
) => {
  const decksMap =
    spellDecks && typeof spellDecks.decks === "object"
      ? (spellDecks.decks as Record<string, unknown>)
      : null;
  if (!decksMap) {
    return null;
  }
  const loadoutDeck = loadout?.activeSpellDeck;
  const deckKeyRaw =
    typeof loadoutDeck === "number" || typeof loadoutDeck === "string"
      ? loadoutDeck
      : spellDecks?.active;
  const deckKey =
    typeof deckKeyRaw === "number"
      ? String(deckKeyRaw)
      : typeof deckKeyRaw === "string"
      ? deckKeyRaw
      : null;
  if (!deckKey || !(deckKey in decksMap)) {
    return null;
  }
  const deck = decksMap[deckKey];
  if (!deck || typeof deck !== "object") {
    return null;
  }
  return { deckId: deckKey, deck };
};

export const viewPlayerProfile = onCall(
  callableOptions(),
  async (request) => {
    const callerUid = request.auth?.uid;
    if (!callerUid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const targetUid = sanitizeUid(request.data?.uid ?? request.data?.targetUid ?? callerUid);
    const [profileSnap, loadoutSnap, spellDecksSnap] = await Promise.all([
      playerProfileRef(targetUid).get(),
      playerLoadoutRef(targetUid).get(),
      playerSpellDecksRef(targetUid).get(),
    ]);

    if (!profileSnap.exists) {
      throw new HttpsError("not-found", "Player profile not found.");
    }

    const profileData = profileSnap.data() ?? {};
    const loadoutData = loadoutSnap.exists ? loadoutSnap.data() ?? {} : null;
    const spellDecksData = spellDecksSnap.exists ? spellDecksSnap.data() ?? {} : null;
    const activeSpellDeck = resolveActiveDeck(loadoutData, spellDecksData);

    const rawClanId = typeof profileData.clanId === "string" ? profileData.clanId.trim() : "";
    const rawClanName =
      typeof profileData.clanName === "string" ? profileData.clanName.trim() : "";
    const rawClanBadge =
      typeof profileData.clanBadge === "string" ? profileData.clanBadge.trim() : "";

    let clanName: string | null = rawClanName || null;
    let clanBadge: string | null = rawClanBadge || null;
    let clan:
      | {
          clanId: string;
          name: string | null;
          badge: string | null;
        }
      | null = null;

    if (rawClanId) {
      if (!clanName || !clanBadge) {
        const clanSummary = await fetchClanSummary(rawClanId);
        if (clanSummary) {
          clanName = clanName || clanSummary.name || null;
          clanBadge = clanBadge || clanSummary.badge || null;
        }
      }
      clan = {
        clanId: rawClanId,
        name: clanName ?? null,
        badge: clanBadge ?? null,
      };
    }

    const profileWithClan = {
      ...profileData,
      clanId: clan?.clanId ?? null,
      clanName: clan?.name ?? clanName ?? null,
      clanBadge: clan?.badge ?? clanBadge ?? null,
    };

    return {
      ok: true,
      success: true,
      data: {
        profile: profileWithClan,
        clan,
        loadout: loadoutData,
        activeSpellDeck,
      },
    };
  },
);
