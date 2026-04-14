import { readFileSync, writeFileSync } from 'fs';

const path = 'src/shop/purchaseOffer.ts';
let content = readFileSync(path, 'utf-8');

// 1. Types update
content = content.replace(
`type ActiveOfferSlot =
  | { kind: "main" }
  | { kind: "daily" }
  | { kind: "starter" }
  | { kind: "special"; index: number };`,
`type ActiveOfferSlot =
  | { kind: "rotating"; index: number }
  | { kind: "special"; index: number };`
);

content = content.replace(
`interface MainOfferUpdate {
  newTier: number;
  nextOfferAt: number;
  isStarter: boolean;
}`,
`interface RotatingOfferUpdate {
  index: number;
  slotId: string;
  nextOfferAt: number;
}`
);

content = content.replace(
`interface ActiveOfferUpdate {
  slot: ActiveOfferSlot["kind"];
  special?: ActiveSpecialOffer[];
  /** New main offer update for IAP purchases */
  mainUpdate?: MainOfferUpdate;
}`,
`interface ActiveOfferUpdate {
  slot: ActiveOfferSlot["kind"];
  special?: ActiveSpecialOffer[];
  rotating?: MainOffer[];
  rotatingUpdate?: RotatingOfferUpdate;
}`
);

content = content.replace(
`  /** New tier after this purchase (if ladder progression occurred) */
  newTier?: number;
  /** When next offer will be available (if in purchase_delay) */
  nextOfferAt?: number;
}`,
`  /** When next offer will be available (if in purchase_delay) */
  nextOfferAt?: number;
  slotId?: string;
}`
);

writeFileSync(path, content);
console.log("Patched 1");
