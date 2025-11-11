import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region";
import { getActiveGameConfig } from "../core/config";

// This is a placeholder for the real bot generation logic.
// In a real scenario, this would be a complex system that reads from GameData.
interface BotLoadout {
  carId: string;
  cosmetics: {
    wheels: string;
    decals: string;
    spoilers: string | null;
    underglow: string | null;
    boost: string | null;
  };
  spellDeck: { name: string; level: number }[];
  difficultyStats: {
    maxSpeed: number;
    acceleration: number;
    boostTime: number;
    boostFrequency: number;
    boostCooldown: number;
  };
}

function generateLoadout(): BotLoadout {
  return {
    carId: "car_9q7m2k4d1t",
    cosmetics: {
      wheels: "item_1p5x7r0m3n",
      decals: "item_7k2m4d1tq9",
      spoilers: null,
      underglow: null,
      boost: null,
    },
    spellDeck: [
      { name: "Shockwave", level: 2 },
      { name: "Speed Boost", level: 3 },
    ],
    difficultyStats: {
      maxSpeed: 150,
      acceleration: 8,
      boostTime: 1.5,
      boostFrequency: 5,
      boostCooldown: 3,
    },
  };
}

export const generateBotLoadout = onCall({ region: REGION }, async (request) => {
  const { trophyCount } = request.data;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (typeof trophyCount !== "number" || trophyCount < 0) {
    throw new HttpsError("invalid-argument", "Trophy count must be a non-negative number.");
  }

  try {
    // In a real scenario, the config would be used to tune the generation logic
    await getActiveGameConfig();

    const botLoadout = generateLoadout();

    return {
      success: true,
      botLoadout,
    };
  } catch (error) {
    const e = error as Error;
    throw new HttpsError("internal", e.message, e);
  }
});