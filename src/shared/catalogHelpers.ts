import { getOffersCatalog, getItemsCatalog, getSpellsCatalog } from "../core/config.js";
import { Item, Offer, OfferEntitlement, Spell } from "./types.js";

const resolveV2StarterSpellIds = (catalog: Record<string, Spell>): string[] => {
  const starters = Object.values(catalog)
    .map((spell) => {
      const spellId =
        typeof spell.spellId === "string" ? spell.spellId.trim() : "";
      const displayOrder =
        typeof spell.displayOrder === "number" ? spell.displayOrder : Infinity;
      const requiredLevel =
        typeof spell.requiredLevel === "number" ? spell.requiredLevel : 0;
      const isUnlocked = spell.isUnlocked === true;
      return {
        spellId,
        displayOrder,
        requiredLevel,
        isUnlocked,
      };
    })
    .filter((entry) => entry.spellId.length > 0)
    .filter((entry) => {
      if (entry.requiredLevel > 0) {
        return false;
      }
      if (entry.isUnlocked) {
        return true;
      }
      return entry.requiredLevel <= 0;
    })
    .sort((a, b) => {
      if (a.displayOrder !== b.displayOrder) {
        return a.displayOrder - b.displayOrder;
      }
      return a.spellId.localeCompare(b.spellId);
    });

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const entry of starters) {
    if (seen.has(entry.spellId)) {
      continue;
    }
    seen.add(entry.spellId);
    selected.push(entry.spellId);
    if (selected.length === 5) {
      break;
    }
  }

  if (selected.length !== 5) {
    throw new Error(
      `Expected at least 5 starter spells in catalog, found ${selected.length}.`,
    );
  }

  return selected;
};

export const loadStarterSpellIds = async (
  catalog?: Record<string, Spell>,
): Promise<string[]> => {
  const resolvedCatalog = catalog ?? (await getSpellsCatalog());
  return resolveV2StarterSpellIds(resolvedCatalog);
};

export const loadNonStarterSpells = async (): Promise<Spell[]> => {
  const catalog = await getSpellsCatalog();
  const starterSet = new Set(await loadStarterSpellIds(catalog));
  return Object.values(catalog)
    .filter((spell) => {
      const spellId =
        typeof spell.spellId === "string" ? spell.spellId.trim() : "";
      if (!spellId || starterSet.has(spellId)) {
        return false;
      }
      const requiredLevel =
        typeof spell.requiredLevel === "number" ? spell.requiredLevel : 0;
      return requiredLevel > 0;
    })
    .sort((a, b) => {
      const levelA =
        typeof a.requiredLevel === "number" ? a.requiredLevel : Infinity;
      const levelB =
        typeof b.requiredLevel === "number" ? b.requiredLevel : Infinity;
      if (levelA !== levelB) {
        return levelA - levelB;
      }
      const orderA =
        typeof a.displayOrder === "number" ? a.displayOrder : Infinity;
      const orderB =
        typeof b.displayOrder === "number" ? b.displayOrder : Infinity;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      const idA =
        typeof a.spellId === "string" ? a.spellId.toLowerCase() : "";
      const idB =
        typeof b.spellId === "string" ? b.spellId.toLowerCase() : "";
      return idA.localeCompare(idB);
    });
};

export const loadNonStarterSpellIds = async (): Promise<string[]> =>
  (await loadNonStarterSpells()).map((spell) => spell.spellId);

export interface ResolvedOfferEntitlement {
  entitlement: OfferEntitlement;
  item: Item | null;
}

export interface OfferBundle {
  offer: Offer;
  items: Record<string, Item>;
  entitlements: ResolvedOfferEntitlement[];
}

export const loadOfferBundle = async (offerId: string): Promise<OfferBundle> => {
  const [offersCatalog, { items }] = await Promise.all([
    getOffersCatalog(),
    getItemsCatalog(),
  ]);

  const offer = offersCatalog[offerId];
  if (!offer) {
    throw new Error(`Offer ${offerId} not found in catalog.`);
  }

  const entitlements: ResolvedOfferEntitlement[] = (offer.entitlements ?? []).map(
    (entitlement) => {
      if (entitlement.type === "gems") {
        return { entitlement, item: null };
      }
      const targetId = entitlement.id ?? "";
      const item = items[targetId] ?? null;
      return { entitlement, item };
    },
  );

  return {
    offer,
    items,
    entitlements,
  };
};
