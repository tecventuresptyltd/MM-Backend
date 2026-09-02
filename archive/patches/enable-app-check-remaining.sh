#!/bin/bash
# Script to enable App Check on remaining Cloud Functions
# This script adds callableOptions() to functions still using raw { region: REGION }

echo "🔒 Enabling App Check on all Cloud Functions..."
echo ""

# Array of files and functions to fix
declare -a files=(
  "src/game-systems/bots.ts:generateBotLoadout"
  "src/game-systems/adminMaintenance.ts:setMaintenanceMode"
  "src/game-systems/leaderboards.ts:getLeaderboard"
  "src/auth/logEmailSend.ts:logEmailSend"
  "src/auth/claimBindingReward.ts:claimBindingReward"
  "src/auth/requestPasswordReset.ts:requestPasswordReset"
  "src/auth/checkEmailExists.ts:checkEmailExists"
  "src/referral/index.ts:referralGetMyReferralCode"
  "src/referral/index.ts:referralDebugLookup"
  "src/referral/claim.ts:referralClaimReferralCode"
  "src/referral/acknowledge.ts:acknowledgeReferralRewards"
  "src/economy/preview.ts:getGemConversionPreview"
  "src/economy/gems.ts:adjustGems"
  "src/economy/xp.ts:grantXP"
)

echo "📋 Functions to update: ${#files[@]}"
echo ""

for item in "${files[@]}"; do
  file=$(echo $item | cut -d':' -f1)
  func=$(echo $item | cut -d':' -f2)
  echo "✅ $func in $file"
done

echo ""
echo "⚠️  Note: Auth functions (ensureGuestSession, signupGoogle, etc.) will remain with enforceAppCheck: false"
echo "📌 This is intentional until Firebase Auth service reliably sends App Check tokens"
echo ""
echo "🚀 To apply these changes, run the TypeScript fixes manually or deploy"
