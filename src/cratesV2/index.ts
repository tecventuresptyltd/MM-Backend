/**
 * V2 Crates Module Index
 *
 * Exports all V2 crate-related Cloud Functions.
 */

// Crate Slots System
export {
    receiveCrateV2,
    startCrateUnlockV2,
    claimCrateRewardV2,
    skipCrateUnlockV2,
    getCrateSlotsStatusV2,
} from "./slotsV2.js";
