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
  const normalizeDeckKey = (value: unknown): string | null => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return String(Math.floor(value));
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const trimmed = value.trim();
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) && parsed > 0 ? String(Math.floor(parsed)) : trimmed;
    }
    return null;
  };

  const buildDeckMap = (raw: unknown): Map<string, unknown> | null => {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const map = new Map<string, unknown>();
    if (Array.isArray(raw)) {
      raw.forEach((entry, idx) => {
        map.set(String(idx + 1), entry);
      });
    } else {
      Object.entries(raw as Record<string, unknown>).forEach(([key, value]) => {
        map.set(String(key), value);
      });
    }
    return map.size > 0 ? map : null;
  };

  const decksMap = buildDeckMap(spellDecks?.decks ?? null);
  if (!decksMap) {
    return null;
  }

  const preferredKey = normalizeDeckKey(loadout?.activeSpellDeck);
  const fallbackKey = normalizeDeckKey(spellDecks?.active);

  const hasDeck = (key: string | null) => (key ? decksMap.has(key) : false);

  let deckKey: string | null = null;
  if (hasDeck(preferredKey)) {
    deckKey = preferredKey;
  } else if (hasDeck(fallbackKey)) {
    deckKey = fallbackKey;
  } else {
    const firstNonEmpty = Array.from(decksMap.entries()).find(
      ([, value]) => Array.isArray((value as any)?.spells) && (value as any).spells.some((id: unknown) => typeof id === "string" && id.length > 0),
    );
    deckKey = firstNonEmpty?.[0] ?? decksMap.keys().next().value ?? null;
  }

  if (!deckKey) {
    return null;
  }

  const deck = decksMap.get(deckKey);
  if (!deck || typeof deck !== "object") {
    return null;
  }

  const spells = Array.isArray((deck as any).spells)
    ? (deck as any).spells.map((spell: unknown) => (typeof spell === "string" ? spell : ""))
    : [];

  return { deckId: deckKey, deck: { ...(deck as Record<string, unknown>), spells } };
};

export const viewPlayerProfile = onCall(
  callableOptions({ cpu: 1, concurrency: 80 }, true),
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
