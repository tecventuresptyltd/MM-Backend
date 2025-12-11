/**
 * Manual runner to refresh global and/or clan leaderboards without the Firebase CLI.
 *
 * Usage (from repo root):
 *   export GOOGLE_APPLICATION_CREDENTIALS=./mystic-motors-sandbox-9b64d57718a2.json
 *   npx tsx tools/refreshLeaderboards.ts --project mystic-motors-sandbox --target both
 *
 * Targets: global | clan | both (default: both)
 */
import * as admin from "firebase-admin";

type Target = "global" | "clan" | "both";

interface Options {
  projectId?: string;
  target: Target;
}

function parseArgs(argv: string[]): Options {
  let projectId: string | undefined;
  let target: Target = "both";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) {
      projectId = argv[++i];
    } else if (arg.startsWith("--project=")) {
      projectId = arg.split("=")[1];
    } else if (arg === "--target" && argv[i + 1]) {
      target = argv[++i] as Target;
    } else if (arg.startsWith("--target=")) {
      target = arg.split("=")[1] as Target;
    }
  }
  const normalizedTarget: Target =
    target === "global" || target === "clan" ? target : "both";
  return { projectId, target: normalizedTarget };
}

async function main() {
  const { projectId, target } = parseArgs(process.argv.slice(2));

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    ...(projectId ? { projectId } : {}),
  });

  // Import after initializeApp so shared db uses the initialized app.
  const { refreshLeaderboards } = await import("../src/Socials/leaderboardJob.js");
  const { refreshClanLeaderboard } = await import("../src/clan/leaderboardJob.js");

  const results: string[] = [];

  if (target === "global" || target === "both") {
    const res = await refreshLeaderboards();
    results.push(`Global leaderboards refreshed (metrics=${res.metrics})`);
  }
  if (target === "clan" || target === "both") {
    const res = await refreshClanLeaderboard();
    results.push(`Clan leaderboard refreshed (processed=${res.processed})`);
  }

  // eslint-disable-next-line no-console
  console.log(results.join("\n") || "Nothing to run.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Refresh failed", err);
  process.exit(1);
});
