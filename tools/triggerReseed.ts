import * as admin from 'firebase-admin';
const serviceAccount = require('../mystic-motors-sandbox-9b64d57718a2.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'mystic-motors-sandbox'
});

async function forceWipeAndSweep() {
    console.log("🚀 Forced wipe & reseed started...");
    
    const db = admin.firestore();
    const playersSnap = await db.collection("Players").select().get();
    
    // WIPE PHASE
    console.log(`Wiping legacy schema for ${playersSnap.docs.length} players...`);
    const batch = db.batch();
    let wipes = 0;
    
    for (const doc of playersSnap.docs) {
        const activeRef = db.doc(`Players/${doc.id}/Offers/Active`);
        batch.set(activeRef, {
            rotating: [], // forcibly wipe out current buckets to re-load from catalog
            special: [],
            main: admin.firestore.FieldValue.delete(),
            starter: admin.firestore.FieldValue.delete(),
            daily: admin.firestore.FieldValue.delete()
        }, { merge: true });
        wipes++;
    }
    await batch.commit();
    console.log(`Wiped ${wipes} player profiles.`);
    
    // POPULATION PHASE
    const { runOfferSafetyCheck } = await import('../src/shop/offerSafetyNet.js');
    console.log("Triggering global safety net sweep to repopulate buckets...");
    const stats = await runOfferSafetyCheck();
    console.log("✅ Sweep complete!", stats);
    process.exit(0);
}
forceWipeAndSweep().catch(console.error);
