import * as admin from 'firebase-admin';
import { testEnv } from './setup';
import { normalizeEmail } from '../src/shared/normalize';
import { wipeAuth, wipeFirestore, ensureCatalogsSeeded } from './helpers/cleanup';
import { loadStarterRewards } from '../src/shared/starterRewards';
import { loadStarterSpellIds } from '../src/shared/catalogHelpers';

jest.mock('../src/shared/googleVerify', () => ({
  verifyGoogleIdToken: jest.fn(async (idToken: string) => {
    if (idToken.includes('existing_email')) {
      return { email: 'existing@example.com', sub: 'google-sub-existing' };
    }
    return { email: 'new.google.user@example.com', sub: 'google-sub-123' };
  }),
}));

describe('Auth Signup (callable v2)', () => {
  let wrappedEmail: any;
  let wrappedGoogle: any;

  beforeAll(() => {
    const { signupEmailPassword } = require('../src/auth/signupEmailPassword');
    const { signupGoogle } = require('../src/auth/signupGoogle');
    wrappedEmail = testEnv.wrap(signupEmailPassword);
    wrappedGoogle = testEnv.wrap(signupGoogle);
  });

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    await ensureCatalogsSeeded();
  });

  describe('signupEmailPassword', () => {
    it('successfully signs up a new user', async () => {
      const email = 'new.user@example.com';
      const password = 'password123';
      const opId = 'op_email_signup_success';

      const { customToken } = await wrappedEmail({
        data: { opId, email, password, platform: 'ios', appVersion: '1.0.0' },
      });

      expect(customToken).toBeTruthy();
      const decodedToken = JSON.parse(Buffer.from(customToken.split('.')[1], 'base64').toString());
      const uid = decodedToken.uid;

      const emailKey = normalizeEmail(email);
      const emailDoc = await admin.firestore().doc(`AccountsEmails/${emailKey}`).get();
      expect(emailDoc.data()?.uid).toEqual(uid);

      const playerDoc = await admin.firestore().doc(`Players/${uid}`).get();
      expect(playerDoc.data()?.isGuest).toBe(false);

      await verifyDefaultPlayerData(uid);
    });

    it('throws EMAIL_TAKEN for duplicate email', async () => {
      const email = 'existing.user@example.com';
      const password = 'password123';
      const opId = 'op_email_signup_duplicate';
      const emailKey = normalizeEmail(email);
      await admin.firestore().doc(`AccountsEmails/${emailKey}`).set({ uid: 'some_uid' });

      await expect(
        wrappedEmail({ data: { opId, email, password, platform: 'ios', appVersion: '1.0.0' } })
      ).rejects.toThrow('Email is already taken.');
    });

    it('records device anchor as a reference on signup (does not claim)', async () => {
      const email = 'anchor.user@example.com';
      const password = 'password123';
      const deviceAnchor = 'unique_device_anchor';
      const opId = 'op_email_signup_anchor';

      const { customToken } = await wrappedEmail({
        data: { opId, email, password, deviceAnchor, platform: 'ios', appVersion: '1.0.0' },
      });

      const decodedToken = JSON.parse(Buffer.from(customToken.split('.')[1], 'base64').toString());
      const uid = decodedToken.uid;

      // Anchor doc should NOT be created for full accounts
      const anchorDoc = await admin.firestore().doc(`AccountsDeviceAnchors/${deviceAnchor}`).get();
      expect(anchorDoc.exists).toBe(false);

      // Player should have reference to the deviceAnchor
      const playerDoc = await admin.firestore().doc(`Players/${uid}`).get();
      const refs: string[] = (playerDoc.data()?.knownDeviceAnchors ?? []) as string[];
      expect(refs).toContain(deviceAnchor);
    });

    it('allows signup when device anchor is already taken (keeps reference only)', async () => {
      const email = 'another.anchor.user@example.com';
      const password = 'password123';
      const deviceAnchor = 'taken_device_anchor';
      const opId = 'op_email_signup_anchor_taken';
      await admin.firestore().doc(`AccountsDeviceAnchors/${deviceAnchor}`).set({ uid: 'another_uid' });

      const { customToken } = await wrappedEmail({ data: { opId, email, password, deviceAnchor, platform: 'ios', appVersion: '1.0.0' } });
      expect(customToken).toBeTruthy();

      const decodedToken = JSON.parse(Buffer.from(customToken.split('.')[1], 'base64').toString());
      const uid = decodedToken.uid;

      // Anchor remains with original owner
      const anchorDoc = await admin.firestore().doc(`AccountsDeviceAnchors/${deviceAnchor}`).get();
      expect(anchorDoc.data()?.uid).toEqual('another_uid');

      // Player has a reference to the anchor
      const playerDoc = await admin.firestore().doc(`Players/${uid}`).get();
      const refs: string[] = (playerDoc.data()?.knownDeviceAnchors ?? []) as string[];
      expect(refs).toContain(deviceAnchor);
    });

    it('is idempotent', async () => {
      const email = 'idempotent.user@example.com';
      const password = 'password123';
      const opId = 'op_email_signup_idempotent';

      const res1 = await wrappedEmail({ data: { opId, email, password, platform: 'ios', appVersion: '1.0.0' } });
      const res2 = await wrappedEmail({ data: { opId, email, password, platform: 'ios', appVersion: '1.0.0' } });

      expect(res1.uid).toEqual(res2.uid);
    });
  });

  describe('signupGoogle', () => {
    it('successfully signs up a new user with Google', async () => {
      const idToken = 'mock_google_id_token';
      const opId = 'op_google_signup_success';

      const { customToken } = await wrappedGoogle({
        data: { opId, idToken, platform: 'ios', appVersion: '1.0.0' },
      });

      expect(customToken).toBeTruthy();
      const decodedToken = JSON.parse(Buffer.from(customToken.split('.')[1], 'base64').toString());
      const uid = decodedToken.uid;

      const emailKey = normalizeEmail('new.google.user@example.com');
      const emailDoc = await admin.firestore().doc(`AccountsEmails/${emailKey}`).get();
      expect(emailDoc.data()?.uid).toEqual(uid);

      const playerDoc = await admin.firestore().doc(`Players/${uid}`).get();
      expect(playerDoc.data()?.isGuest).toBe(false);

      await verifyDefaultPlayerData(uid);
    });

    it('links to an existing account if email is already in use', async () => {
        const idToken = 'mock_google_id_token_existing_email';
        const opId = 'op_google_signup_link';
        const email = 'existing@example.com';
        const existingUid = 'uid_existing_google_user';
  
  
        const emailKey = normalizeEmail(email);
        await admin.firestore().doc(`AccountsEmails/${emailKey}`).set({ uid: existingUid });
        await admin.firestore().doc(`Players/${existingUid}`).set({ isGuest: false });
  
        const { customToken } = await wrappedGoogle({
            data: { opId, idToken, platform: 'ios', appVersion: '1.0.0' },
        });
  
        const decodedToken = JSON.parse(Buffer.from(customToken.split('.')[1], 'base64').toString());
        expect(decodedToken.uid).toEqual(existingUid);
      });
  });
});

async function verifyDefaultPlayerData(uid: string) {
  const db = admin.firestore();
  const playerRef = db.collection("Players").doc(uid);
  const starterRewards = await loadStarterRewards();
  const starterSpellIds = await loadStarterSpellIds();

  // 1. Verify Garage
  const garageDoc = await playerRef.collection("Garage").doc("Cars").get();
  expect(garageDoc.exists).toBe(true);
  const cars = garageDoc.data()?.cars ?? {};
  expect(cars["car_h4ayzwf31g"]?.upgradeLevel).toEqual(0);

  // 2. Verify Economy
  const economyDoc = await playerRef.collection("Economy").doc("Stats").get();
  expect(economyDoc.exists).toBe(true);
  const economyData = economyDoc.data() ?? {};
  expect(economyData.coins).toBeGreaterThanOrEqual(0);
  expect(economyData.trophies).toBeUndefined();
  expect(economyData.level).toBeUndefined();

  // 3. Verify Inventory
  const crateDoc = await playerRef
    .collection("Inventory")
    .doc(starterRewards.crateSkuId)
    .get();
  expect(crateDoc.exists).toBe(true);
  expect(crateDoc.data()?.quantity ?? crateDoc.data()?.qty).toEqual(1);

  const keyDoc = await playerRef
    .collection("Inventory")
    .doc(starterRewards.keySkuId)
    .get();
  expect(keyDoc.exists).toBe(true);
  expect(keyDoc.data()?.quantity ?? keyDoc.data()?.qty).toEqual(1);

  // 4. Verify Progress
  const progressDoc = await playerRef.collection("Progress").doc("Initial").get();
  expect(progressDoc.exists).toBe(true);

  // 5. Verify Daily
  const dailyDoc = await playerRef.collection("Daily").doc("Status").get();
  expect(dailyDoc.exists).toBe(true);

  // 6. Verify Social
  const socialDoc = await playerRef.collection("Social").doc("Profile").get();
  expect(socialDoc.exists).toBe(true);

  // 7. Verify Loadouts
  const loadoutsDoc = await playerRef.collection("Loadouts").doc("Active").get();
  expect(loadoutsDoc.exists).toBe(true);
  expect(loadoutsDoc.data()?.carId).toEqual("car_h4ayzwf31g");
  expect(loadoutsDoc.data()?.activeSpellDeck).toEqual(1);

  // 8. Verify Spell Deck singleton
  const spellDecksDoc = await playerRef.collection("SpellDecks").doc("Decks").get();
  expect(spellDecksDoc.exists).toBe(true);
  const decks = spellDecksDoc.data()?.decks ?? {};
  expect(decks["1"]?.spells?.[0]).toEqual(starterSpellIds[0]);

  // 9. Verify spells singleton
  const spellsDoc = await playerRef.collection("Spells").doc("Levels").get();
  expect(spellsDoc.exists).toBe(true);
  expect(spellsDoc.data()?.levels?.[starterSpellIds[0]]).toEqual(1);
}
