#!/bin/bash

# Safe deployment script for PRODUCTION environment
# This script ensures we're deploying to the correct environment with multiple confirmations

set -e

echo "╔════════════════════════════════════════════════════════════╗"
echo "║             ⚠️  PRODUCTION DEPLOYMENT ⚠️                    ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

PROJECT_ALIAS="prod"
PROJECT_ID="mystic-motors-prod"
CURRENT_USER=$(gcloud config get-value account 2>/dev/null)

echo "🚨 Target Environment: PRODUCTION"
echo "📋 Target Project: $PROJECT_ID"
echo "🔖 Using Firebase Alias: $PROJECT_ALIAS"
echo "👤 Current User: $CURRENT_USER"
echo ""

# Verify user is the owner
if [ "$CURRENT_USER" != "tecventurescorp@gmail.com" ]; then
    echo "❌ ERROR: Only tecventurescorp@gmail.com can deploy to production!"
    echo "   Current user: $CURRENT_USER"
    exit 1
fi

# First confirmation
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "⚠️  You are about to deploy to PRODUCTION!"
echo "⚠️  This will affect live users."
echo ""
read -p "Are you sure you want to deploy to PRODUCTION? (yes/no): " -r
echo ""

if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "❌ Deployment cancelled."
    exit 1
fi

# Second confirmation (type the word)
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "⚠️  FINAL CONFIRMATION REQUIRED"
read -p "Type 'PRODUCTION' to confirm: " -r
echo ""

if [ "$REPLY" != "PRODUCTION" ]; then
    echo "❌ Confirmation failed. Deployment cancelled."
    exit 1
fi

# Build
echo "🔨 Building project..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build failed! Aborting deployment."
    exit 1
fi

# Final 3-second delay
echo ""
echo "⏳ Deploying to PRODUCTION in 3 seconds..."
echo "   Press Ctrl+C to cancel..."
sleep 3

# Deploy using Firebase alias
echo ""
echo "🚀 Deploying to PRODUCTION..."
firebase deploy --only functions --project $PROJECT_ALIAS

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ PRODUCTION deployment successful!"
    echo "🌐 Environment: $PROJECT_ID"
    echo "📊 Monitor: https://console.firebase.google.com/project/$PROJECT_ID/functions"
else
    echo ""
    echo "❌ Deployment failed!"
    exit 1
fi

