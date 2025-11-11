// src/shared/googleVerify.ts
import { OAuth2Client } from "google-auth-library";

const client = new OAuth2Client(); // no args needed in tests/emulator

export async function verifyGoogleIdToken(idToken: string) {
  const ticket = await client.verifyIdToken({ idToken, audience: undefined });
  const payload = ticket.getPayload();
  if (!payload?.email || !payload?.sub) {
    throw new Error("Invalid Google ID token payload");
  }
  return { email: payload.email, sub: payload.sub };
}