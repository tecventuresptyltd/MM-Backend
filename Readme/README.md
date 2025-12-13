# Mystic Motors Backend Functions - Setup Guide

## 📁 Folder Structure

```
Atul-Final-Functions/
├── src/                          # Source code for all Firebase Cloud Functions
│   ├── auth/                    # Authentication functions
│   ├── clan/                    # Clan system (create, join, leave, etc.)
│   ├── core/                    # Core utilities and shared logic
│   ├── crates/                  # Crate opening system
│   ├── economy/                 # Economy (coins, gems, leaderboard)
│   ├── game-systems/            # Game systems (maintenance, etc.)
│   ├── garage/                  # Car purchases, upgrades, cosmetics
│   ├── inventory/               # Player inventory management
│   ├── profile/                 # Player profile management
│   ├── race/                    # Race logic (start, bots, results)
│   ├── referral/                # Referral code system
│   ├── shop/                    # Shop purchases, boosters, offers
│   ├── spells/                  # Spell upgrades, loadouts, decks
│   └── index.ts                 # Main entry point (exports all functions)
│
├── test/                        # Test files
├── lib/                         # Compiled JavaScript output (auto-generated)
├── seeds/                       # Seed data files (catalogs)
│   ├── BoostersCatalog.json
│   ├── CarsCatalog.json
│   ├── CratesCatalog.json
│   ├── ItemsCatalog.json
│   ├── ItemSkusCatalog.json
│   ├── ItemsIndex.json
│   ├── OffersCatalog.json
│   ├── RanksCatalog.json
│   ├── SpellsCatalog.json
│   ├── XpCurve.json            # DEPRECATED - XP now calculated via runtime formula
│   └── gameDataCatalogs.v3.normalized.json
│
├── package.json                 # Node.js dependencies and scripts
├── tsconfig.json               # TypeScript configuration
├── tsconfig.build.json         # TypeScript build configuration
├── eslint.config.js            # ESLint configuration
├── jest.config.cjs             # Jest test configuration
├── firebase.json               # Firebase project configuration
├── .firebaserc                 # Firebase project aliases
├── firestore.rules             # Firestore security rules
├── firestore.indexes.json      # Firestore indexes
├── mystic-motors-sandbox-9b64d57718a2.json  # Service account key
└── README.md                   # This file
```

---

## 🚀 Initial Setup

### Prerequisites
- **Node.js** (v18 or higher) - [Download](https://nodejs.org/)
- **npm** (comes with Node.js)
- **Firebase CLI** - Install globally:
  ```bash
  npm install -g firebase-tools
  ```

### Step 1: Install Dependencies
```bash
cd Atul-Final-Functions
npm install
```

### Step 2: Login to Firebase
```bash
firebase login
```

### Step 3: Select Firebase Project
```bash
firebase use sandbox
```
Or if you need to add the project:
```bash
firebase use --add
```
Then select `mystic-motors-sandbox` from the list.

---

## 🛠️ Development

### Build TypeScript Code
Compile TypeScript to JavaScript:
```bash
npm run build
```

### Run Tests
```bash
npm test
```

### Deploy Functions to Firebase
Deploy all functions:
```bash
firebase deploy --only functions
```

Deploy specific function:
```bash
firebase deploy --only functions:functionName
```
Example:
```bash
firebase deploy --only functions:purchaseShopSku
```

### Deploy Firestore Rules
```bash
firebase deploy --only firestore:rules
```

### Deploy Firestore Indexes
```bash
firebase deploy --only firestore:indexes
```

### Deploy Everything
```bash
firebase deploy
```

---

## 📊 Seed Data to Firestore

The `seeds/` folder contains all catalog data that needs to be in Firestore.

### Seed All Catalogs
There should be a seeding script. If you need to create one:

**Create `seedFirestore.ts`:**
```typescript
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const serviceAccount = require('./mystic-motors-sandbox-9b64d57718a2.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'mystic-motors-sandbox'
});

const db = admin.firestore();

async function seedCatalogs() {
  const seedFile = path.join(__dirname, 'seeds', 'gameDataCatalogs.v3.normalized.json');
  const seedData = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));

  for (const catalog of seedData) {
    console.log(`📦 Seeding ${catalog.path}...`);
    await db.doc(catalog.path).set(catalog.data);
    console.log(`✅ ${catalog.path} seeded successfully`);
  }

  console.log('\n✅ All catalogs seeded successfully!\n');
  process.exit(0);
}

seedCatalogs().catch(console.error);
```

**Run seeding:**
```bash
npx ts-node seedFirestore.ts
```

---

## 📝 Making Changes

### 1. Modify Function Logic
Edit files in `src/` folder:
- Example: Edit `src/shop/purchaseShopSku.ts` to change shop logic

### 2. Build
```bash
npm run build
```

### 3. Test Locally (Optional)
```bash
firebase emulators:start
```

### 4. Deploy
```bash
firebase deploy --only functions:purchaseShopSku
```

---

## 🔧 Common Tasks

### Add a New Cloud Function
1. Create new file in appropriate folder (e.g., `src/shop/newFunction.ts`)
2. Export function with Firebase callable format:
```typescript
import { onCall } from "firebase-functions/v2/https";

export const newFunction = onCall(async (request) => {
  // Your logic here
  return { success: true };
});
```
3. Export from `src/index.ts`:
```typescript
export { newFunction } from "./shop";
```
4. Build and deploy:
```bash
npm run build
firebase deploy --only functions:newFunction
```

### Update Catalog Data
1. Edit the appropriate JSON file in `seeds/` folder
2. Update main file: `seeds/gameDataCatalogs.v3.normalized.json`
3. Seed to Firestore:
```bash
npx ts-node seedFirestore.ts
```

### Update Firestore Rules
1. Edit `firestore.rules`
2. Deploy:
```bash
firebase deploy --only firestore:rules
```

---

## 🔑 Environment & Authentication

### Service Account Key
The file `mystic-motors-sandbox-9b64d57718a2.json` is your service account key.
- **DO NOT commit this to Git**
- Keep it secure
- Used for local development and seeding data

### Firebase Project
- Project ID: `mystic-motors-sandbox`
- Configured in `.firebaserc`

---

## 📦 Package Scripts

### Available Commands:
```json
{
  "build": "tsc",                    // Compile TypeScript
  "serve": "npm run build && firebase emulators:start --only functions",
  "shell": "npm run build && firebase functions:shell",
  "start": "npm run shell",
  "deploy": "firebase deploy --only functions",
  "logs": "firebase functions:log"
}
```

---

## 🧪 Testing

### Run All Tests
```bash
npm test
```

### Run Specific Test File
```bash
npm test -- path/to/test.spec.ts
```

---

## 🐛 Troubleshooting

### Build Errors
```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

### Deployment Errors
```bash
# Check Firebase login
firebase login

# Verify project
firebase use

# Check function logs
firebase functions:log
```

### TypeScript Errors
```bash
# Rebuild
npm run build
```

---

## 📚 Important Files

### Configuration Files
- `firebase.json` - Firebase project config (functions, hosting, etc.)
- `.firebaserc` - Firebase project aliases
- `tsconfig.json` - TypeScript compiler options
- `package.json` - Node.js dependencies and scripts

### Source Code
- `src/index.ts` - Main entry point (all functions exported here)
- `src/*/` - Feature-specific folders

### Data Files
- `seeds/gameDataCatalogs.v3.normalized.json` - Complete catalog data
- `seeds/*Catalog.json` - Individual catalog files for reference

---

## 🎯 Quick Start Checklist

- [ ] Install Node.js (v18+)
- [ ] Install Firebase CLI: `npm install -g firebase-tools`
- [ ] Navigate to folder: `cd Atul-Final-Functions`
- [ ] Install dependencies: `npm install`
- [ ] Login to Firebase: `firebase login`
- [ ] Select project: `firebase use sandbox`
- [ ] Build functions: `npm run build`
- [ ] Deploy: `firebase deploy --only functions`
- [ ] Seed data: `npx ts-node seedFirestore.ts`

---

## 📞 Support

For issues or questions:
1. Check Firebase logs: `firebase functions:log`
2. Review Firestore rules: `firestore.rules`
3. Verify data in Firebase Console: https://console.firebase.google.com

---

## ⚠️ Important Notes

1. **Never commit service account keys to Git**
2. **Always test locally before deploying to production**
3. **Keep seed data files in sync with Firestore**
4. **Update Firestore indexes when adding new queries**
5. **Document any new functions you create**

---

## 🔄 Deployment Workflow

```
Edit Code → Build → Test Locally → Deploy → Verify
    ↓         ↓          ↓            ↓         ↓
  src/    npm run   firebase    firebase   Check
          build     emulators    deploy     logs
```

---

## ✅ You're All Set!

Your backend is now ready for development and deployment. Happy coding! 🚀
