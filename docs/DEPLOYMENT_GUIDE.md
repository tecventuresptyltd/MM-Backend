# Mystic Motors Backend Deployment Guide

This repository contains every Firebase backend for Mystic Motors (Cloud Functions v2, Firestore/RTDB rules, catalog seeds, and scheduled jobs). Use this guide when cloning the stack into a brand-new Firebase project or when re-deploying to an additional environment.

---

## 1. Prerequisites

- **Node.js 20** (matches `package.json` engines) and npm ≥ 9.
- **Firebase CLI** (`npm i -g firebase-tools`) and the **gcloud CLI** (needed for IAM bindings).
- **Billing-enabled Firebase project** (required for Cloud Functions v2 + scheduler + RTDB).
- Local auth to Firebase/GCP with sufficient privileges (project **Owner** or IAM Admin). Editor/Cloud Run Admin is not enough to set up Eventarc bindings.

---

## 2. Create / Prepare the Firebase Project

1. **Create the project** in the Firebase console. Choose the same region the game uses today (`us-central1`).
2. **Enable products**:
   - Firestore in Native mode.
   - Realtime Database (dual-region not required; note the instance name).
   - Cloud Storage (needed by functions even if unused directly).
3. **Enable GCP APIs** (Owner can enable once via console or `gcloud`):
   - `cloudscheduler.googleapis.com`
   - `run.googleapis.com`
   - `eventarc.googleapis.com`
   - `pubsub.googleapis.com`
   - `storage.googleapis.com`
   - `iamcredentials.googleapis.com`
4. **Grant IAM bindings** (only once per project). These are required so Cloud Scheduler/Eventarc may call the deployed functions:

   ```bash
   gcloud projects add-iam-policy-binding <PROJECT_ID> \
     --member="serviceAccount:service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com" \
     --role="roles/iam.serviceAccountTokenCreator"

   gcloud projects add-iam-policy-binding <PROJECT_ID> \
     --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" \
     --role="roles/run.invoker"

   gcloud projects add-iam-policy-binding <PROJECT_ID> \
     --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" \
     --role="roles/eventarc.eventReceiver"
   ```

   Replace `<PROJECT_ID>` / `<PROJECT_NUMBER>` with values from the Firebase console (Projects → settings). These commands must be executed by a project Owner or IAM Admin. Skipping them results in the deployment error you saw earlier.

---

## 3. Local Repository Setup

```bash
git clone <repo-url>
cd Atul-Final-Functions/functions
npm install
npm run build   # optional check before deploy
```

Configure the Firebase CLI to point at your target project:

```bash
firebase login
firebase use --add     # choose the new project ID
```

Update `.firebaserc` if you want the new project to be the default.

### Realtime Database Instance Mapping

`firebase.json` currently references `mystic-motors-sandbox-default-rtdb`. Update the `"database"` block to point at the new instance name (found in Firebase console → Realtime Database → Instance details). Example:

```json
"database": [
  {
    "instance": "mystic-motors-prod-default-rtdb",
    "rules": "database.rules.json"
  }
]
```

---

## 4. Deploying Rules & Indexes

From `functions/` run:

```bash
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
firebase deploy --only database
```

Files deployed:
- `firestore.rules`
- `firestore.indexes.json`
- `database.rules.json` (RTDB security; enforces presence-gated chat access)

---

## 5. Deploying Cloud Functions

Run:

```bash
firebase deploy --only functions
```

This deploys every callable/HTTP/RTDB trigger, plus the scheduled jobs listed below (Firebase automatically creates Cloud Scheduler/Eventarc entries when the function is deployed). The build takes a few minutes because the codebase compiles TypeScript (`npm run build`) during the predeploy hooks configured in `firebase.json`.

### Scheduled Jobs / Triggers (verify after deploy)

| Function | Location | Trigger | Purpose |
| --- | --- | --- | --- |
| `recommendedClansPoolJob` | `us-central1` | Cloud Scheduler (`every 60 minutes`) | Builds `/System/RecommendedClans` pool used by the Join UI. |
| `clanLeaderboardJob.refresh` | `us-central1` | Cloud Scheduler (`every 5 minutes`) | Writes top-100 clan leaderboard to `/ClanLeaderboard/snapshot`. |
| `leaderboards.refreshAll` | `us-central1` | Cloud Scheduler (`every 5 minutes`) | Recomputes player leaderboards (XP, trophies, etc.). |
| `cleanupChatHistory` | `us-central1` | Cloud Scheduler (`every 24 hours`) | Prunes RTDB chat history (30d for clans, 24h for global). |
| `presence.mirrorLastSeen` | `us-central1` | Cloud Scheduler (`every 10 minutes`) | Mirrors `/presence/lastSeen` into Firestore for “last online” badges. |
| `onPresenceOffline` | `us-central1` | RTDB `onDelete` trigger | Decrements `Rooms/{roomId}.connectedCount` whenever a client disconnects. |

After deployment, open **Cloud Scheduler** and **Eventarc** in Google Cloud console to confirm each entry is active. If any job fails to create, re-run the IAM commands in section 2 and redeploy functions.

---

## 6. Hosting configuration (optional)

`firebase.json` contains rewrites that expose selected callable functions via HTTPS under Firebase Hosting (e.g., `/ping`, `/createClan`). If you plan to serve a site from this project, run `firebase deploy --only hosting`. Otherwise you can ignore the hosting section; the rewrites are still useful for QA tooling even without static assets.

---

## 7. GameData / Seed Scripts (optional but recommended)

The repo ships TypeScript seed scripts under `functions/seeds` to populate catalogs and test players. Example usage:

```bash
npm run seed:gamedata       # writes /GameData/v1 catalogs
npm run seed:testplayer     # creates a sample player account
```

These scripts assume you are authenticated against the target project (same as deployments). Run them after the first rules deployment if you need starter data.

---

## 8. Production Checklist

- [ ] Firebase project created, billing enabled, Firestore/RTDB initialized in `us-central1`.
- [ ] Required APIs enabled + IAM bindings applied via `gcloud` commands.
- [ ] `firebase.json` → `"database[].instance"` updated to new RTDB instance.
- [ ] `firebase use --add` pointing to the project.
- [ ] Rules / indexes deployed.
- [ ] Functions deployed successfully (`firebase deploy --only functions`), no IAM errors.
- [ ] Cloud Scheduler jobs visible for: recommended pool, clan leaderboard, player leaderboard, chat cleanup, presence mirror.
- [ ] Eventarc trigger (`onPresenceOffline`) active.
- [ ] Optional seeds executed (catalogs, sample players).
- [ ] Unity client configured with the new Firebase project credentials (Web API key, app ID, etc.).

Once everything above is checked, the Mystic Motors backend (clans, chats, leaderboards, invites, etc.) is ready in the new Firebase project.
