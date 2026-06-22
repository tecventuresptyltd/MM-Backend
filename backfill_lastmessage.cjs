const admin = require("firebase-admin");
const sa = require("./mystic-motors-sandbox-9b64d57718a2.json");
admin.initializeApp({
  credential: admin.credential.cert(sa),
  databaseURL: "https://mystic-motors-sandbox-default-rtdb.firebaseio.com",
});

(async () => {
  const db = admin.firestore();
  const rtdb = admin.database();
  const rooms = await db.collection("Rooms").get();
  console.log("Scanning", rooms.size, "rooms for latest RTDB message...\n");

  let updated = 0;
  for (const doc of rooms.docs) {
    const roomId = doc.id;
    const snap = await rtdb
      .ref(`chat_messages/global/${roomId}`)
      .orderByChild("ts")
      .limitToLast(1)
      .once("value");

    let latestTs = 0;
    snap.forEach((child) => {
      const ts = Number(child.val()?.ts ?? 0);
      if (ts > latestTs) latestTs = ts;
    });

    if (latestTs > 0) {
      await doc.ref.update({ lastMessageAt: admin.firestore.Timestamp.fromMillis(latestTs) });
      updated++;
      console.log(`  SET ${roomId} -> lastMessageAt = ${new Date(latestTs).toISOString()}`);
    } else {
      console.log(`  skip ${roomId} (no messages in RTDB)`);
    }
  }

  console.log(`\nDone. Backfilled lastMessageAt on ${updated} room(s).`);
  process.exit(0);
})();
