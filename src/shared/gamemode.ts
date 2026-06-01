/**
 * Gamemode types and helpers for multi-mode trophy support.
 */

/**
 * Available game modes.
 * - RANKED: Standard competitive mode with clan trophy sync
 * - ELIMINATION: New game mode with separate trophy tracking
 * - UNRANKED: Training mode with no trophy impact, reduced rewards
 * - POLICE: Police game mode with separate trophy tracking, mimicking ELIMINATION
 */
export type GameMode = "RANKED" | "ELIMINATION" | "UNRANKED" | "POLICE";

/**
 * Default gamemode when none is specified (backward compatibility).
 */
export const DEFAULT_GAMEMODE: GameMode = "RANKED";

/**
 * Trophy field mappings per gamemode.
 */
export const GAMEMODE_TROPHY_FIELDS: Record<GameMode, {
    current: "trophies" | "eliminationTrophies" | "policeTrophies";
    highest: "highestTrophies" | "highestEliminationTrophies" | "highestPoliceTrophies";
    leaderboardMetric: "trophies" | "eliminationTrophies" | "policeTrophies" | null;
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
    POLICE: {
        current: "policeTrophies",
        highest: "highestPoliceTrophies",
        leaderboardMetric: "policeTrophies",
    },
    UNRANKED: {
        current: "trophies",  // Read-only, uses RANKED trophies
        highest: "highestTrophies",  // Not modified
        leaderboardMetric: null,  // No leaderboard
    },
};

/**
 * Type guard for GameMode.
 */
export const isValidGameMode = (value: unknown): value is GameMode =>
    value === "RANKED" || value === "ELIMINATION" || value === "UNRANKED" || value === "POLICE";

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

/**
 * Check if a gamemode modifies player trophies.
 * UNRANKED does not affect trophies.
 */
export const shouldModifyTrophies = (mode: GameMode): boolean => mode !== "UNRANKED";

/**
 * Check if a gamemode has a leaderboard.
 * UNRANKED does not have a leaderboard.
 */
export const hasLeaderboard = (mode: GameMode): boolean => mode !== "UNRANKED";

/**
 * Get the trophy source for bot difficulty calculation.
 * UNRANKED always uses RANKED trophies.
 */
export const getTrophySourceForBots = (mode: GameMode): "trophies" | "eliminationTrophies" | "policeTrophies" => {
    if (mode === "ELIMINATION") return "eliminationTrophies";
    if (mode === "POLICE") return "policeTrophies";
    return "trophies";
};

