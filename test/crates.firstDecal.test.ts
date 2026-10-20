process.env.FUNCTIONS_EMULATOR = "true";
import { admin } from "./setup";
import { wipeFirestore, ensureCatalogsSeeded } from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { __resetV2ConfigCacheForTests } from "../src/core/configV2";
import { listSkusByFilter, __resetCatalogCacheForTests } from "../src/core/config";
import { claimCrateRewardV2 } from "../src/cratesV2/slotsV2";

jest.setTimeout(120_000);

const db = admin.firestore();
const uid = "first-crate-decal-player";
const claim = wrapCallable(claimCrateRewardV2);
const slotsRef = db.doc(`Players/${uid}/Crates/Slots`);
const onboardingRef = db.doc(`Players/${uid}/Progress/FirstHour`);
const request = (opId: string) => ({ data: { slotIndex: 0, opId }, auth: { uid, token: {} } });

async function readyCrate(rarity = "common"): Promise<void> {
    await slotsRef.set({
        slots: [{ crateSkuId: "sku_zz3twgp0wx", rarity, isUnlocking: true,
            completesAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000) }, null, null, null],
        maxSlots: 4,
        firstCrateHandled: true,
    });
}

beforeEach(async () => {
    await wipeFirestore();
    __resetV2ConfigCacheForTests();
    await ensureCatalogsSeeded();
    await db.doc(`Players/${uid}/Profile/Profile`).set({ trophies: 0 });
    await db.doc(`Players/${uid}/Economy/Stats`).set({ coins: 0, gems: 0, spellShards: 0 });
    await onboardingRef.set({ active: true, racesCompleted: 2, stepsDone: {} });
    await readyCrate();
});

afterEach(() => jest.restoreAllMocks());

it.each([2, 30])("grants an Enamel common decal even when first opened after %i races", async (racesCompleted) => {
    await onboardingRef.update({ racesCompleted, "stepsDone.crate_open": true });
    const result = await claim(request(`first-${racesCompleted}`));
    const cosmetic = result.awarded.find((item: any) => item.type === "cosmetic");
    const decals = await listSkusByFilter({ category: "cosmetic", subType: "decal", rarity: "common" });
    expect(decals.some((sku) => sku.skuId === cosmetic.skuId && sku.itemDisplayName === "Enamel")).toBe(true);
    expect((await db.doc(`Players/${uid}/Inventory/${cosmetic.skuId}`).get()).data()?.quantity).toBe(1);
    expect((await onboardingRef.get()).data()?.firstCrateDecalGranted).toBe(true);
    const replay = await claim(request(`first-${racesCompleted}`));
    expect(replay).toEqual(result);
    expect((await db.doc(`Players/${uid}/Inventory/${cosmetic.skuId}`).get()).data()?.quantity).toBe(1);
});

it("keeps the common decal guarantee when a rarer crate is opened first, then returns to normal rarity", async () => {
    await readyCrate("rare");
    const first = await claim(request("first-rare"));
    expect(first.awarded.find((item: any) => item.type === "cosmetic").rarity).toBe("common");
    await readyCrate("rare");
    const second = await claim(request("second-rare"));
    expect(second.awarded.filter((item: any) => item.type === "cosmetic").every((item: any) => item.rarity === "rare")).toBe(true);
});

it("does not apply the first-hour guarantee to unenrolled players", async () => {
    await onboardingRef.delete();
    await readyCrate("rare");
    const result = await claim(request("unenrolled"));
    expect(result.awarded.filter((item: any) => item.type === "cosmetic").every((item: any) => item.rarity === "rare")).toBe(true);
    expect((await onboardingRef.get()).exists).toBe(false);
});

it("does not consume the crate or guarantee when there is no eligible decal", async () => {
    const ref = db.doc("GameData/v1/catalogs/ItemsCatalog");
    const catalog = (await ref.get()).data()!;
    for (const item of Object.values(catalog.items) as any[]) {
        if (item.subType === "decal") item.subType = "wheel";
    }
    await ref.set(catalog);
    __resetCatalogCacheForTests();
    await expect(claim(request("missing-decal"))).rejects.toThrow("No unowned common decal");
    expect((await slotsRef.get()).data()?.slots[0]).not.toBeNull();
    expect((await onboardingRef.get()).data()?.firstCrateDecalGranted).toBeUndefined();
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()?.coins).toBe(0);
});
