import * as admin from 'firebase-admin';
const serviceAccount = require('../mystic-motors-sandbox-9b64d57718a2.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'mystic-motors-sandbox'
});

async function main() {
    console.log("🚀 Triggering global safety net sweep to instantly initialize all players...");
    try {
        const { runOfferSafetyCheck } = await import('../src/shop/offerSafetyNet.js');
        const stats = await runOfferSafetyCheck();
        console.log("✅ Sweep complete!", stats);
    } catch(e) {
        console.error("❌ Error:", e);
    }
    process.exit(0);
}
main();
