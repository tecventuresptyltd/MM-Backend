# 🔐 Service Account Keys Policy

## Production (mystic-motors-prod)

**Access:** Owner only (`tecventurescorp@gmail.com`)

**Files:**
- `backend-production-mystic-motors-prod.json` - **Owner's machine ONLY**

**What you CANNOT have:**
- ❌ Production service account keys
- ❌ Ability to deploy to production
- ❌ Ability to seed production

**What you CAN do:**
- ✅ View logs and monitor production
- ✅ Debug production issues
- ✅ Access Firebase console (read-only)

---

## Sandbox (mystic-motors-sandbox)

**Access:** All developers

**Files:**
- `mystic-motors-sandbox-9b64d57718a2.json` - Can be shared with team

**You have full access:**
- ✅ Deploy functions: `npm run deploy:sandbox`
- ✅ Seed database: `npm run tools:seed-sandbox`
- ✅ Modify data freely
- ✅ Test and experiment

---

## Why This Policy?

Production requires tighter controls:
- Affects live users
- Requires careful change management
- Owner approval for all production changes

Sandbox is your playground:
- Break things freely
- Test thoroughly
- Deploy as often as needed

---

## Need Production Changes?

Contact the owner:
- Production deployments
- Production database seeding
- Production configuration changes

Response time: Usually same day ✅
