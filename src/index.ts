import * as admin from "firebase-admin";
import { callableOptions } from "./shared/callableOptions.js";
import { setGlobalOptions } from "firebase-functions/v2";
import { onCall } from "firebase-functions/v2/https";
import { REGION } from "./shared/region";

// Default to cold-start (minInstances = 0). Override via MIN_INSTANCES env when deploying.
const MIN_INSTANCES = Number(process.env.MIN_INSTANCES ?? "0");
setGlobalOptions({
  region: REGION,
  minInstances: Number.isFinite(MIN_INSTANCES) ? MIN_INSTANCES : 0,
});

// Initialize Firebase Admin SDK
admin.initializeApp();

// Simple ping function for health checks
export const ping = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

export * from "./auth";
// Export functions from other modules
export { exchangeGemsForCoins, claimRankUpReward, getLeaderboard } from "./economy";
export { getGemConversionPreview } from "./economy/preview.js";
export { adjustCoins } from "./economy/coins";
export { adjustGems } from "./economy/gems";
export { grantXP } from "./economy/xp";
export { purchaseShopSku, activateBooster, purchaseOffer, getDailyOffers, verifyIapPurchase, offerTransitionJob, offerSafetyNetJob, runOfferSafetyNet } from "./shop";
export { purchaseCar, upgradeCar, equipCosmetic, purchaseCrateItem, grantItem } from "./garage";
export { openCrate } from "./crates";
export { upgradeSpell, setLoadout, equipCosmetics, setSpellDeck, selectActiveSpellDeck } from "./spells";
export { startRace, generateBotLoadout, recordRaceResult } from "./race";
export { prepareRace } from "./race/prepareRace";
export { submitFeedback } from "./feedback";
export * from "./clan";
export { getMaintenanceStatus, claimMaintenanceReward } from "./game-systems/maintenance";
export { acknowledgeMaintenanceRewards } from "./game-systems/acknowledgeMaintenance";
export { setMaintenanceMode } from "./game-systems/adminMaintenance";
export { setMinimumVersion, getMinimumVersion } from "./game-systems/adminVersion";
export { searchGameUsers, setGameAdminStatus, getGameAdmins } from "./game-systems/adminGameUsers";
export { healthcheck } from "./health/healthcheck";
export * from "./profile";
export {
  referralGetMyReferralCode,
  referralClaimReferralCode,
  referralDebugLookup,
  acknowledgeReferralRewards,
} from "./referral";

export {
  getGlobalLeaderboard,
  getMyLeaderboardRank,
  searchPlayer,
  sendFriendRequest,
  sendFriendRequestByUid,
  acceptFriendRequest,
  rejectFriendRequest,
  getFriends,
  getFriendRequests,
  cancelFriendRequest,
  viewPlayerProfile,
  removeFriends,
  leaderboards,
} from "./Socials";
export { getServerTime } from "./time/serverTime";
export {
  refreshGlobalLeaderboardNow,
  refreshClanLeaderboardNow,
} from "./tools/leaderboardTriggers.js";
export { activateScheduledMaintenance } from "./game-systems/maintenanceActivator";

// Analytics Dashboard Functions
export {
  analyticsOverview,
  analyticsGrowth,
  analyticsPlatforms,
  analyticsRevenue,
  analyticsRevenueByProduct,
  analyticsRevenueByCountry,
  analyticsRetention,
  analyticsEvents,
  analyticsRealtime,
  analyticsGeography,
  analyticsDevices,
  analyticsSessions,
} from "./analytics";
export { testAnalytics } from "./analyticsTest";

// Admin Dashboard Authentication (bypasses App Check)
export { verifyAdminStatus } from "./admin/verifyAdminStatus";
export { getAdminMaintenanceStatus, getMaintenanceHistory } from "./admin/adminMaintenance";
export { getAdminVersionStatus, getVersionHistory } from "./admin/adminVersion";


