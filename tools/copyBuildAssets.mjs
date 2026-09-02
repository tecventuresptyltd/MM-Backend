// Copies non-TypeScript assets that tsc leaves behind into lib/.
// profanityList.json is read at runtime from __dirname, and src/shared/profanity.ts
// throws on import if it is missing — so the compiled output needs its own copy.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ASSETS = [["src/shared/profanityList.json", "lib/shared/profanityList.json"]];

for (const [from, to] of ASSETS) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${from} -> ${to}`);
}
