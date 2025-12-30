#!/bin/bash

# Helper script to download the production service account key
# Run this script to automatically generate and download the key

set -e

echo "🔐 Production Service Account Key Download Script"
echo "=================================================="
echo ""

PROJECT_ID="mystic-motors-prod"
SERVICE_ACCOUNT="backend-production@mystic-motors-prod.iam.gserviceaccount.com"
KEY_FILE="backend-production-mystic-motors-prod.json"

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
    echo "You can now run the production seed script:"
    echo "   npm run tools:seed-production"
    echo ""
else
    echo ""
    echo "❌ ERROR: Failed to download service account key"
    exit 1
fi
