import fetch from "node-fetch";
import { verifyReceipt, ReceiptRejected } from "../src/shop/receiptVerification";

jest.mock("node-fetch", () => ({ __esModule: true, default: jest.fn() }));
const oldSecret = process.env.APPLE_SHARED_SECRET;
beforeAll(() => { process.env.APPLE_SHARED_SECRET = "test-secret"; });
afterAll(() => { if (oldSecret === undefined) delete process.env.APPLE_SHARED_SECRET; else process.env.APPLE_SHARED_SECRET = oldSecret; });
const receipt = (transactionId: string, store = "AppleAppStore") => JSON.stringify({ Store: store, TransactionID: transactionId, Payload: "test-app-receipt" });
const apple = (entries: Record<string, unknown>[]) => {
  jest.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ status: 0, receipt: { in_app: entries } }) } as any);
};

test("Apple retries select the exact transaction rather than the newest purchase of the SKU", async () => {
  apple([
    { product_id: "test.gems", transaction_id: "original", purchase_date_ms: "1" },
    { product_id: "test.gems", transaction_id: "newer", purchase_date_ms: "2" },
  ]);
  expect(await verifyReceipt("ios", receipt("original"), "test.gems", "original")).toEqual({ transactionId: "original", productId: "test.gems" });
});

test("Apple canceled transactions cannot grant currency", async () => {
  apple([{ product_id: "test.gems", transaction_id: "canceled", cancellation_date_ms: "3" }]);
  await expect(verifyReceipt("ios", receipt("canceled"), "test.gems", "canceled")).rejects.toBeInstanceOf(ReceiptRejected);
});

test("receipt envelope must match the requested platform", async () => {
  await expect(verifyReceipt("ios", receipt("id", "GooglePlay"), "test.gems", "id")).rejects.toThrow("store does not match");
});

test("consumables without a shared secret still require Apple's exact verified transaction", async () => {
  delete process.env.APPLE_SHARED_SECRET;
  jest.mocked(fetch).mockClear();
  try {
    apple([{ product_id: "test.gems", transaction_id: "consumable" }]);
    expect(await verifyReceipt("ios", receipt("consumable"), "test.gems", "consumable"))
      .toEqual({ transactionId: "consumable", productId: "test.gems" });
    const body = JSON.parse(String(jest.mocked(fetch).mock.calls[0][1]?.body));
    expect(body).toEqual({ "receipt-data": "test-app-receipt" });
    await expect(verifyReceipt("ios", receipt("different"), "test.gems", "different"))
      .rejects.toBeInstanceOf(ReceiptRejected);
    jest.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ status: 21004 }) } as any);
    await expect(verifyReceipt("ios", receipt("consumable"), "test.gems", "consumable"))
      .rejects.toBeInstanceOf(ReceiptRejected);
  } finally {
    process.env.APPLE_SHARED_SECRET = "test-secret";
  }
});
