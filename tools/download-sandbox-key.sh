#!/bin/bash

# Helper script to download the sandbox service account key
# Run this script to automatically generate and download the key

set -e

echo "🔐 Sandbox Service Account Key Download Script"
echo "=================================================="
echo ""

PROJECT_ID="mystic-motors-sandbox"
SERVICE_ACCOUNT="firebase-adminsdk-fbsvc@mystic-motors-sandbox.iam.gserviceaccount.com"
KEY_FILE="mystic-motors-sandbox-9b64d57718a2.json"

echo "📋 Project: $PROJECT_ID"
echo "🔑 Service Account: $SERVICE_ACCOUNT"
echo "💾 Key File: $KEY_FILE"
echo ""

# Check if already downloaded
if [ -f "$KEY_FILE" ]; then
    echo "⚠️  WARNING: Key file already exists: $KEY_FILE"
    read -p "Do you want to create a new key? This will replace the existing file (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ Aborted."
        exit 1
    fi
    rm "$KEY_FILE"
fi

# Set project
echo "🔧 Setting active project..."
gcloud config set project $PROJECT_ID

# Create and download key
echo "🔑 Creating new service account key..."
gcloud iam service-accounts keys create "$KEY_FILE" \
    --iam-account="$SERVICE_ACCOUNT"

if [ -f "$KEY_FILE" ]; then
    echo ""
    echo "✅ SUCCESS! Service account key downloaded:"
    echo "   📁 $(pwd)/$KEY_FILE"
    echo ""
    echo "You can now run the sandbox seed script:"
    echo "   npm run tools:seed-sandbox"
    echo ""
else
    echo ""
    echo "❌ ERROR: Failed to download service account key"
    exit 1
fi
