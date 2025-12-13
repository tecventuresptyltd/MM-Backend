# Audit of Tools Runtime

This document summarizes the audit and changes made to the conversion and seeding tools.

## Summary of Changes

- **Normalized Tools Runtime**: Standardized the tools runtime to a compile-then-run flow (`tsc` -> `node`) to avoid module resolution issues.
- **Extensionless Imports**: Removed all `.js` extensions from import statements in the TypeScript files.
- **`tsconfig.json` Configuration**:
    - Created `backend-sandbox/tsconfig.tools.json` to control the compilation of the tools.
    - Modified `backend-sandbox/tsconfig.json` to have an empty `include` array to avoid conflicts.
- **`package.json` Scripts**:
    - Added a `tools:build` script to compile the tools.
    - Updated all `convert:*` scripts to use the compile-then-run flow.
    - Added `seed:file` and `seed:*` scripts to run the seeder.
- **`seedFirestore.mjs`**:
    - Created a new `seedFirestore.mjs` script as an ES module.
    - Added support for the `--dry-run` flag.
- **Pathing**:
    - Corrected all Firestore paths to include `v1/`.
- **Error Handling**:
    - Fixed a bug in the `convertGlobalChatSample.ts` script that caused a `TypeError` when sorting messages.
    - Fixed a bug in the `convertGlobalChatSample.ts` script that caused a `SyntaxError` when parsing the `global_chat_full.json` file.

## Commands to Rerun Everything End-to-End

To rerun the entire conversion and seeding process, run the following commands from the `backend-sandbox` directory:

```bash
# Install dependencies
npm install

# Run all conversion scripts
npm run convert:items+inv && \
npm run convert:cars && \
npm run convert:spells && \
npm run convert:crates && \
npm run convert:ranks && \
# npm run convert:xp && \  # DEPRECATED - XP now calculated via runtime formula
npm run convert:offers && \
npm run convert:chat

# Set the GOOGLE_APPLICATION_CREDENTIALS environment variable
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.mm/sandbox-sa.json"

# Run all seeding scripts
npm run seed:items && \
npm run seed:itemSkus && \
npm run seed:playerInv && \
npm run seed:playerCos && \
npm run seed:cars && \
npm run seed:spells && \
npm run seed:crates && \
npm run seed:ranks && \
# npm run seed:xp && \  # DEPRECATED - XP now calculated via runtime formula
npm run seed:offers && \
npm run seed:chat