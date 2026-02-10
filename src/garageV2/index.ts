/**
 * V2 Garage Module Index
 *
 * Exports all V2 garage-related Cloud Functions.
 */

// Tier License System
export {
    purchaseTierLicenseV2,
    getTierCatalogV2,
    grantStarterTierLicense,
} from "./tiersV2.js";

// Car Evolution (Pit Crew)
export {
    startCarEvolutionV2,
    claimCarEvolutionV2,
    skipCarEvolutionV2,
    getPitCrewStatusV2,
    grantCarXP,
} from "./evolutionV2.js";

// Fuel System
export {
    refuelWithAdV2,
    useFuelCellV2,
    getCarFuelStatusV2,
    consumeFuel,
    getCarFuelState,
} from "./fuelV2.js";
