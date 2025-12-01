export interface GemPack {
  iapId: string;
  displayName: string;
  gemAmount: number;
  priceUsd: number;
  bonusLabel?: string | null;
  productId: string;
  sortOrder: number;
}

type GemPackMap = Record<string, GemPack>;

const GEM_PACKS: GemPackMap = {
  iap_h72k9z3m: {
    iapId: "iap_h72k9z3m",
    displayName: "Sack of Gems",
    gemAmount: 100,
    priceUsd: 0.99,
    bonusLabel: null,
    productId: "com.mysticmotors.gems.100",
    sortOrder: 1,
  },
  iap_q4n5w8v2: {
    iapId: "iap_q4n5w8v2",
    displayName: "Bag of Gems",
    gemAmount: 550,
    priceUsd: 4.99,
    bonusLabel: "+10%",
    productId: "com.mysticmotors.gems.550",
    sortOrder: 2,
  },
  iap_b6v1x9c3: {
    iapId: "iap_b6v1x9c3",
    displayName: "Box of Gems",
    gemAmount: 1200,
    priceUsd: 9.99,
    bonusLabel: "+20%",
    productId: "com.mysticmotors.gems.1200",
    sortOrder: 3,
  },
  iap_m2k8j4d5: {
    iapId: "iap_m2k8j4d5",
    displayName: "Chest of Gems",
    gemAmount: 2600,
    priceUsd: 19.99,
    bonusLabel: "+30%",
    productId: "com.mysticmotors.gems.2600",
    sortOrder: 4,
  },
  iap_z9c3v5b7: {
    iapId: "iap_z9c3v5b7",
    displayName: "Crate of Gems",
    gemAmount: 7000,
    priceUsd: 49.99,
    bonusLabel: "+40%",
    productId: "com.mysticmotors.gems.7000",
    sortOrder: 5,
  },
  iap_w4x6n8m2: {
    iapId: "iap_w4x6n8m2",
    displayName: "Vault of Gems",
    gemAmount: 15000,
    priceUsd: 99.99,
    bonusLabel: "+50%",
    productId: "com.mysticmotors.gems.15000",
    sortOrder: 6,
  },
  iap_r1t3y5u7: {
    iapId: "iap_r1t3y5u7",
    displayName: "Treasury of Gems",
    gemAmount: 32000,
    priceUsd: 199.99,
    bonusLabel: "+60%",
    productId: "com.mysticmotors.gems.32000",
    sortOrder: 7,
  },
};

const gemPackByProductId = new Map<string, GemPack>();
Object.values(GEM_PACKS).forEach((pack) => {
  gemPackByProductId.set(pack.productId, pack);
});

export const getGemPacksCatalog = (): GemPack[] => Object.values(GEM_PACKS);

export const findGemPackByProductId = (productId: string): GemPack | null => {
  const key = typeof productId === "string" ? productId.trim() : "";
  if (!key) {
    return null;
  }
  return gemPackByProductId.get(key) ?? null;
};
