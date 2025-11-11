import * as admin from 'firebase-admin';
import { testEnv } from './setup';
import { bindEmailPassword } from '../src/auth/bindEmailPassword';
import { normalizeEmail } from '../src/shared/normalize';

describe('Auth Binding (callable v2)', () => {
  const wrapped = testEnv.wrap(bindEmailPassword as any);

  beforeAll(async () => {
    try { await admin.auth().createUser({ uid: 'uid_test_anon' }); } catch {}
    await admin.firestore().doc('Players/uid_test_anon').set({ isGuest: true, authProviders: ['anonymous'] });
  });

  it('returns EMAIL_TAKEN when email belongs to another uid', async () => {
    const taken = 'taken@example.com';
    const norm = normalizeEmail(taken);
    await admin.firestore().doc(`AccountsEmails/${norm}`).set({ uid: 'another-uid' });

    await expect(
      wrapped({
        data: { opId: 'op_bind_taken', email: taken, password: 'CorrectHorseBatteryStaple' },
        auth: { uid: 'uid_test_anon', token: { firebase: { sign_in_provider: 'anonymous' } } },
        app: { appId: 'emu-app' },
      })
    ).rejects.toThrow(/EMAIL_TAKEN|already-exists/i);
  });
});