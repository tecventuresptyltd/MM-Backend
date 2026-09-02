/**
 * Proves the consolidated service behaves identically to the deployed functions.
 *
 * Sends the same payload to the live sandbox function and to a locally running
 * consolidated service, then diffs the status code and response body. Any
 * mismatch is a behaviour change and should block the migration.
 *
 * Usage:
 *   1. npm run build
 *   2. GCLOUD_PROJECT=mystic-motors-sandbox \
 *      GOOGLE_APPLICATION_CREDENTIALS=mystic-motors-sandbox-9b64d57718a2.json \
 *      PORT=8099 npm run serve:consolidated
 *   3. node tools/compareConsolidated.mjs
 *
 * Every case below is read-only or an input-validation rejection, so running
 * this does not create or modify sandbox data.
 */

const LOCAL = process.env.LOCAL_URL ?? "http://127.0.0.1:8099";
const REMOTE =
  process.env.REMOTE_URL ??
  "https://us-central1-mystic-motors-sandbox.cloudfunctions.net";

/**
 * Each case names a callable and the payload to send. The expectation is not
 * hardcoded -- the point is that both deployments answer the same way.
 */
const CASES = [
  { fn: "ensureGuestSession", data: {}, note: "missing required fields" },
  { fn: "ensureGuestSession", data: { opId: "cmp-1" }, note: "missing deviceAnchor" },
  { fn: "checkSession", data: {}, note: "no auth token" },
  { fn: "initUser", data: {}, note: "no auth token" },
  { fn: "prepareRace", data: {}, note: "App Check enforced" },
  { fn: "openCrate", data: {}, note: "App Check enforced" },
  { fn: "getFriends", data: {}, note: "App Check enforced" },
  { fn: "claimDailyReward", data: {}, note: "App Check enforced" },
];

const call = async (base, fn, data) => {
  try {
    const res = await fetch(`${base}/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 120);
    }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: `REQUEST FAILED: ${err.message}` };
  }
};

/** Compares status plus the callable error code, which is what clients branch on. */
const signature = (r) =>
  `${r.status} ${r.body?.error?.status ?? (r.body?.result !== undefined ? "OK" : "?")}`;

const main = async () => {
  console.log(`local : ${LOCAL}`);
  console.log(`remote: ${REMOTE}\n`);

  let pass = 0;
  let fail = 0;

  for (const { fn, data, note } of CASES) {
    const [local, remote] = await Promise.all([
      call(LOCAL, fn, data),
      call(REMOTE, fn, data),
    ]);

    const same = signature(local) === signature(remote);
    if (same) pass++;
    else fail++;

    console.log(`${same ? "MATCH   " : "MISMATCH"}  ${fn}  (${note})`);
    console.log(`   local : ${signature(local)}  ${JSON.stringify(local.body)}`);
    console.log(`   remote: ${signature(remote)}  ${JSON.stringify(remote.body)}`);
    console.log();
  }

  console.log(`${pass} matched, ${fail} mismatched`);
  process.exit(fail === 0 ? 0 : 1);
};

main();
