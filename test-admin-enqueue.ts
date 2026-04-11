import * as admin from "firebase-admin";
admin.initializeApp({ projectId: "mystic-motors-sandbox" });
import { getFunctions } from "firebase-admin/functions";

const q = getFunctions().taskQueue("ext-mystic-motors-sandbox-locations-us-central1-functions-completeUpgradeTask");
// Wait, the name is just "completeUpgradeTask" according to Firebase docs.
console.log(q);
