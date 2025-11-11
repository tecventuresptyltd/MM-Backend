import { admin } from "./setup";
import {
  wipeFirestore,
  wipeAuth,
  seedMinimalPlayer,
  ensureCatalogsSeeded,
} from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { upgradeSpell } from "../src/spells";
import { loadStarterSpellIds } from "../src/shared/catalogHelpers";
import { getSpellsCatalog } from "../src/core/config";

describe("Spells Functions", () => {
  let uid: string;
  let spellsCatalog: Awaited<ReturnType<typeof getSpellsCatalog>>;
  let starterSpellIds: string[];
  let upgradeTarget: {
    spellId: string;
    currentLevel: number;
    nextLevel: number;
    cost: number;
    requiredPlayerLevel: number;
  };

  const authFor = (uid: string) => ({
    auth: { uid, token: { firebase: { sign_in_provider: "anonymous" } } },
  });

  const resolveUpgradeTarget = () => {
    for (const [spellId, spell] of Object.entries(spellsCatalog)) {
      const levels = spell.levels ?? {};
      const numericLevels = Object.keys(levels)
        .map((key) => Number(key))
        .filter((level) => Number.isFinite(level) && level >= 1)
        .sort((a, b) => a - b);
      if (numericLevels.length === 0) {
        continue;
      }
      const currentLevel = numericLevels[0];
      const nextLevel = currentLevel + 1;
      const nextConfig = levels[String(nextLevel)] ?? levels[nextLevel];
      if (!nextConfig) {
        continue;
      }
      const cost =
        typeof nextConfig.tokenCost === "number"
          ? nextConfig.tokenCost
          : typeof nextConfig.cost?.spellTokens === "number"
          ? nextConfig.cost.spellTokens
          : 0;
      if (cost <= 0) {
        continue;
      }
      return {
        spellId,
        currentLevel,
        nextLevel,
        cost,
        requiredPlayerLevel: Math.max(0, spell.requiredLevel ?? 0),
      };
    }
    throw new Error("No upgradeable spell found in catalog.");
  };

  beforeAll(async () => {
    await ensureCatalogsSeeded();
    spellsCatalog = await getSpellsCatalog();
    starterSpellIds = await loadStarterSpellIds();
    upgradeTarget = resolveUpgradeTarget();
  });

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    uid = `test-uid-${Date.now()}`;
    await seedMinimalPlayer(uid);
  });

  describe("upgradeSpell", () => {
    it("upgrades a real catalog spell and deducts tokens", async () => {
      const economyRef = admin.firestore().doc(`Players/${uid}/Economy/Stats`);
      const profileRef = admin
        .firestore()
        .doc(`Players/${uid}/Profile/Profile`);
      const spellsRef = admin.firestore().doc(`Players/${uid}/Spells/Levels`);

      await Promise.all([
        economyRef.set(
          {
            spellTokens: upgradeTarget.cost + 10,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        ),
        profileRef.set(
          {
            level: Math.max(upgradeTarget.requiredPlayerLevel, 10),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        ),
        spellsRef.set(
          {
            levels: {
              [upgradeTarget.spellId]: upgradeTarget.currentLevel,
            },
          },
          { merge: true },
        ),
      ]);

      const wrapped = wrapCallable(upgradeSpell);
      const opId = `op_upgrade_spell_${Date.now()}`;
      const result = await wrapped({
        data: { spellId: upgradeTarget.spellId, opId },
        ...authFor(uid),
      });

      expect(result.success).toBe(true);
      expect(result.newLevel ?? result.levelAfter ?? 0).toBe(
        upgradeTarget.nextLevel,
      );

      const updatedSpells = await spellsRef.get();
      expect(
        Number(updatedSpells.data()?.levels?.[upgradeTarget.spellId] ?? 0),
      ).toBe(upgradeTarget.nextLevel);

      const updatedEconomy = await economyRef.get();
      expect(Number(updatedEconomy.data()?.spellTokens ?? 0)).toBe(
        upgradeTarget.cost + 10 - upgradeTarget.cost,
      );
    });
  });

  describe("catalog integrity", () => {
    it("ensures requiredLevel is non-negative for all spells", () => {
      for (const spell of Object.values(spellsCatalog)) {
        expect(spell.requiredLevel).toBeGreaterThanOrEqual(0);
      }
    });

    it("ensures displayOrder is sequential with no gaps", () => {
      const sortedOrders = Array.from(
        new Set(Object.values(spellsCatalog).map((spell) => spell.displayOrder)),
      ).sort((a, b) => a - b);
      sortedOrders.forEach((order, index) => {
        expect(order).toBe(index + 1);
      });
    });

    it("places starter spells in displayOrder slots 1 through 5", () => {
      const orderedStarters = starterSpellIds
        .map((spellId) => ({
          spellId,
          order: spellsCatalog[spellId]?.displayOrder ?? Infinity,
        }))
        .filter((entry) => Number.isFinite(entry.order))
        .sort((a, b) => a.order - b.order);
      expect(orderedStarters.length).toBeGreaterThanOrEqual(5);
      const firstFive = orderedStarters.slice(0, 5).map((entry) => entry.order);
      expect(firstFive).toEqual([1, 2, 3, 4, 5]);
    });
  });
});
