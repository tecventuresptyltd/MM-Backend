import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { MIN_SOCIAL_AGE } from "../shared/ageGate.js";
import { db } from "../shared/firestore.js";
import { REGION } from "../shared/region.js";

const BATCH_LIMIT = 400;

export const ageUnlockJob = onSchedule(
  {
    region: REGION,
    schedule: "every day 00:15",
    timeZone: "Etc/UTC",
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async () => {
    const latestEligibleBirthYear = new Date().getUTCFullYear() - MIN_SOCIAL_AGE;
    let unlocked = 0;

    for (;;) {
      const due = await db
        .collection("Players")
        .where("isOver13", "==", false)
        .where("birthYear", ">", 0)
        .where("birthYear", "<=", latestEligibleBirthYear)
        .limit(BATCH_LIMIT)
        .get();

      if (due.empty) {
        break;
      }

      const batch = db.batch();
      due.docs.forEach((doc) => batch.update(doc.ref, { isOver13: true }));
      await batch.commit();
      unlocked += due.size;

      if (due.size < BATCH_LIMIT) {
        break;
      }
    }

    logger.info("[ageUnlock] run complete", { unlocked, latestEligibleBirthYear });
  },
);
