import * as admin from "firebase-admin";
import { onCall } from "firebase-functions/v2/https";
import "./shared/region";

// Initialize Firebase Admin SDK
admin.initializeApp();

// Simple ping function for health checks
export const ping = onCall({ region: "us-central1" }, async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

export * from "./auth";
// Export functions from other modules
export { exchangeGemsForCoins, claimRankUpReward, getLeaderboard } from "./economy";
export { adjustCoins } from "./economy/coins";
export { adjustGems } from "./economy/gems";
export { grantXP } from "./economy/xp";
export { purchaseShopSku, activateBooster, purchaseOffer } from "./shop";
export { purchaseCar, upgradeCar, equipCosmetic, purchaseCrateItem, grantItem } from "./garage";
export { openCrate } from "./crates";
export { upgradeSpell, setLoadout, equipCosmetics, setSpellDeck, selectActiveSpellDeck } from "./spells";
export { startRace, generateBotLoadout, recordRaceResult } from "./race";
export { prepareRace } from "./race/prepareRace";
export {
  createClan,
  joinClan,
  leaveClan,
  inviteToClan,
  requestToJoinClan,
  acceptJoinRequest,
  declineJoinRequest,
  promoteClanMember,
  demoteClanMember,
  kickClanMember,
  updateClanSettings,
} from "./clan";
export { updateMemberTrophies } from "./clan/members";
export { getMaintenanceStatus, claimMaintenanceReward } from "./game-systems/maintenance";
export { healthcheck } from "./health/healthcheck";
export * from "./profile";
export {
  referralGetMyReferralCode,
  referralClaimReferralCode,
  referralDebugLookup,
} from "./referral";
export {
  getGlobalLeaderboard,
  searchPlayer,
  searchPlayers,
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  cancelFriendRequest,
  viewPlayerProfile,
  leaderboardsRefreshAll as socialLeaderboardsRefreshAll,
  presenceMirrorLastSeen as socialPresenceMirrorLastSeen,
} from "./Socials";
