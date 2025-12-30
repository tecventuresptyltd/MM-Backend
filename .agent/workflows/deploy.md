---
description: Deploy Cloud Functions to Firebase
---

# Deployment Workflow for AI Assistants

> **CRITICAL**: This workflow MUST be followed when deploying Cloud Functions. Never skip the environment verification steps.

## 🚨 MANDATORY ENVIRONMENT VERIFICATION

**Before proposing ANY deployment command, you MUST:**

1. **Ask the user which environment** they want to deploy to:
   - SANDBOX (mystic-motors-sandbox) - for development/testing
   - PRODUCTION (mystic-motors-prod) - for live users

2. **Confirm explicitly** with the user before proceeding

3. **Use ONLY the safe deployment scripts** - never use raw `firebase deploy` commands

## 📋 Deployment Commands

### Deploy to Sandbox (Development)

```bash
npm run deploy:sandbox
```

**What this does:**
- Verifies target is `mystic-motors-sandbox`
- Asks for user confirmation
- Runs `npm run build`
- Deploys to sandbox
- Safe for testing and development

### Deploy to Production (Live Users)

```bash
npm run deploy:production
```

**What this does:**
- Verifies user is `tecventurescorp@gmail.com` (owner only)
- Verifies target is `mystic-motors-prod`
- Requires typing "PRODUCTION" to confirm
- Has 3-second safety delay
- Runs `npm run build`
- Deploys to production

> **WARNING**: Only the owner (tecventurescorp@gmail.com) can deploy to production!

## ❌ NEVER Do These

**DO NOT** propose these commands:
```bash
# ❌ WRONG - No environment verification
firebase deploy --only functions

# ❌ WRONG - Could deploy to wrong environment
gcloud config set project mystic-motors-prod && firebase deploy

# ❌ WRONG - Manual deployment without safeguards
firebase deploy --only functions --project mystic-motors-prod
```

## ✅ Correct AI Assistant Behavior

When a user requests a deployment:

1. **Ask**: "Which environment do you want to deploy to: SANDBOX or PRODUCTION?"

2. **Wait** for user response

3. **Confirm**: "Just to confirm, you want to deploy to [ENVIRONMENT]. Is that correct?"

4. **Propose** the appropriate safe command:
   - For sandbox: `npm run deploy:sandbox`
   - For production: `npm run deploy:production`

## 📝 Example AI Assistant Response

**User**: "Deploy the new prepareRace function"

**AI Response**:
```
Which environment would you like to deploy to?
- SANDBOX (mystic-motors-sandbox) - for testing
- PRODUCTION (mystic-motors-prod) - for live users
```

**User**: "Sandbox"

**AI Response**:
```
I'll deploy to SANDBOX (mystic-motors-sandbox). 
This will run the safe deployment script that:
- Verifies the target environment
- Builds the project
- Deploys to sandbox

Running: npm run deploy:sandbox
```

## 🔍 Pre-Deployment Checklist

Before deploying, ensure:
- [ ] Code builds successfully: `npm run build`
- [ ] Tests pass: `npm test`
- [ ] Changes tested in sandbox (if deploying to production)
- [ ] User confirms target environment
- [ ] Using safe deployment scripts

## 🚀 Post-Deployment

After successful deployment:
1. Verify functions deployed: Check Firebase Console
2. Monitor logs: `firebase functions:log`
3. Test the deployed functions

## 📊 Environment Comparison

| Aspect | Sandbox | Production |
|--------|---------|------------|
| **Who can deploy** | Atul + Owner | Owner only |
| **Confirmations** | 1 (yes/no) | 2 (yes/no + type "PRODUCTION") |
| **User verification** | None | Must be tecventurescorp@gmail.com |
| **Safety delay** | None | 3 seconds |
| **Risk level** | Low | High |
| **Project ID** | mystic-motors-sandbox | mystic-motors-prod |

## 🛡️ Safety Features

The deployment scripts include:
- ✅ Automatic project verification
- ✅ Current user verification (production only)
- ✅ Explicit confirmation prompts
- ✅ Pre-deployment build verification
- ✅ Safety delays (production only)
- ✅ Clear visual indicators of target environment

## 📞 Who to Contact

- **Production deployments**: Only tecventurescorp@gmail.com
- **Sandbox deployments**: Atul or Owner
- **Questions**: Ask the repository owner
