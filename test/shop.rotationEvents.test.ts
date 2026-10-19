import { admin } from "./setup";
import { getSkuRecord } from "../src/core/catalog";
import { getRotationConfig, recordRotationEvent } from "../src/shop/curatedRotation";
import { crateSlotRotationEvents, inventoryRotationEvents, profileRotationEvents, purchaseRotationEvents } from "../src/shop/rotationEvents";

jest.mock("../src/shop/curatedRotation", () => ({ getRotationConfig: jest.fn(), recordRotationEvent: jest.fn() }));
jest.mock("../src/core/catalog", () => ({ getSkuRecord: jest.fn() }));

const configuration = getRotationConfig as jest.Mock;
const record = recordRotationEvent as jest.Mock;
const skuRecord = getSkuRecord as jest.Mock;
const occurredAt = Date.parse("2026-10-19T10:00:00Z");
const uid = "shop-rotation-events";
const crate = (seconds: number) => ({ crateSkuId: "sku_mythical", rarity: "mythical", receivedAt: new admin.firestore.Timestamp(seconds, 12), isUnlocking: false });

describe("shop rotation authoritative event adapters", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configuration.mockResolvedValue({ enabled: true });
    record.mockResolvedValue(undefined);
    skuRecord.mockResolvedValue({ type: "crate", rarity: "mythical" });
  });

  test("disabled configuration prevents every adapter from publishing or resolving catalog data", async () => {
    configuration.mockResolvedValue(null);
    await profileRotationEvents(uid, { masteryRank: 4 }, { masteryRank: 5, shopWinStreak: 3 }, occurredAt);
    await crateSlotRotationEvents(uid, {}, { slots: [crate(100)] }, occurredAt);
    await inventoryRotationEvents(uid, "sku_mythical", {}, { quantity: 1 }, occurredAt);
    await purchaseRotationEvents(undefined, { uid, verified: true, grantApplied: true }, occurredAt);
    expect(record).not.toHaveBeenCalled();
    expect(skuRecord).not.toHaveBeenCalled();
  });

  test("rank jumps and the third settled win preserve the original event time", async () => {
    await profileRotationEvents(uid, { masteryRank: 4, shopWinStreak: 2 }, { masteryRank: 10, shopWinStreak: 3 }, occurredAt);
    expect(record.mock.calls).toEqual([
      [uid, { type: "mastery", rank: 10, previousRank: 4, occurredAt }],
      [uid, { type: "win_streak", occurredAt }],
    ]);
    record.mockClear();
    await profileRotationEvents(uid, { masteryRank: 10, shopWinStreak: 3 }, { masteryRank: 10, shopWinStreak: 4 }, occurredAt);
    await profileRotationEvents(uid, { masteryRank: 10, shopWinStreak: 4 }, { masteryRank: 9, shopWinStreak: 0 }, occurredAt);
    expect(record).not.toHaveBeenCalled();
  });

  test("crate unlock, slot reorder, and crate opening do not create acquisition events", async () => {
    const original = crate(100);
    await crateSlotRotationEvents(uid, { slots: [original, null] }, { slots: [null, { ...original, isUnlocking: true }] }, occurredAt);
    await crateSlotRotationEvents(uid, { slots: [original] }, { slots: [null] }, occurredAt);
    expect(record).not.toHaveBeenCalled();
    await crateSlotRotationEvents(uid, { slots: [original] }, { slots: [original, crate(200)] }, occurredAt);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(uid, { type: "mythical_crate", occurredAt });
  });

  test("slot labels cannot turn an ordinary catalog crate into a Mythical crate", async () => {
    skuRecord.mockResolvedValue({ type: "crate", rarity: "rare" });
    await crateSlotRotationEvents(uid, {}, { slots: [crate(100)] }, occurredAt);
    expect(record).not.toHaveBeenCalled();
  });

  test("only positive Mythical crate inventory grants publish events", async () => {
    await inventoryRotationEvents(uid, "_summary", {}, { quantity: 1 }, occurredAt);
    await inventoryRotationEvents(uid, "sku_mythical", { quantity: 2 }, { quantity: 1 }, occurredAt);
    await inventoryRotationEvents(uid, "sku_mythical", { quantity: 1 }, { quantity: 1 }, occurredAt);
    expect(record).not.toHaveBeenCalled();
    await inventoryRotationEvents(uid, "sku_mythical", { qty: 1 }, { qty: 2 }, occurredAt);
    expect(record).toHaveBeenCalledWith(uid, { type: "mythical_crate", occurredAt });
  });

  test("only a newly created verified applied purchase produces an upsell event", async () => {
    const purchase = { uid, verified: true, grantApplied: true };
    await purchaseRotationEvents({}, purchase, occurredAt);
    await purchaseRotationEvents(undefined, { ...purchase, verified: false }, occurredAt);
    await purchaseRotationEvents(undefined, { ...purchase, grantApplied: false }, occurredAt);
    await purchaseRotationEvents(undefined, { ...purchase, uid: "" }, occurredAt);
    expect(record).not.toHaveBeenCalled();
    await purchaseRotationEvents(undefined, purchase, occurredAt);
    expect(record).toHaveBeenCalledWith(uid, { type: "purchase", occurredAt });
  });

  test("malformed time cannot become a fresh offer window", async () => {
    await profileRotationEvents(uid, {}, { masteryRank: 10, shopWinStreak: 3 }, NaN);
    await crateSlotRotationEvents(uid, {}, { slots: [crate(100)] }, NaN);
    await inventoryRotationEvents(uid, "sku_mythical", {}, { quantity: 1 }, NaN);
    await purchaseRotationEvents(undefined, { uid, verified: true, grantApplied: true }, NaN);
    expect(record).not.toHaveBeenCalled();
  });
});
