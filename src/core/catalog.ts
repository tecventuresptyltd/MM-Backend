import * as admin from "firebase-admin";
import {
  CrateDefinition,
  CratesCatalogDoc,
  Item,
  ItemSku,
  ItemSkusCatalogDoc,
  ItemVariant,
  ItemsCatalogDoc,
  ItemsIndexDoc,
  Spell,
} from "../shared/types.js";
type CatalogDocId = "ItemsCatalog" | "ItemsIndex" | "CratesCatalog" | "SpellsCatalog";

const TTL_MS = 60 * 1000;

interface CacheEntry<T> {
  expiresAt: number;
  data: T;
}

const cache = new Map<string, CacheEntry<unknown>>();

const firestore = admin.firestore();
const catalogsRoot = firestore.collection("GameData").doc("v1").collection("catalogs");
const docRefs: Record<CatalogDocId, FirebaseFirestore.DocumentReference> = {
  ItemsCatalog: catalogsRoot.doc("ItemsCatalog"),
  ItemsIndex: catalogsRoot.doc("ItemsIndex"),
  CratesCatalog: catalogsRoot.doc("CratesCatalog"),
  SpellsCatalog: catalogsRoot.doc("SpellsCatalog"),
};
const now = () => Date.now();
const makeCacheKey = (docId: string): string => docId;

const clone = <T>(value: T): T =>
  value ? (JSON.parse(JSON.stringify(value)) as T) : value;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normaliseString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normaliseBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const normaliseNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
};

const normaliseStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return undefined;
  }
  return Array.from(new Set(entries));
};

const cloneIfDefined = <T>(
  value: T | null | undefined,
): T | null | undefined =>
  value === null || value === undefined ? value : clone(value);

function normaliseItemVariants(item: Item): ItemVariant[] {
  const rawVariants = Array.isArray(item.variants) ? item.variants : [];
  const seen = new Set<string>();
  const variants: ItemVariant[] = [];

  const baseDisplayName = normaliseString(item.displayName) ?? item.itemId;
  const baseRarity = normaliseString(item.rarity) ?? item.rarity;
  const baseStackable = Boolean(item.stackable);
  const basePurchasable = normaliseBoolean(item.purchasable);
  const baseGemPrice = normaliseNumber(item.gemPrice);
  const baseSubType = normaliseString(
    (item as Partial<Item> & { subType?: string }).subType,
  );
  const baseVariant = isPlainObject(
    (item as Partial<Item> & { variant?: unknown }).variant,
  )
    ? ((item as Partial<Item> & { variant?: Record<string, unknown> }).variant ??
        null)
    : null;
  const baseMetadata = isPlainObject(item.metadata)
    ? (item.metadata as Record<string, unknown>)
    : null;
  const baseTags = normaliseStringArray(item.tags);
  const baseAssetRef = item.assetRef ? clone(item.assetRef) : undefined;

  for (const entry of rawVariants) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const skuId = normaliseString((entry as { skuId?: unknown }).skuId);
    if (!skuId) {
      continue;
    }
    if (seen.has(skuId)) {
      continue;
    }
    seen.add(skuId);

    const variantDisplayName =
      normaliseString((entry as { displayName?: unknown }).displayName) ??
      baseDisplayName;
    const variantRarity =
      normaliseString((entry as { rarity?: unknown }).rarity) ??
      baseRarity ??
      item.rarity;
    const variantStackable =
      normaliseBoolean((entry as { stackable?: unknown }).stackable) ??
      baseStackable;
    const variantPurchasable =
      normaliseBoolean((entry as { purchasable?: unknown }).purchasable) ??
      basePurchasable;
    const variantGemPrice =
      normaliseNumber((entry as { gemPrice?: unknown }).gemPrice) ??
      baseGemPrice;
    const variantSubType =
      normaliseString((entry as { subType?: unknown }).subType) ?? baseSubType;
    const variantAssetRef = isPlainObject(
      (entry as { assetRef?: unknown }).assetRef,
    )
      ? (clone(
          (entry as { assetRef?: Record<string, unknown> }).assetRef,
        ) as ItemVariant["assetRef"])
      : baseAssetRef
      ? clone(baseAssetRef)
      : undefined;
    const variantVariant = isPlainObject(
      (entry as { variant?: unknown }).variant,
    )
      ? (clone(
          (entry as { variant?: Record<string, unknown> | null }).variant ??
            null,
        ) as Record<string, unknown> | null)
      : cloneIfDefined(baseVariant) ?? null;
    const variantMetadata = isPlainObject(
      (entry as { metadata?: unknown }).metadata,
    )
      ? (clone(
          (entry as { metadata?: Record<string, unknown> | null }).metadata ??
            null,
        ) as Record<string, unknown> | null)
      : cloneIfDefined(baseMetadata) ?? null;
    const variantTags =
      normaliseStringArray((entry as { tags?: unknown }).tags) ??
      (baseTags ? [...baseTags] : undefined);

    variants.push({
      skuId,
      displayName: variantDisplayName ?? undefined,
      rarity: (variantRarity ?? undefined) as ItemVariant["rarity"],
      stackable: variantStackable,
      purchasable: variantPurchasable,
      gemPrice: variantGemPrice,
      subType: variantSubType,
      assetRef: variantAssetRef,
      variant: variantVariant,
      metadata: variantMetadata,
      tags: variantTags,
    });
  }

  if (variants.length === 0) {
    variants.push({
      skuId: item.itemId,
      displayName: baseDisplayName ?? undefined,
      rarity: (baseRarity ?? item.rarity) as ItemVariant["rarity"],
      stackable: baseStackable,
      purchasable: basePurchasable,
      gemPrice: baseGemPrice,
      subType: baseSubType,
      assetRef: cloneIfDefined(baseAssetRef) ?? undefined,
      variant: cloneIfDefined(baseVariant) ?? null,
      metadata: cloneIfDefined(baseMetadata) ?? null,
      tags: baseTags ? [...baseTags] : undefined,
    });
  }

  return variants;
}

function normaliseItemsCatalogDoc(doc: ItemsCatalogDoc): ItemsCatalogDoc {
  const items: Record<string, Item> = {};
  for (const [itemId, rawItem] of Object.entries(doc.items ?? {})) {
    if (typeof itemId !== "string" || itemId.length === 0) {
      continue;
    }
    const normalisedItem: Item = {
      ...rawItem,
      itemId,
    };
    const normalisedVariants = normaliseItemVariants(
      normalisedItem,
    ) as ItemVariant[];
    (normalisedItem as Item & { variants: ItemVariant[] }).variants =
      normalisedVariants;
    items[itemId] = normalisedItem;
  }

  const index: Record<string, string[]> = {};
  for (const [familyKey, members] of Object.entries(doc.index ?? {})) {
    if (!Array.isArray(members)) {
      continue;
    }
    const uniqueMembers = Array.from(
      new Set(
        members.filter(
          (member): member is string =>
            typeof member === "string" && member.length > 0 && !!items[member],
        ),
      ),
    );
    if (uniqueMembers.length > 0) {
      index[familyKey] = uniqueMembers;
    }
  }

  return {
    ...doc,
    updatedAt: doc.updatedAt ?? now(),
    items,
    index,
  };
}

interface ItemSkuContextMapping {
  item: Item;
  variant: ItemVariant;
}

interface DuplicateSkuInfo {
  owners: Set<string>;
  hits: number;
}

interface ItemSkuContext {
  doc: ItemsCatalogDoc;
  items: Record<string, Item>;
  skus: Record<string, ItemSku>;
  variantsByItem: Record<string, ItemVariant[]>;
  skuToItemVariant: Record<string, ItemSkuContextMapping>;
  familyLookup: Map<string, string[]>;
  duplicateSkuInfo: Record<string, DuplicateSkuInfo>;
}

const buildFamilyLookup = (
  index: Record<string, string[]>,
): Map<string, string[]> => {
  const lookup = new Map<string, string[]>();
  for (const [familyKey, members] of Object.entries(index ?? {})) {
    if (!Array.isArray(members)) {
      continue;
    }
    for (const member of members) {
      if (!lookup.has(member)) {
        lookup.set(member, []);
      }
      const list = lookup.get(member)!;
      if (!list.includes(familyKey)) {
        list.push(familyKey);
      }
    }
  }
  return lookup;
};

function buildSkuContext(doc: ItemsCatalogDoc): ItemSkuContext {
  const skus: Record<string, ItemSku> = {};
  const variantsByItem: Record<string, ItemVariant[]> = {};
  const skuToItemVariant: Record<string, ItemSkuContextMapping> = {};
  const duplicateSkuInfo: Record<string, DuplicateSkuInfo> = {};
  const familyLookup = buildFamilyLookup(doc.index ?? {});

  for (const [itemId, item] of Object.entries(doc.items ?? {})) {
    const variants = normaliseItemVariants(item);
    (item as Item & { variants: ItemVariant[] }).variants = variants;
    variantsByItem[itemId] = variants;

    const itemDisplayName =
      normaliseString(item.displayName) ?? item.displayName ?? itemId;
    const baseCategory = item.category ?? item.type;
    const itemSubType =
      normaliseString((item as Partial<Item> & { subType?: string }).subType) ??
      undefined;

    for (const variant of variants) {
      const skuId = variant.skuId;
      if (!skuId) {
        continue;
      }

      if (skus[skuId]) {
        const info =
          duplicateSkuInfo[skuId] ??
          {
            owners: new Set<string>([skus[skuId].itemId]),
            hits: 0,
          };
        info.hits += 1;
        info.owners.add(itemId);
        duplicateSkuInfo[skuId] = info;
        continue;
      }

      const rarity =
        (variant.rarity ?? item.rarity) as ItemSku["rarity"];
      const stackable =
        typeof variant.stackable === "boolean"
          ? variant.stackable
          : Boolean(item.stackable);
      const subType =
        variant.subType ??
        itemSubType ??
        undefined;
      const resolvedGemPrice =
        typeof variant.gemPrice === "number"
          ? variant.gemPrice
          : typeof item.gemPrice === "number"
          ? item.gemPrice
          : undefined;
      const purchasableFlag =
        typeof variant.purchasable === "boolean"
          ? variant.purchasable
          : typeof item.purchasable === "boolean"
          ? item.purchasable
          : false;
      const purchasable =
        purchasableFlag && typeof resolvedGemPrice === "number" && resolvedGemPrice > 0
          ? { currency: "gems" as const, amount: resolvedGemPrice }
          : null;

      const displayName =
        normaliseString(variant.displayName) ?? itemDisplayName ?? skuId;
      const assetRefSource =
        variant.assetRef ?? item.assetRef ?? undefined;
      const metadataSource =
        (variant.metadata ?? item.metadata ?? null) ?? null;
      const tagsSource = variant.tags ?? item.tags ?? undefined;

      skus[skuId] = {
        skuId,
        itemId,
        type: item.type,
        displayName,
        itemDisplayName,
        category: baseCategory,
        subType,
        rarity,
        stackable,
        assetRef: cloneIfDefined(assetRefSource ?? undefined) ?? undefined,
        variant: cloneIfDefined(variant.variant ?? null) ?? null,
        metadata: cloneIfDefined(metadataSource ?? null) ?? null,
        tags: tagsSource ? [...tagsSource] : undefined,
        purchasable,
        gemPrice: resolvedGemPrice ?? null,
      };

      skuToItemVariant[skuId] = {
        item,
        variant,
      };
    }
  }

  return {
    doc,
    items: doc.items ?? {},
    skus,
    variantsByItem,
    skuToItemVariant,
    familyLookup,
    duplicateSkuInfo,
  };
}

async function getItemSkuContext(
  options?: { bustCache?: boolean },
): Promise<ItemSkuContext> {
  const cacheKey = makeCacheKey("SkuContext");
  if (!options?.bustCache) {
    const cached = getFromCache<ItemSkuContext>(cacheKey);
    if (cached) {
      return cached;
    }
  }
  const doc = await getItemsCatalogDoc(options);
  const context = buildSkuContext(doc);
  return setCache(cacheKey, context);
}

function normaliseCratesCatalogDoc(doc: CratesCatalogDoc): CratesCatalogDoc {
  const crates: Record<string, CrateDefinition> = {};
  for (const [crateId, crate] of Object.entries(doc.crates ?? {})) {
    if (typeof crateId !== "string" || crateId.length === 0) {
      continue;
    }
    const dropTable = Array.isArray(crate.dropTable)
      ? crate.dropTable
          .map((entry) => ({
            itemId: entry?.itemId ?? "",
            weight: Number(entry?.weight ?? 0),
          }))
          .filter(
            (entry) => entry.itemId.length > 0 && Number.isFinite(entry.weight),
          )
      : [];

    crates[crateId] = {
      ...crate,
      crateId,
      dropTable,
      keyItemId: crate.keyItemId ?? null,
    };
  }

  return {
    ...doc,
    defaults: doc.defaults ? { ...doc.defaults } : undefined,
    crates,
  };
}

function normaliseSpellsCatalog(
  spells: Record<string, Spell> | undefined,
): Record<string, Spell> {
  const normalised: Record<string, Spell> = {};
  for (const [spellId, spell] of Object.entries(spells ?? {})) {
    const requiredLevelRaw =
      typeof spell.requiredLevel === "number" || typeof spell.requiredLevel === "string"
        ? Number(spell.requiredLevel)
        : Number.NaN;
    let requiredLevel = 0;
    if (Number.isFinite(requiredLevelRaw)) {
      if (requiredLevelRaw < 0) {
        requiredLevel = 100;
      } else {
        requiredLevel = Math.floor(requiredLevelRaw);
      }
    }
    const displayOrderRaw =
      typeof spell.displayOrder === "number" || typeof spell.displayOrder === "string"
        ? Number(spell.displayOrder)
        : Number.MAX_SAFE_INTEGER;
    const displayOrder =
      Number.isFinite(displayOrderRaw) && displayOrderRaw > 0
        ? Math.floor(displayOrderRaw)
        : Number.MAX_SAFE_INTEGER;

    normalised[spellId] = {
      ...spell,
      spellId,
      displayName: spell.displayName ?? spellId,
      requiredLevel,
      displayOrder,
      isUnlocked: spell.isUnlocked ?? false,
      unlocked: spell.unlocked ?? false,
    };
  }

  return normalised;
}

function getFromCache<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= now()) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache<T>(key: string, data: T): T {
  cache.set(key, { data, expiresAt: now() + TTL_MS });
  return data;
}

async function readCatalogDoc<T>(
  docId: CatalogDocId,
): Promise<T> {
  const ref = docRefs[docId];
  if (!ref) {
    throw new Error(`Catalog reference not configured for ${docId}`);
  }
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw new Error(`Catalog document missing for ${docId}`);
  }
  return snapshot.data() as T;
}

export async function getItemsCatalogDoc(
  options?: { bustCache?: boolean },
): Promise<ItemsCatalogDoc> {
  const cacheKey = makeCacheKey("ItemsCatalog");
  if (!options?.bustCache) {
    const cached = getFromCache<ItemsCatalogDoc>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const [rawDoc, indexDoc] = await Promise.all([
    readCatalogDoc<ItemsCatalogDoc>("ItemsCatalog"),
    readCatalogDoc<ItemsIndexDoc>("ItemsIndex"),
  ]);

  const docWithIndex: ItemsCatalogDoc = {
    ...rawDoc,
    index: indexDoc.index ?? {},
  };

  const normalised = normaliseItemsCatalogDoc(docWithIndex);
  return setCache(cacheKey, normalised);
}

export async function getItemsCatalog(
  options?: { bustCache?: boolean },
): Promise<{ items: Record<string, Item>; index: Record<string, string[]> }> {
  const doc = await getItemsCatalogDoc(options);
  return {
    items: clone(doc.items),
    index: clone(doc.index),
  };
}

export async function getItemSkusCatalogDoc(
  options?: { bustCache?: boolean },
): Promise<ItemSkusCatalogDoc> {
  const context = await getItemSkuContext(options);
  return {
    version: context.doc.version,
    updatedAt: context.doc.updatedAt,
    skus: clone(context.skus),
  };
}

export async function getItemSkusCatalog(
  options?: { bustCache?: boolean },
): Promise<Record<string, ItemSku>> {
  const context = await getItemSkuContext(options);
  return clone(context.skus);
}

export async function getSkuRecord(skuId: string): Promise<ItemSku | null> {
  const trimmed = typeof skuId === "string" ? skuId.trim() : "";
  if (!trimmed) {
    return null;
  }
  const context = await getItemSkuContext();
  const sku = context.skus[trimmed];
  return sku ? clone(sku) : null;
}

export async function resolveSkuOrThrow(skuId: string): Promise<ItemSku> {
  const sku = await getSkuRecord(skuId);
  if (!sku) {
    throw new Error(`Unknown skuId "${skuId}".`);
  }
  return sku;
}

export async function findVariantBySku(
  skuId: string,
): Promise<{
  skuId: string;
  sku?: ItemSku;
  item?: Item;
  variant?: ItemVariant;
}> {
  const trimmed = typeof skuId === "string" ? skuId.trim() : "";
  if (!trimmed) {
    throw new Error("skuId must be a non-empty string.");
  }

  const skuRecord = await getSkuRecord(trimmed);
  const { items } = await getItemsCatalog();

  let item: Item | undefined;
  let variant: ItemVariant | undefined;

  if (skuRecord) {
    item = items[skuRecord.itemId];
    if (item && Array.isArray(item.variants)) {
      variant = item.variants.find(
        (entry) => typeof entry?.skuId === "string" && entry.skuId.trim() === trimmed,
      );
    }
  }

  if (!variant) {
    for (const candidate of Object.values(items)) {
      if (!candidate || !Array.isArray(candidate.variants)) {
        continue;
      }
      const match = candidate.variants.find(
        (entry) => typeof entry?.skuId === "string" && entry.skuId.trim() === trimmed,
      );
      if (match) {
        item = candidate;
        variant = match;
        break;
      }
    }
  }

  return {
    skuId: trimmed,
    sku: skuRecord ?? undefined,
    item,
    variant,
  };
}

export async function getItemBySkuId(
  skuId: string,
): Promise<{ item: Item; variant: ItemVariant } | null> {
  const trimmed = typeof skuId === "string" ? skuId.trim() : "";
  if (!trimmed) {
    return null;
  }
  const context = await getItemSkuContext();
  const mapping = context.skuToItemVariant[trimmed];
  if (!mapping) {
    return null;
  }
  return {
    item: clone(mapping.item),
    variant: clone(mapping.variant),
  };
}

export async function listSkusForItem(itemId: string): Promise<ItemSku[]> {
  if (typeof itemId !== "string" || !itemId.trim()) {
    return [];
  }
  const context = await getItemSkuContext();
  const variants = context.variantsByItem[itemId.trim()] ?? [];
  const result: ItemSku[] = [];
  for (const variant of variants) {
    const sku = context.skus[variant.skuId];
    if (sku) {
      result.push(clone(sku));
    }
  }
  return result;
}

export async function listSkusByFilter(params: {
  category?: string;
  subType?: string;
  rarity?: string;
}): Promise<ItemSku[]> {
  const category = normaliseString(params.category);
  const subType = normaliseString(params.subType);
  const rarity = normaliseString(params.rarity);
  const context = await getItemSkuContext();

  const results: ItemSku[] = [];
  for (const sku of Object.values(context.skus)) {
    if (category && sku.category !== category && sku.type !== category) {
      continue;
    }
    if (subType) {
      const skuSubType =
        typeof sku.subType === "string" && sku.subType.length > 0
          ? sku.subType
          : null;
      if (skuSubType !== subType) {
        continue;
      }
    }
    if (rarity && sku.rarity !== rarity) {
      continue;
    }
    results.push(clone(sku));
  }
  return results;
}

export async function getFamilyForSku(
  skuId: string,
): Promise<{ itemId: string; familyKey: string | null; subType: string | null; rarity: string } | null> {
  const trimmed = typeof skuId === "string" ? skuId.trim() : "";
  if (!trimmed) {
    return null;
  }
  const context = await getItemSkuContext();
  const sku = context.skus[trimmed];
  if (!sku) {
    return null;
  }
  const familyKeys = context.familyLookup.get(sku.itemId) ?? [];
  return {
    itemId: sku.itemId,
    familyKey: familyKeys.length > 0 ? familyKeys[0] : null,
    subType:
      typeof sku.subType === "string" && sku.subType.length > 0
        ? sku.subType
        : null,
    rarity: sku.rarity,
  };
}

export async function getPriceForSku(
  skuId: string,
): Promise<{ currency: string; amount: number } | null> {
  const sku = await getSkuRecord(skuId);
  if (!sku) {
    return null;
  }
  if (sku.purchasable) {
    return { ...sku.purchasable };
  }
  if (typeof sku.gemPrice === "number" && sku.gemPrice > 0) {
    return { currency: "gems", amount: sku.gemPrice };
  }
  return null;
}

export async function isPurchasableSku(skuId: string): Promise<boolean> {
  const price = await getPriceForSku(skuId);
  return Boolean(price);
}

export async function assertAllVariantSkuIdsUnique(): Promise<void> {
  const context = await getItemSkuContext({ bustCache: true });
  const duplicates = Object.entries(context.duplicateSkuInfo);
  if (duplicates.length === 0) {
    return;
  }
  const details = duplicates
    .map(([skuId, info]) => {
      const owners = Array.from(info.owners).join(", ");
      return `${skuId} (owners: ${owners}, collisions: ${info.hits})`;
    })
    .join("; ");
  throw new Error(`Duplicate skuIds detected: ${details}`);
}

export async function getItemById(
  itemId: string,
  options?: { bustCache?: boolean },
): Promise<Item | undefined> {
  const doc = await getItemsCatalogDoc(options);
  return doc.items[itemId];
}

export async function getFamilyMembers(
  familyKey: string,
  options?: { bustCache?: boolean },
): Promise<string[]> {
  const doc = await getItemsCatalogDoc(options);
  return clone(doc.index[familyKey] ?? []);
}

export async function getCratesCatalogDoc(
  options?: { bustCache?: boolean },
): Promise<CratesCatalogDoc> {
  const cacheKey = makeCacheKey("CratesCatalog");
  if (!options?.bustCache) {
    const cached = getFromCache<CratesCatalogDoc>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const raw = await readCatalogDoc<CratesCatalogDoc>("CratesCatalog");
  const normalised = normaliseCratesCatalogDoc(raw);
  return setCache(cacheKey, normalised);
}

export async function getCratesCatalog(
  options?: { bustCache?: boolean },
): Promise<Record<string, CrateDefinition>> {
  return (await getCratesCatalogDoc(options)).crates;
}

export async function getSpellsCatalog(
  options?: { bustCache?: boolean },
): Promise<Record<string, Spell>> {
  const cacheKey = makeCacheKey("SpellsCatalog");
  if (!options?.bustCache) {
    const cached = getFromCache<Record<string, Spell>>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const rawDoc = await readCatalogDoc<{ spells: Record<string, Spell> }>(
    "SpellsCatalog",
  );
  const normalised = {
    ...rawDoc,
    spells: normaliseSpellsCatalog(rawDoc.spells ?? {}),
  };
  setCache(cacheKey, normalised.spells);
  return normalised.spells;
}

export function invalidateCatalogCache(docId?: CatalogDocId) {
  if (docId) {
    cache.delete(makeCacheKey(docId));
    if (docId === "ItemsCatalog") {
      cache.delete(makeCacheKey("ItemsIndex"));
      cache.delete(makeCacheKey("SkuContext"));
    }
    if (docId === "ItemsIndex") {
      cache.delete(makeCacheKey("ItemsCatalog"));
      cache.delete(makeCacheKey("SkuContext"));
    }
    return;
  }
  cache.clear();
}
