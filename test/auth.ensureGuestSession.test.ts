import * as admin from "firebase-admin";
import { ensureGuestSession } from "../src/auth/ensureGuestSession";
import { wipeFirestore, wipeAuth, ensureCatalogsSeeded } from "./helpers/cleanup";
import { loadStarterRewards } from "../src/shared/starterRewards";
import { wrapCallable } from "./helpers/callable";

describe('ensureGuestSession (callable v2)', () => {
  const wrapped = wrapCallable(ensureGuestSession as any);
  let starterRewards: Awaited<ReturnType<typeof loadStarterRewards>>;
  const readSummaryCount = (
    totals: Record<string, unknown> | undefined,
    key: string,
  ): number =>
    Number(
      totals?.[key] ??
        (totals as Record<string, unknown> | undefined)?.[`${key}s`] ??
        0,
    );

  beforeAll(async () => {
    await ensureCatalogsSeeded();
    starterRewards = await loadStarterRewards();
  });

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    await ensureCatalogsSeeded();
  });

  it('returns ok for a new guest with valid data', async () => {
    const res = await wrapped({
      data: {
        opId: 'op_1',
        deviceAnchor: 'a3b4c5d6e7f809112233445566778899', // valid 32 hex
        platform: 'ios',
        appVersion: '1.0.0',
      },
      auth: { uid: 'uid_test_anon', token: { firebase: { sign_in_provider: 'anonymous' } } },
      app: { appId: 'emu-app' },
    });
    expect(res).toEqual(expect.objectContaining({ status: 'ok', uid: 'uid_test_anon' }));

    const db = admin.firestore();
    const playerDoc = await db.collection('Players').doc('uid_test_anon').get();
    expect(playerDoc.exists).toBe(true);
    const profileDoc = await db.doc(`Players/uid_test_anon/Profile/Profile`).get();
    const boosters = profileDoc.data()?.boosters;
    expect(boosters && typeof boosters === "object").toBe(true);
    
    // Verify that all default sub-collections are created
    const subcollections = ['Economy', 'Garage', 'Inventory', 'Progress', 'Daily', 'Social', 'Loadouts'];
    for (const subcollection of subcollections) {
      const snapshot = await db.collection('Players').doc('uid_test_anon').collection(subcollection).limit(1).get();
      expect(snapshot.empty).toBe(false);
    }

    const crateDoc = await db
      .doc(`Players/uid_test_anon/Inventory/${starterRewards.crateSkuId}`)
      .get();
    expect(crateDoc.exists).toBe(true);
    const summaryDoc = await db
      .doc(`Players/uid_test_anon/Inventory/_summary`)
      .get();
    expect(readSummaryCount(summaryDoc.data()?.totalsByCategory ?? {}, "crate")).toBeGreaterThanOrEqual(1);
  });

  it('throws INVALID_ARGUMENT when data is missing', async () => {
    await expect(
      wrapped({ data: undefined as any, auth: { uid: 'x', token: {} as any } } as any)
    ).rejects.toHaveProperty('code', 'invalid-argument');
  });

  it('creates a new guest when no auth is provided', async () => {
    const res = await wrapped({
      data: { opId: 'op_2', deviceAnchor: 'b3b4c5d6e7f809112233445566778899', platform: 'ios', appVersion: '1.0.0' },
      auth: undefined as any,
    } as any);

    expect(res).toEqual(expect.objectContaining({ status: 'ok', mode: 'new', uid: expect.any(String) }));

    const db = admin.firestore();
    const playerDoc = await db.collection('Players').doc(res.uid).get();
    expect(playerDoc.exists).toBe(true);
    const crateDoc = await db
      .doc(`Players/${res.uid}/Inventory/${starterRewards.crateSkuId}`)
      .get();
    expect(crateDoc.exists).toBe(true);
  });

  it('vacates anchor if it belongs to a full account and creates a new guest', async () => {
    const db = admin.firestore();
    const fullUid = 'uid_full_account';
    const deviceAnchor = 'c3b4c5d6e7f809112233445566778899';

    // Simulate an anchor previously pointing to a full account
    await db.doc(`Players/${fullUid}`).set({ isGuest: false }, { merge: true });
    await db.doc(`AccountsDeviceAnchors/${deviceAnchor}`).set({ uid: fullUid });

    const res = await wrapped({
      data: { opId: 'op_vacate_full_owner', deviceAnchor, platform: 'ios', appVersion: '1.0.0' },
      auth: undefined as any,
    } as any);

    expect(res.status).toBe('ok');
    expect(res.mode).toBe('new');
    expect(res.uid).not.toBe(fullUid);

    const anchorDoc = await db.doc(`AccountsDeviceAnchors/${deviceAnchor}`).get();
    expect(anchorDoc.data()?.uid).toBe(res.uid);

    const fullPlayer = await db.doc(`Players/${fullUid}`).get();
    const refs: string[] = (fullPlayer.data()?.knownDeviceAnchors ?? []) as string[];
    expect(refs).toContain(deviceAnchor);

    const inventoryDoc = await db
      .doc(`Players/${res.uid}/Inventory/${starterRewards.crateSkuId}`)
      .get();
    expect(inventoryDoc.exists).toBe(true);
  });
});
