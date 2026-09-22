import { GoogleAuth } from "google-auth-library";
import fetch from "node-fetch";

export type IapPlatform = "ios" | "android";

export interface VerifiedPurchase {
  transactionId: string;
  productId: string;
}

export class ReceiptRejected extends Error {}
export class VerifierNotConfigured extends Error {}

const ANDROID_PACKAGE_NAME =
  process.env.MM_ANDROID_PACKAGE_NAME || "com.tecventures.mysticmotors";
const APPLE_PRODUCTION_URL = "https://buy.itunes.apple.com/verifyReceipt";
const APPLE_SANDBOX_URL = "https://sandbox.itunes.apple.com/verifyReceipt";
const APPLE_SANDBOX_STATUS = 21007;
const APPLE_PRODUCTION_STATUS = 21008;
const PURCHASE_STATE_PURCHASED = 0;

let androidAuth: GoogleAuth | null = null;

const getAndroidAuth = (): GoogleAuth => {
  if (!androidAuth) {
    androidAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
  }
  return androidAuth;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const parseJson = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "string") {
    return asRecord(value);
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
};

interface UnityReceipt {
  store: string;
  transactionId: string;
  payload: string;
}

export const parseUnityReceipt = (receipt: unknown): UnityReceipt => {
  const parsed = parseJson(receipt);
  if (!parsed) {
    throw new ReceiptRejected(
      "receipt must be the full store receipt, not a transaction id.",
    );
  }

  const store = typeof parsed.Store === "string" ? parsed.Store : "";
  const transactionId =
    typeof parsed.TransactionID === "string" ? parsed.TransactionID : "";
  const payload = typeof parsed.Payload === "string" ? parsed.Payload : "";

  if (!store || !payload) {
    throw new ReceiptRejected("receipt is missing Store or Payload.");
  }

  return { store, transactionId, payload };
};

const verifyAndroid = async (
  payload: string,
  expectedProductId: string,
): Promise<VerifiedPurchase> => {
  const wrapper = parseJson(payload);
  const purchase = wrapper ? parseJson(wrapper.json) : null;
  if (!purchase) {
    throw new ReceiptRejected("Google Play payload could not be read.");
  }

  const purchaseToken =
    typeof purchase.purchaseToken === "string" ? purchase.purchaseToken : "";
  const productId =
    typeof purchase.productId === "string" ? purchase.productId : "";
  if (!purchaseToken || !productId) {
    throw new ReceiptRejected("Google Play payload is missing purchase data.");
  }
  if (productId !== expectedProductId) {
    throw new ReceiptRejected("Receipt productId does not match the request.");
  }

  let client;
  try {
    client = await getAndroidAuth().getClient();
  } catch (error) {
    throw new VerifierNotConfigured(
      `Google Play credentials unavailable: ${(error as Error).message}`,
    );
  }

  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(ANDROID_PACKAGE_NAME)}/purchases/products/` +
    `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;

  let response;
  try {
    response = await client.request<Record<string, unknown>>({ url });
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status === 401 || status === 403) {
      throw new VerifierNotConfigured(
        "Google Play rejected the service account. Grant it access in Play Console.",
      );
    }
    throw new ReceiptRejected("Google Play did not recognise this purchase.");
  }

  const data = response.data ?? {};
  if (Number(data.purchaseState) !== PURCHASE_STATE_PURCHASED) {
    throw new ReceiptRejected("Google Play purchase is not in a purchased state.");
  }

  const orderId = typeof data.orderId === "string" ? data.orderId : "";
  const fallbackOrderId =
    typeof purchase.orderId === "string" ? purchase.orderId : purchaseToken;

  return { transactionId: orderId || fallbackOrderId, productId };
};

interface AppleResponse {
  status?: number;
  receipt?: { in_app?: Record<string, unknown>[] };
  latest_receipt_info?: Record<string, unknown>[];
}

const callApple = async (
  url: string,
  receiptData: string,
  secret: string,
): Promise<AppleResponse> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      "receipt-data": receiptData,
      password: secret,
    }),
  });
  if (!response.ok) {
    throw new ReceiptRejected("Apple could not be reached to verify the receipt.");
  }
  return (await response.json()) as AppleResponse;
};

const verifyApple = async (
  payload: string,
  expectedProductId: string,
): Promise<VerifiedPurchase> => {
  const secret = process.env.APPLE_SHARED_SECRET;
  if (!secret) {
    throw new VerifierNotConfigured("APPLE_SHARED_SECRET is not configured.");
  }

  let result = await callApple(APPLE_PRODUCTION_URL, payload, secret);
  if (result.status === APPLE_SANDBOX_STATUS) {
    result = await callApple(APPLE_SANDBOX_URL, payload, secret);
  } else if (result.status === APPLE_PRODUCTION_STATUS) {
    result = await callApple(APPLE_PRODUCTION_URL, payload, secret);
  }

  if (result.status !== 0) {
    throw new ReceiptRejected(`Apple rejected the receipt (status ${result.status}).`);
  }

  const purchaseDate = (entry: Record<string, unknown>): number =>
    Number(entry.purchase_date_ms ?? 0);

  const match = [
    ...(result.latest_receipt_info ?? []),
    ...(result.receipt?.in_app ?? []),
  ]
    .filter((entry) => entry.product_id === expectedProductId)
    .sort((a, b) => purchaseDate(b) - purchaseDate(a))[0];

  if (!match) {
    throw new ReceiptRejected("Receipt does not contain the requested product.");
  }

  const transactionId =
    typeof match.transaction_id === "string"
      ? match.transaction_id
      : typeof match.original_transaction_id === "string"
        ? match.original_transaction_id
        : "";
  if (!transactionId) {
    throw new ReceiptRejected("Receipt has no transaction id.");
  }

  return { transactionId, productId: expectedProductId };
};

export const verifyReceipt = async (
  platform: IapPlatform,
  receipt: unknown,
  expectedProductId: string,
): Promise<VerifiedPurchase> => {
  const { payload } = parseUnityReceipt(receipt);
  return platform === "android"
    ? verifyAndroid(payload, expectedProductId)
    : verifyApple(payload, expectedProductId);
};
