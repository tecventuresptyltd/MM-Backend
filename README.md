# Mystic Motors - Firebase Functions Backend

This repository contains the Firebase Functions backend for the Mystic Motors mobile game.

## 🚀 Overview

This backend provides serverless functions for:
- User authentication and profile management
- Economy system (coins, gems, XP)
- Car garage and cosmetics management
- Racing system and leaderboards
- Clan management and social features
- Spell system and loadouts
- Shop and crate management
- Referral system
- Game maintenance features

## 🛠 Tech Stack

- **Runtime**: Node.js 20
- **Framework**: Firebase Functions (2nd Generation)
- **Language**: TypeScript
- **Database**: Cloud Firestore
- **Authentication**: Firebase Auth
- **Hosting**: Firebase Hosting

## 📁 Project Structure

```
├── src/                    # TypeScript source code
│   ├── auth/              # Authentication functions
│   ├── clan/              # Clan management
│   ├── economy/           # Economy system (coins, gems, XP)
│   ├── garage/            # Car and cosmetics management
│   ├── race/              # Racing system
│   ├── shop/              # Shop and purchases
│   ├── spells/            # Spell system
│   └── shared/            # Shared utilities
├── lib/                   # Compiled JavaScript (auto-generated)
├── test/                  # Test files
├── seeds/                 # Database seeding scripts
├── tools/                 # Development tools
├── firebase.json          # Firebase configuration
├── firestore.rules        # Firestore security rules
└── package.json           # Dependencies and scripts
```

## 🚀 Getting Started

### Prerequisites

- Node.js 20+
- Firebase CLI
- Access to the Firebase project

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/AtulTeamMystic/MM-Backend.git
   cd MM-Backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

### Development

- **Build**: `npm run build`
- **Test**: `npm test`
- **Deploy**: `firebase deploy --only functions`

### Firebase Projects

- **Sandbox**: `mystic-motors-sandbox` (development/testing)
- **Production**: `mystic-motors-prod` (live game)

## 📚 API Functions

### Authentication
- `ensureGuestSession` - Create guest user sessions
- `bindEmailPassword` - Bind email/password to account
- `bindGoogle` - Bind Google account
- `signupEmailPassword` - Email/password signup
- `signupGoogle` - Google signup
- `checkSession` - Read-only presence check for concurrent logins
- `checkEmailExists` - Check if email is registered

### Economy
- `adjustCoins` - Modify player coins
- `adjustGems` - Modify player gems
- `grantXP` - Award experience points
- `exchangeGemsForCoins` - Convert gems to coins
- `claimRankUpReward` - Claim ranking rewards

### Garage & Items
- `purchaseCar` - Buy new cars
- `upgradeCar` - Upgrade existing cars
- `equipCosmetic` - Equip cosmetic items
- `grantItem` - Grant items to players

### Racing
- `startRace` - Initialize race session
- `recordRaceResult` - Process race completion
- `prepareRace` - Prepare race setup
- `generateBotLoadout` - Create AI opponents

### Clans
- `createClan` - Create new clan
- `joinClan` - Join existing clan
- `leaveClan` - Leave current clan
- `updateMemberTrophies` - Update clan member stats

### Shop & Crates
- `purchaseShopSku` - Buy shop items
- `openCrate` - Open loot crates
- `activateBooster` - Activate boosters

## 🔐 Security

- All functions require proper authentication
- Firestore rules enforce server-side validation
- Input validation on all endpoints
- Idempotency support for critical operations

## 🧹 Content Moderation

- Chat messages, friend/clan requests, and clan names/descriptions are run through the profanity masker in `src/shared/profanity.ts`, which replaces Hindi and English bad words with asterisks while preserving message length.
- Usernames are rejected if they contain profane terms.
- The word list is centralized in `src/shared/profanityList.json` (sourced from chucknorris-io/swear-words across all languages) and normalizes common leetspeak/punctuation; extend it there to tighten or loosen coverage.

## 🚀 Deployment

The project is configured for automatic deployment to Firebase Functions:

```bash
firebase use sandbox  # or prod
firebase deploy --only functions
```

## 📊 Monitoring

- Functions are monitored via Firebase Functions dashboard
- Error logging through Firebase Functions logger
- Performance metrics available in Google Cloud Console

## 🤝 Contributing

1. Create feature branch from `main`
2. Make changes and test thoroughly
3. Ensure all tests pass
4. Submit pull request for review

## 📄 License

This project is proprietary software for Mystic Motors game.
