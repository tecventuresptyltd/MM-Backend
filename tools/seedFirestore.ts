import * as admin from "firebase-admin";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { assertBotNamesAreValidUsernames } from "../seeds/runner/validateBotNames";
import { loadGameDataDocuments } from "../seeds/runner/loadGameData";

type Environment = "sandbox" | "prod";

const PROJECTS: Record<Environment, string> = {
  sandbox: "mystic-motors-sandbox",
  prod: "mystic-motors-prod",
};

const SERVICE_ACCOUNTS: Record<Environment, string> = {
  sandbox: "mystic-motors-sandbox-9b64d57718a2.json",
  prod: "mystic-motors-prod-83284e8c0f34.json",
};

const BOT_NAMES_PATH = "/GameData/v1/config/BotNames";
const DEFAULT_DEPLOY_PASSWORD = "MysticDeploy2026";
const CHUNK_SIZE = 400;

const readEnvironment = (): Environment => {
  const raw = (process.argv[2] ?? "").trim().toLowerCase();
  if (raw === "sandbox" || raw === "prod") {
    return raw;
  }
  console.error("Usage: tsx tools/seedFirestore.ts <sandbox|prod> [--dry-run] [--only <path,path,...>]");
  process.exit(1);
};

const ask = async (question: string): Promise<string> => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) =>
    rl.question(question, resolve),
  );
  rl.close();
  return answer.trim();
};

const expectedProductionPassword = (): string => {
  const envPath = path.join(__dirname, "..", ".env.mystic-motors-prod");
  if (!fs.existsSync(envPath)) {
    return DEFAULT_DEPLOY_PASSWORD;
  }
  const match = fs
    .readFileSync(envPath, "utf-8")
    .match(/^DEPLOY_PASSWORD=(.*)$/m);
  return match?.[1]?.trim() || DEFAULT_DEPLOY_PASSWORD;
};

const confirmProduction = async (): Promise<void> => {
  console.log("You are about to seed PRODUCTION game data.");
  if ((await ask("Enter production password: ")) !== expectedProductionPassword()) {
    console.error("Incorrect password. Seeding cancelled.");
    process.exit(1);
  }
  if ((await ask("Type 'PRODUCTION' to confirm: ")) !== "PRODUCTION") {
    console.error("Confirmation failed. Seeding cancelled.");
    process.exit(1);
  }
};

const run = async (): Promise<void> => {
  const environment = readEnvironment();
  const dryRun = process.argv.includes("--dry-run");
  const projectId = PROJECTS[environment];

  let documents = loadGameDataDocuments();
  const onlyIndex = process.argv.indexOf("--only");
  if (onlyIndex >= 0) {
    if (environment !== "sandbox") throw new Error("--only is supported only for sandbox.");
    const selection = process.argv[onlyIndex + 1];
    if (!selection || selection.startsWith("--")) throw new Error("--only requires comma-separated exact manifest paths.");
    const selected = selection.split(",").map(value => value.trim());
    if (selected.some(value => !value || !documents.some(document => document.path === value))) {
      throw new Error("--only contains an empty or unknown GameData document path.");
    }
    documents = documents.filter(document => selected.includes(document.path));
  }

  const botNames = documents.find((entry) => entry.path === BOT_NAMES_PATH);
  if (botNames) {
    assertBotNamesAreValidUsernames((botNames.data as { names?: unknown }).names);
  }

  console.log(`Target: ${projectId}`);
  console.log(`Documents in manifest: ${documents.length}`);
  documents.forEach((entry) => console.log(`  ${entry.path}  <-  ${entry.file}`));

  if (dryRun) {
    console.log("\nDry run: nothing was written.");
    return;
  }

  if (environment === "prod") {
    await confirmProduction();
  }

  const keyPath = path.join(__dirname, "..", SERVICE_ACCOUNTS[environment]);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Service account key not found at ${keyPath}`);
  }

  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(fs.readFileSync(keyPath, "utf-8")),
    ),
    projectId,
  });

  const db = admin.firestore();
  for (let i = 0; i < documents.length; i += CHUNK_SIZE) {
    const batch = db.batch();
    for (const entry of documents.slice(i, i + CHUNK_SIZE)) {
      batch.set(db.doc(entry.path), entry.data);
    }
    await batch.commit();
  }

  console.log(`\nSeeded ${documents.length} documents into ${projectId}.`);
};

run().catch((error) => {
  console.error("Seeding failed:", error);
  process.exit(1);
});
