const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SUFFIX_SOURCE = `[0-9A-HJ-NP-TV-Z]{6,10}`;
const SKU_PATTERN = new RegExp(`^sku_(crt|key|bst|csm)_(${SUFFIX_SOURCE})$`);
const ITEM_PATTERN = new RegExp(`^(crt|key|bst|itm)_(${SUFFIX_SOURCE})$`);

export type SkuKind = "crt" | "key" | "bst" | "csm";
export type ItemKind = "crt" | "key" | "bst" | "itm";

export interface ParsedSkuId {
  kind: SkuKind;
  suffix: string;
}

export interface ParsedItemId {
  kind: ItemKind;
  suffix: string;
}

export const isValidSuffix = (suffix: string): boolean =>
  /^[0-9A-HJ-NP-TV-Z]{6,10}$/.test(suffix);

export const toSuffix = (value: string): string =>
  value.replace(/[^0-9A-Z]/g, "").toUpperCase();

export const parseSkuId = (skuId: string): ParsedSkuId | null => {
  const match = SKU_PATTERN.exec(skuId);
  if (!match) {
    return null;
  }
  const [, kind, suffix] = match;
  return { kind: kind as SkuKind, suffix };
};

export const parseItemId = (itemId: string): ParsedItemId | null => {
  const match = ITEM_PATTERN.exec(itemId);
  if (!match) {
    return null;
  }
  const [, kind, suffix] = match;
  return { kind: kind as ItemKind, suffix };
};

export const isSkuId = (value: string, kinds?: SkuKind[]): boolean => {
  const parsed = parseSkuId(value);
  if (!parsed) {
    return false;
  }
  if (kinds && !kinds.includes(parsed.kind)) {
    return false;
  }
  return true;
};

export const isItemId = (value: string, kinds?: ItemKind[]): boolean => {
  const parsed = parseItemId(value);
  if (!parsed) {
    return false;
  }
  if (kinds && !kinds.includes(parsed.kind)) {
    return false;
  }
  return true;
};

export const kindFromSkuId = (skuId: string): SkuKind | null => {
  const parsed = parseSkuId(skuId);
  return parsed?.kind ?? null;
};

export const suffixFromSkuId = (skuId: string): string | null => {
  const parsed = parseSkuId(skuId);
  return parsed?.suffix ?? null;
};

export const toItemId = (skuId: string): string => {
  const parsed = parseSkuId(skuId);
  if (!parsed) {
    throw new Error(`Invalid SKU ID "${skuId}"`);
  }
  const itemKind: ItemKind =
    parsed.kind === "csm" ? "itm" : (parsed.kind as ItemKind);
  return `${itemKind}_${parsed.suffix}`;
};

export const suffixFromItemId = (itemId: string): string | null => {
  const parsed = parseItemId(itemId);
  return parsed?.suffix ?? null;
};

export const ensureItemMatchesSku = (itemId: string, skuId: string): boolean => {
  const item = parseItemId(itemId);
  const sku = parseSkuId(skuId);
  if (!item || !sku) {
    return false;
  }
  if (sku.kind === "csm") {
    return item.kind === "itm" && item.suffix === sku.suffix;
  }
  return item.kind === sku.kind && item.suffix === sku.suffix;
};

export const randomSuffix = (length = 8): string => {
  if (length < 6 || length > 10) {
    throw new Error("Suffix length must be between 6 and 10 characters.");
  }
  let suffix = "";
  const alphabetLength = CROCKFORD_ALPHABET.length;
  for (let i = 0; i < length; i += 1) {
    const rand = Math.floor(Math.random() * alphabetLength);
    suffix += CROCKFORD_ALPHABET[rand];
  }
  return suffix;
};

export const formatSkuId = (
  kind: SkuKind,
  suffix: string,
): string => {
  const normalizedSuffix = toSuffix(suffix);
  if (!isValidSuffix(normalizedSuffix)) {
    throw new Error(`Invalid suffix "${suffix}" for SKU ${kind}`);
  }
  return `sku_${kind}_${normalizedSuffix}`;
};

export const formatItemId = (
  kind: ItemKind,
  suffix: string,
): string => {
  const normalizedSuffix = toSuffix(suffix);
  if (!isValidSuffix(normalizedSuffix)) {
    throw new Error(`Invalid suffix "${suffix}" for item ${kind}`);
  }
  return `${kind}_${normalizedSuffix}`;
};

export const generateSkuId = (kind: SkuKind, length = 8): string =>
  formatSkuId(kind, randomSuffix(length));

export const generateItemId = (kind: ItemKind, length = 8): string =>
  formatItemId(kind, randomSuffix(length));
