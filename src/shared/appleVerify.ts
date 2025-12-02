import crypto from "crypto";
import { HttpsError } from "firebase-functions/v2/https";

const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";
const DEFAULT_JWKS_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface AppleJwk {
  kty: string;
  kid: string;
  use: string;
  n?: string;
  e?: string;
  alg?: string;
}

interface AppleIdentityPayload {
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  sub: string;
  email?: string;
  email_verified?: string | boolean;
  nonce?: string;
}

let cachedKeys: { keys: AppleJwk[]; fetchedAt: number } | null = null;

const base64UrlDecode = (input: string): Buffer => {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
};

const loadAppleKeys = async (): Promise<AppleJwk[]> => {
  const now = Date.now();
  if (cachedKeys && now - cachedKeys.fetchedAt < DEFAULT_JWKS_TTL_MS) {
    return cachedKeys.keys;
  }

  const fetchImpl: any = (globalThis as any).fetch
    ? (globalThis as any).fetch.bind(globalThis)
    : (await import("node-fetch")).default;

  const response = await fetchImpl(APPLE_KEYS_URL);
  if (!response.ok) {
    throw new HttpsError(
      "internal",
      `Failed to fetch Apple signing keys: ${response.status}`,
    );
  }
  const data = (await response.json()) as { keys?: AppleJwk[] };
  const keys = Array.isArray(data.keys) ? data.keys : [];
  if (keys.length === 0) {
    throw new HttpsError("internal", "Apple signing keys response was empty.");
  }
  cachedKeys = { keys, fetchedAt: now };
  return keys;
};

const jwkToPublicKey = (jwk: AppleJwk): crypto.KeyObject => {
  try {
    const jwkInput: crypto.JsonWebKey = {
      kty: jwk.kty,
      kid: jwk.kid,
      use: jwk.use,
      n: jwk.n,
      e: jwk.e,
      alg: jwk.alg,
    };
    return crypto.createPublicKey({ key: jwkInput, format: "jwk" });
  } catch (error) {
    throw new HttpsError("internal", "Failed to parse Apple signing key.");
  }
};

const verifySignature = (
  signingInput: string,
  signatureB64: string,
  key: crypto.KeyObject,
): boolean => {
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(signingInput);
  verifier.end();
  return verifier.verify(key, base64UrlDecode(signatureB64));
};

const getAudience = (audClaim: string | string[]): string[] => {
  if (Array.isArray(audClaim)) {
    return audClaim.map((entry) => String(entry)).filter(Boolean);
  }
  if (typeof audClaim === "string") {
    return [audClaim];
  }
  return [];
};

const normaliseBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
};

export const getAppleAudienceFromEnv = (): string => {
  const audience =
    process.env.APPLE_AUDIENCE ||
    process.env.APPLE_CLIENT_ID ||
    process.env.APPLE_SERVICE_ID;
  if (!audience) {
    throw new HttpsError(
      "failed-precondition",
      "APPLE_AUDIENCE (or APPLE_CLIENT_ID / APPLE_SERVICE_ID) env var must be set.",
    );
  }
  return audience;
};

export const verifyAppleIdentityToken = async (
  identityToken: string,
  opts: { audience: string; nonce?: string },
): Promise<{ sub: string; email?: string; emailVerified?: boolean }> => {
  if (typeof identityToken !== "string" || !identityToken.includes(".")) {
    throw new HttpsError("invalid-argument", "Invalid Apple identity token.");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = identityToken.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new HttpsError("invalid-argument", "Malformed Apple identity token.");
  }

  let header: { kid?: string; alg?: string };
  let payload: AppleIdentityPayload;
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
  } catch {
    throw new HttpsError("invalid-argument", "Unable to parse Apple identity token.");
  }

  const keys = await loadAppleKeys();
  const signingKey = keys.find((key) => key.kid === header.kid) ?? keys[0];
  if (!signingKey) {
    throw new HttpsError("internal", "No Apple signing key available.");
  }

  const publicKey = jwkToPublicKey(signingKey);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signatureValid = verifySignature(signingInput, encodedSignature, publicKey);
  if (!signatureValid) {
    throw new HttpsError("unauthenticated", "Apple identity token signature is invalid.");
  }

  if (payload.iss !== APPLE_ISSUER) {
    throw new HttpsError("unauthenticated", "Apple identity token issuer mismatch.");
  }
  const audiences = getAudience(payload.aud);
  if (!audiences.includes(opts.audience)) {
    throw new HttpsError("unauthenticated", "Apple identity token audience mismatch.");
  }
  const nowSeconds = Math.floor(Date.now() / 1000) - 60; // allow 60s clock skew
  if (typeof payload.exp === "number" && payload.exp < nowSeconds) {
    throw new HttpsError("unauthenticated", "Apple identity token is expired.");
  }
  if (opts.nonce && payload.nonce !== opts.nonce) {
    throw new HttpsError("unauthenticated", "Apple identity token nonce mismatch.");
  }

  if (!payload.sub) {
    throw new HttpsError("invalid-argument", "Apple identity token missing subject.");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: normaliseBoolean(payload.email_verified),
  };
};
