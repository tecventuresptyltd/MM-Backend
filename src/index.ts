import * as admin from "firebase-admin";
import { setGlobalOptions } from "firebase-functions/v2";
import { REGION } from "./shared/region";

// Default to cold-start (minInstances = 0). Override via MIN_INSTANCES env when deploying.
const MIN_INSTANCES = Number(process.env.MIN_INSTANCES ?? "0");
setGlobalOptions({
  region: REGION,
  minInstances: Number.isFinite(MIN_INSTANCES) ? MIN_INSTANCES : 0,
});

// Initialize Firebase Admin SDK
admin.initializeApp();

// Every player-facing callable is served by this one gateway. The callables
// themselves live in src/callables.ts and are no longer deployed individually.
export { gameApi } from "./server/gameApi.js";

// Scheduled jobs, task queues and database triggers are invoked by Firebase
// itself, so they cannot be routed through the gateway.
export { offerTransitionJob, offerSafetyNetJob } from "./shop";
export { openWorldLobbyReaper } from "./race/openWorldLobby";
export { activateScheduledMaintenance } from "./game-systems/maintenanceActivator";
export { recommendedClansPoolJob } from "./clan/recommendations.js";
export { cleanupChatHistory, onPresenceUpdate } from "./clan/chat.js";
export { onPlayerProfileUpdate } from "./clan/onPlayerProfileUpdate.js";
export { clanLeaderboardJob } from "./clan/leaderboardJob.js";
export { clanMemberSyncJob } from "./clan/memberSyncJob.js";
export { leaderboards } from "./Socials";
export { presenceReaper } from "./Socials/presenceReaper.js";
export { upgradeCompletionJob, completeUpgradeTask } from "./upgrades";

// Plain HTTP endpoints. The admin dashboard calls these directly.
export { healthcheck } from "./health/healthcheck";
export { admobSsv } from "./ads/admobSsv.js";
export {
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
export { testAnalytics } from "./analytics/analyticsTest";

// Callables the admin dashboard invokes by name rather than through the gateway.
export { analyticsOverview, analyticsGrowth, analyticsPlatforms } from "./analytics";
export { verifyAdminStatus } from "./admin/verifyAdminStatus";
export { getAdminMaintenanceStatus, getMaintenanceHistory } from "./admin/adminMaintenance";
export { getAdminVersionStatus, getVersionHistory } from "./admin/adminVersion";
export { setMaintenanceMode } from "./game-systems/adminMaintenance";
export { setMinimumVersion } from "./game-systems/adminVersion";
export { searchGameUsers, setGameAdminStatus, getGameAdmins } from "./game-systems/adminGameUsers";

export { analyticsInsights } from "./analytics";
export { recordAnalyticsEconomy, recordAnalyticsReceipt, recordAnalyticsGarage, recordAnalyticsSpells, recordAnalyticsIap, recordAnalyticsRace } from "./analytics/ledger.js";
export { onShopRotationProfile, onShopRotationCrateSlots, onShopRotationInventory, onShopRotationPurchase } from "./shop/rotationEvents.js";
// Keep analytics delivery deployable without replacing the gameplay gateway.
export { syncAnalyticsLedger } from "./analytics/relay.js";
