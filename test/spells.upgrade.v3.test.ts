import { admin } from "./setup";
import {
  ensureCatalogsSeeded,
  seedMinimalPlayer,
  wipeAuth,
  wipeFirestore,
} from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { upgradeSpell } from "../src/spells";
import { getSpellsCatalog } from "../src/core/config";
import { loadNonStarterSpellIds } from "../src/shared/catalogHelpers";

const authContext = (uid: string) => ({
  auth: { uid, token: { firebase: { sign_in_provider: "anonymous" } } },
});

type SpellCatalogEntry = Awaited<ReturnType<typeof getSpellsCatalog>>[string];

interface UpgradeFixture {
  spellId: string;
  catalogEntry: SpellCatalogEntry;
  levelOneCost: number;
  levelTwoCost: number;
}

describe("upgradeSpell (v3)", () => {
  let uid: string;
  let spellsCatalog: Awaited<ReturnType<typeof getSpellsCatalog>>;
  let fixture: UpgradeFixture;

  beforeAll(async () => {
    await ensureCatalogsSeeded();
    spellsCatalog = await getSpellsCatalog();
    const nonStarterSpellIds = await loadNonStarterSpellIds();
    fixture = selectUpgradeableSpell(spellsCatalog, new Set(nonStarterSpellIds));
  });
  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    uid = `spell-upgrade-${Date.now()}`;
    await seedMinimalPlayer(uid);
  });

  it("unlocks a level 0 spell when requirements are met", async () => {
    const profileRef = admin.firestore().doc(`Players/${uid}/Profile/Profile`);
    const economyRef = admin.firestore().doc(`Players/${uid}/Economy/Stats`);
    const spellsRef = admin.firestore().doc(`Players/${uid}/Spells/Levels`);

    await Promise.all([
      profileRef.set(
        { level: Math.max(10, fixture.catalogEntry.requiredLevel ?? 0) },
        { merge: true },
      ),
      economyRef.set({ spellTokens: 25 }, { merge: true }),
    ]);

    await ensureImmediatePrerequisiteUnlocked(uid, fixture.spellId, spellsCatalog);

    await spellsRef.set(
      {
        [`levels.${fixture.spellId}`]: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const wrapped = wrapCallable(upgradeSpell);
    const opId = `upgrade-${Date.now()}`;
    const response = await wrapped({
      data: { opId, spellId: fixture.spellId },
      ...authContext(uid),
    });

    expect(response.success).toBe(true);
    expect(response.newLevel).toBe(1);
    expect(response.spentTokens).toBe(0);

    const spellsDoc = await admin
      .firestore()
      .doc(`Players/${uid}/Spells/Levels`)
      .get();
    expect(spellsDoc.data()?.levels?.[fixture.spellId]).toBe(1);
  });

  it("rejects unlock when player level is too low", async () => {
    const profileRef = admin.firestore().doc(`Players/${uid}/Profile/Profile`);
    const economyRef = admin.firestore().doc(`Players/${uid}/Economy/Stats`);
    const spellsRef = admin.firestore().doc(`Players/${uid}/Spells/Levels`);

    await Promise.all([
      profileRef.set(
        { level: Math.max(0, (fixture.catalogEntry.requiredLevel ?? 0) - 1) },
        { merge: true },
      ),
      economyRef.set({ spellTokens: 25 }, { merge: true }),
    ]);

    await ensureImmediatePrerequisiteUnlocked(uid, fixture.spellId, spellsCatalog);

    await spellsRef.set(
      {
        [`levels.${fixture.spellId}`]: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    const wrapped = wrapCallable(upgradeSpell);

    await expect(
      wrapped({
        data: { opId: `upgrade-low-${Date.now()}`, spellId: fixture.spellId },
        ...authContext(uid),
      }),
    ).rejects.toHaveProperty("code", "failed-precondition");
  });

  it("deducts spell tokens on level 1 → 2 upgrade", async () => {
    const profileRef = admin.firestore().doc(`Players/${uid}/Profile/Profile`);
    const economyRef = admin.firestore().doc(`Players/${uid}/Economy/Stats`);
    const spellsRef = admin.firestore().doc(`Players/${uid}/Spells/Levels`);

    await Promise.all([
      profileRef.set({ level: Math.max(10, fixture.catalogEntry.requiredLevel ?? 0) }, { merge: true }),
      economyRef.set({ spellTokens: fixture.levelTwoCost + 10 }, { merge: true }),
      spellsRef.set(
        {
          levels: { [fixture.spellId]: 1 },
          unlockedAt: { [fixture.spellId]: admin.firestore.FieldValue.serverTimestamp() },
        },
        { merge: true },
      ),
    ]);

    const wrapped = wrapCallable(upgradeSpell);
    const response = await wrapped({
      data: { opId: `upgrade-to-2-${Date.now()}`, spellId: fixture.spellId },
      ...authContext(uid),
    });

    expect(response.success).toBe(true);
    expect(response.newLevel).toBe(2);
    expect(response.spentTokens).toBe(fixture.levelTwoCost);

    const updatedEconomy = await economyRef.get();
    expect(Number(updatedEconomy.data()?.spellTokens ?? 0)).toBe(10);
  });

  it("prevents upgrades when spell tokens are insufficient", async () => {
    const profileRef = admin.firestore().doc(`Players/${uid}/Profile/Profile`);
    const economyRef = admin.firestore().doc(`Players/${uid}/Economy/Stats`);
    const spellsRef = admin.firestore().doc(`Players/${uid}/Spells/Levels`);

    await Promise.all([
      profileRef.set({ level: Math.max(10, fixture.catalogEntry.requiredLevel ?? 0) }, { merge: true }),
      economyRef.set({ spellTokens: Math.max(0, fixture.levelTwoCost - 1) }, { merge: true }),
      spellsRef.set({ levels: { [fixture.spellId]: 1 } }, { merge: true }),
    ]);

    const wrapped = wrapCallable(upgradeSpell);

    await expect(
      wrapped({
        data: { opId: `upgrade-no-tokens-${Date.now()}`, spellId: fixture.spellId },
        ...authContext(uid),
      }),
    ).rejects.toHaveProperty("code", "resource-exhausted");
  });

  it("returns cached result when the same opId is replayed", async () => {
    const profileRef = admin.firestore().doc(`Players/${uid}/Profile/Profile`);
    const economyRef = admin.firestore().doc(`Players/${uid}/Economy/Stats`);

    await Promise.all([
      profileRef.set(
        { level: Math.max(10, fixture.catalogEntry.requiredLevel ?? 0) },
        { merge: true },
      ),
      economyRef.set({ spellTokens: 25 }, { merge: true }),
    ]);

    await ensureImmediatePrerequisiteUnlocked(uid, fixture.spellId, spellsCatalog);

    const wrapped = wrapCallable(upgradeSpell);
    const opId = `upgrade-idempotent-${Date.now()}`;

    const first = await wrapped({ data: { opId, spellId: fixture.spellId }, ...authContext(uid) });
    const second = await wrapped({ data: { opId, spellId: fixture.spellId }, ...authContext(uid) });

    expect(second).toEqual(first);
    const spellsDoc = await admin
      .firestore()
      .doc(`Players/${uid}/Spells/Levels`)
      .get();
    expect(spellsDoc.data()?.levels?.[fixture.spellId]).toBe(1);
  });
});

function selectUpgradeableSpell(
  catalog: Awaited<ReturnType<typeof getSpellsCatalog>>,
  candidateIds: Set<string>,
): UpgradeFixture {
  for (const [spellId, spell] of Object.entries(catalog)) {
    if (!candidateIds.has(spellId)) {
      continue;
    }
    const requiredLevel =
      typeof spell.requiredLevel === "number" ? spell.requiredLevel : 0;
    if (requiredLevel <= 0) {
      continue;
    }
    const levels = spell.levels ?? {};
    const levelOne = levels["1"] ?? levels[1];
    const levelTwo = levels["2"] ?? levels[2];
    if (!levelOne || !levelTwo) {
      continue;
    }
    const levelOneCost = normaliseCost(levelOne);
    const levelTwoCost = normaliseCost(levelTwo);
    return {
      spellId,
      catalogEntry: spell,
      levelOneCost,
      levelTwoCost,
    };
  }
  throw new Error("No suitable spell found for upgrade tests.");
}

function normaliseCost(levelConfig: Record<string, unknown>): number {
  const config = levelConfig as Record<string, any>;
  const tokenCost = config.tokenCost;
  if (typeof tokenCost === "number" && tokenCost >= 0) {
    return tokenCost;
  }
  const costField = config.cost;
  if (costField && typeof costField === "object") {
    const spellTokens = (costField as Record<string, unknown>).spellTokens;
    if (typeof spellTokens === "number" && spellTokens >= 0) {
      return spellTokens;
    }
  }
  return 0;
}

async function ensureImmediatePrerequisiteUnlocked(
  uid: string,
  spellId: string,
  catalog: Awaited<ReturnType<typeof getSpellsCatalog>>,
): Promise<void> {
  const prerequisiteId = resolveImmediatePrerequisiteSpellId(catalog, spellId);
  if (!prerequisiteId) {
    return;
  }
  const spellsRef = admin.firestore().doc(`Players/${uid}/Spells/Levels`);
  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  await spellsRef.set(
    {
      [`levels.${prerequisiteId}`]: 1,
      [`unlockedAt.${prerequisiteId}`]: timestamp,
      updatedAt: timestamp,
    },
    { merge: true },
  );
}

interface OrderedSpellEntry {
  id: string;
  requiredLevel: number;
  isDefault: boolean;
  name: string;
}

function normalizeRequiredLevelForTest(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  if (numeric < 0) {
    return 100;
  }
  return Math.floor(numeric);
}

function orderSpellEntries(
  catalog: Awaited<ReturnType<typeof getSpellsCatalog>>,
): OrderedSpellEntry[] {
  return Object.entries(catalog)
    .map(([id, spell]) => {
      const requiredLevel = normalizeRequiredLevelForTest(spell.requiredLevel);
      const isDefault = spell.isUnlocked === true || requiredLevel <= 0;
      const name =
        typeof spell.displayName === "string"
          ? spell.displayName
          : typeof spell.i18n?.en === "string"
          ? spell.i18n.en
          : id;
      return { id, requiredLevel, isDefault, name };
    })
    .sort((a, b) => {
      if (a.requiredLevel !== b.requiredLevel) {
        return a.requiredLevel - b.requiredLevel;
      }
      if (a.isDefault !== b.isDefault) {
        return a.isDefault ? -1 : 1;
      }
      if (a.name !== b.name) {
        return a.name.localeCompare(b.name);
      }
      return a.id.localeCompare(b.id);
    });
}

function resolveImmediatePrerequisiteSpellId(
  catalog: Awaited<ReturnType<typeof getSpellsCatalog>>,
  targetSpellId: string,
): string | null {
  const ordered = orderSpellEntries(catalog);
  const index = ordered.findIndex((entry) => entry.id === targetSpellId);
  if (index <= 0) {
    return null;
  }
  const prior = ordered[index - 1];
  return prior.isDefault ? null : prior.id;
}
