import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";

async function main() {
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keyFilename = path.join(root, "mystic-motors-sandbox-9b64d57718a2.json");
if (JSON.parse(fs.readFileSync(keyFilename, "utf8")).project_id !== "mystic-motors-sandbox") throw new Error("Sandbox credential required");
const env = fs.readFileSync(path.join(root, ".env.mystic-motors-sandbox"), "utf8");
const property = env.match(/^GA4_PROPERTY_ID\s*=\s*["']?([^"'\r\n]+)/m)?.[1].trim();
if (!property || !/^properties\/\d+$/.test(property)) throw new Error("Valid sandbox GA4 property required");
const schema = JSON.parse(fs.readFileSync(path.join(root, "src/analytics/schema.json"), "utf8"));
const auth = new GoogleAuth({ keyFilename, scopes: ["https://www.googleapis.com/auth/analytics.edit"] });
const client = await auth.getClient();
const base = "https://analyticsadmin.googleapis.com/v1beta/" + property;
const apply = process.argv.includes("--apply");
for (const [kind, parameters] of [["customDimensions", schema.dimensions], ["customMetrics", schema.metrics]]) {
    const existing = new Set();
    let pageToken;
    do {
        const result = await client.request({ url: base + "/" + kind, params: { pageSize: 200, pageToken } });
        for (const item of result.data[kind] || []) existing.add(item.parameterName);
        pageToken = result.data.nextPageToken;
    } while (pageToken);
    for (const parameterName of parameters) {
        if (existing.has(parameterName)) { console.log(JSON.stringify({ parameterName, status: "exists" })); continue; }
        if (!apply) { console.log(JSON.stringify({ parameterName, status: "would_create" })); continue; }
        const data = { parameterName, displayName: parameterName.replaceAll("_", " "), scope: "EVENT" };
        if (kind === "customMetrics") data.measurementUnit = "STANDARD";
        try {
            await client.request({ url: base + "/" + kind, method: "POST", data });
            console.log(JSON.stringify({ parameterName, status: "created" }));
        } catch (error) {
            console.error(JSON.stringify({ parameterName, status: "failed", code: error.response?.status, message: error.response?.data?.error?.message || "Request failed" }));
            process.exitCode = 1;
        }
    }
}

}
main().catch(error => { console.error(JSON.stringify({ status: "failed", code: error.response?.status, message: error.response?.data?.error?.message || error.message })); process.exitCode = 1; });
