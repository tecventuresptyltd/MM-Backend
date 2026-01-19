/**
 * Gamemode types and helpers for multi-mode trophy support.
 */

/**
 * Available game modes.
 * - RANKED: Standard competitive mode with clan trophy sync
 * - ELIMINATION: New game mode with separate trophy tracking
 */
export type GameMode = "RANKED" | "ELIMINATION";

/**
 * Default gamemode when none is specified (backward compatibility).
 */
export const DEFAULT_GAMEMODE: GameMode = "RANKED";

/**
 * Trophy field mappings per gamemode.
 */
export const GAMEMODE_TROPHY_FIELDS: Record<GameMode, {
    current: "trophies" | "eliminationTrophies";
    highest: "highestTrophies" | "highestEliminationTrophies";
    leaderboardMetric: "trophies" | "eliminationTrophies";
}> = {
    RANKED: {
        current: "trophies",
        highest: "highestTrophies",
        leaderboardMetric: "trophies",
    },
    ELIMINATION: {
        current: "eliminationTrophies",
        highest: "highestEliminationTrophies",
        leaderboardMetric: "eliminationTrophies",
    },
};

/**
 * Type guard for GameMode.
 */
export const isValidGameMode = (value: unknown): value is GameMode =>
    value === "RANKED" || value === "ELIMINATION";

/**
 * Resolve gamemode from input, defaulting to RANKED for backward compatibility.
 */
export const resolveGameMode = (value: unknown): GameMode =>
    isValidGameMode(value) ? value : DEFAULT_GAMEMODE;

/**
 * Get trophy fields for a gamemode.
 */
export const getTrophyFields = (mode: GameMode) => GAMEMODE_TROPHY_FIELDS[mode];

/**
 * Check if a gamemode should sync clan trophies.
 * Currently only RANKED mode syncs to clan.
 */
export const shouldSyncClanTrophies = (mode: GameMode): boolean => mode === "RANKED";
