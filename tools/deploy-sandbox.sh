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

echo "🎯 Target Environment: SANDBOX"
echo "📋 Target Project: $PROJECT_ID"
echo "🔖 Using Firebase Alias: $PROJECT_ALIAS"
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

DEPLOY_TARGET="functions"
if [ -n "$1" ]; then
    DEPLOY_TARGET="$1"
fi

echo "🚀 Deploying to SANDBOX (Target: $DEPLOY_TARGET)..."
firebase deploy --only $DEPLOY_TARGET --project $PROJECT_ALIAS

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ SANDBOX deployment successful!"
    echo "🌐 Environment: $PROJECT_ID"
else
    echo ""
    echo "❌ Deployment failed!"
    exit 1
fi

