import * as admin from "firebase-admin";
admin.initializeApp({ projectId: "mystic-motors-sandbox" });
import { getFunctions } from "firebase-admin/functions";
const q = getFunctions().taskQueue("completeUpgradeTask");
console.log("Queue initialized", Object.keys(q));
