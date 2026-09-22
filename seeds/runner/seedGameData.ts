import * as admin from "firebase-admin";
import { assertBotNamesAreValidUsernames } from "./validateBotNames.js";
import { loadGameDataDocuments } from "./loadGameData.js";

const BOT_NAMES_PATH = "/GameData/v1/config/BotNames";
const CHUNK_SIZE = 400;

export async function seedGameDataCatalogs(): Promise<void> {
  const db = admin.firestore();
  const documents = loadGameDataDocuments();

  const botNames = documents.find((entry) => entry.path === BOT_NAMES_PATH);
  if (botNames) {
    assertBotNamesAreValidUsernames(
      (botNames.data as { names?: unknown }).names,
    );
  }

  for (let i = 0; i < documents.length; i += CHUNK_SIZE) {
    const batch = db.batch();
    for (const entry of documents.slice(i, i + CHUNK_SIZE)) {
      batch.set(db.doc(entry.path), entry.data);
    }
    await batch.commit();
  }
}
