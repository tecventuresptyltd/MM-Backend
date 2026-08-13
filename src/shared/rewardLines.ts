/**
 * Reward line types and validation.
 *
 * Deliberately free of any Firestore import so config parsers, seed validators
 * and tools can use it without initialising firebase-admin. The granting side
 * lives in rewardBundle.ts.
 */

/**
 * `coins` / `gems` are currency and land on /Players/{uid}/Economy/Stats.
 * `item` / `crate` are inventory SKUs and land on /Players/{uid}/Inventory/{skuId}.
 * Currencies never carry a skuId; inventory rewards always do.
 */
export type RewardKind = "coins" | "gems" | "item" | "crate";

export interface RewardLine {
  kind: RewardKind;
  quantity: number;
  skuId?: string;
  displayName?: string;
}

export interface GrantedReward {
  kind: RewardKind;
  quantity: number;
  skuId: string | null;
  displayName: string | null;
}

const INVENTORY_KINDS: ReadonlySet<RewardKind> = new Set<RewardKind>(["item", "crate"]);

/**
 * Validates and normalises catalog-authored reward lines. Throws on malformed
 * config rather than silently dropping rewards, so a bad seed fails loudly
 * instead of quietly paying out nothing.
 */
export const normaliseRewardLines = (raw: unknown, context: string): RewardLine[] => {
  if (!Array.isArray(raw)) {
    throw new Error(`${context}: rewards must be an array.`);
  }

  return raw.map((entry, idx) => {
    const where = `${context}.rewards[${idx}]`;
    if (!entry || typeof entry !== "object") {
      throw new Error(`${where}: must be an object.`);
    }
    const line = entry as Record<string, unknown>;
    const kind = line.kind;
    if (kind !== "coins" && kind !== "gems" && kind !== "item" && kind !== "crate") {
      throw new Error(`${where}: unknown reward kind "${String(kind)}".`);
    }

    const quantity = Math.floor(Number(line.quantity ?? 0));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`${where}: quantity must be a positive number.`);
    }

    const skuId = typeof line.skuId === "string" ? line.skuId.trim() : "";
    if (INVENTORY_KINDS.has(kind) && !skuId) {
      throw new Error(`${where}: kind "${kind}" requires a skuId.`);
    }

    const displayName =
      typeof line.displayName === "string" && line.displayName.trim()
        ? line.displayName.trim()
        : undefined;

    return {
      kind,
      quantity,
      ...(skuId ? { skuId } : {}),
      ...(displayName ? { displayName } : {}),
    };
  });
};

/**
 * Presentation-only view of a reward bundle. Safe to return from read-only
 * callables so the client can render a ladder/preview without a grant.
 */
export const describeRewardLines = (lines: RewardLine[]): GrantedReward[] =>
  lines.map((line) => ({
    kind: line.kind,
    quantity: line.quantity,
    skuId: line.skuId ?? null,
    displayName: line.displayName ?? null,
  }));
