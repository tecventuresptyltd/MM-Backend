#!/bin/bash

# Safe deployment script for SANDBOX environment
# This script ensures we're deploying to the correct environment

set -e

echo "╔════════════════════════════════════════════════════════════╗"
echo "║                 SANDBOX DEPLOYMENT                         ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

PROJECT_ALIAS="sandbox"
PROJECT_ID="mystic-motors-sandbox"

# This allowlist deliberately excludes gameApi and every gameplay job. Updating
# the gateway would also publish pending purchase-contract changes.
DEPLOY_TARGET="${1:-functions}"
if [ "$DEPLOY_TARGET" = "--analytics-only" ] || [ "$DEPLOY_TARGET" = "--analytics-client" ]; then
    DEPLOY_TARGET="functions:analyticsOverview,functions:analyticsGrowth,functions:analyticsPlatforms,functions:analyticsRevenue,functions:analyticsRevenueByProduct,functions:analyticsRevenueByCountry,functions:analyticsRetention,functions:analyticsEvents,functions:analyticsRealtime,functions:analyticsGeography,functions:analyticsDevices,functions:analyticsSessions,functions:analyticsInsights,functions:recordAnalyticsEconomy,functions:recordAnalyticsReceipt,functions:recordAnalyticsGarage,functions:recordAnalyticsSpells,functions:recordAnalyticsIap,functions:recordAnalyticsRace,functions:syncAnalyticsLedger"
fi

echo "🎯 Target Environment: SANDBOX"
echo "📋 Target Project: $PROJECT_ID"
echo "🔖 Using Firebase Alias: $PROJECT_ALIAS"
echo "📦 Deployment Target: $DEPLOY_TARGET"
echo ""

# Confirm deployment
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
read -p "Deploy to SANDBOX? (yes/no): " -r
echo ""

if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "❌ Deployment cancelled."
    exit 1
fi

# Build
echo "🔨 Building project..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build failed! Aborting deployment."
    exit 1
fi

echo "🚀 Deploying to SANDBOX (Target: $DEPLOY_TARGET)..."
firebase deploy --only "$DEPLOY_TARGET" --project "$PROJECT_ALIAS"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ SANDBOX deployment successful!"
    echo "🌐 Environment: $PROJECT_ID"
else
    echo ""
    echo "❌ Deployment failed!"
    exit 1
fi

