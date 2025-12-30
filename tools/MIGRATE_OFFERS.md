# Offer Flow Migration Guide

## What This Does

Initializes the new offer flow system for all existing players by:
- Creating `Players/{uid}/Offers/Active` document with a daily offer
- Creating `Players/{uid}/Offers/State` document for backend tracking
- Skipping players who already have offers

## Run Migration

### Sandbox
```bash
GOOGLE_APPLICATION_CREDENTIALS=./mystic-motors-sandbox-firebase-adminsdk.json \
node lib/tools/migrateOfferFlow.js
```

### Production
```bash
GOOGLE_APPLICATION_CREDENTIALS=./mystic-motors-prod-c0cee3ade8a4.json \
node lib/tools/migrateOfferFlow.js
```

## What Players Get

Each existing player will receive:
- **One random daily offer** (Tier 0) valid for 24 hours
- **No starter offer** (existing players skip this)
- **Clean offer flow state** ready for purchases and tier progression

## After Migration

Players will:
- See their daily offer in `Players/{uid}/Offers/Active`
- Unity client will pick it up via Firestore listener
- Offer expires in 24h → 12h cooldown → new offer appears
- IAP purchases will advance ladder tiers normally

## Verification

Check a few player documents in Firestore Console:
```
Players/{uid}/Offers/Active
```

Should look like:
```json
{
  "main": {
    "offerId": "offer_xyz",
    "offerType": 1,
    "expiresAt": 1735700000000,
    "tier": 0,
    "state": "active"
  },
  "special": [],
  "updatedAt": 1735600000000
}
```
