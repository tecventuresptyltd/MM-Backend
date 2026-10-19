# Sandbox shop rotation

The curated shop is enabled only for `mystic-motors-sandbox` (or local `demo-test` emulators) and an enabled `/GameData/v1/config/ShopRotationConfig` document. Production follows the existing selection path even if this config is accidentally seeded there. Products, store identifiers, prices and entitlements are unchanged.

Version `curated-sandbox-auto-v3` uses `selectionMode: automatic`. The config contains 14 daily trios and seven special trios, covering all 30 existing offers. The ordinary sequence interleaves the four ranges: A1 → B1 → C1 → D1 → A2 → B2 → C2 → D2 → A3 → C3 → D3 → A4 → A5 → A6 → A1. The whole trio advances at 00:00 UTC (05:30 IST), and missed days are caught up on refresh. A verified ordinary purchase advances the same global sequence immediately without moving that deadline. Cards retain the server's order. No cooldown or purchase-delay gap is introduced.

The existing three-card shop is used without added navigation, buttons, labels, or other GUI changes. Existing price/value presentation remains unchanged. Ordinary offers no longer require the player to choose a range. Conditional specials still require their server event; catalog coverage does not mean every player qualifies for every special.

## Complete configured set list

These are existing products. The middle card is a comparison to test, not a claim that it will sell best. The server selects a complete ordinary or special trio automatically.

| Set | Range or condition | First card | Middle card | Third card |
|---|---|---|---|---|
| A1 | Small | GEM IGNITION — $1.99 | SHARD STRIKE — $2.99 | TURBO CACHE — $3.99 |
| A2 | Small | NIGHT SHIFT — $1.99 | TURBO CACHE — $3.99 | WEEKEND CIRCUIT — $6.99 |
| A3 | Small | RARE STORM — $1.99 | SHARD STRIKE — $2.99 | TURBO CACHE — $3.99 |
| A4 | Small | FUEL SURGE — $1.99 | TURBO CACHE — $3.99 | WEEKEND CIRCUIT — $6.99 |
| A5 | Small | SPARK CACHE — $1.99 | SHARD STRIKE — $2.99 | TURBO CACHE — $3.99 |
| A6 | Small | RARE RUSH — $1.99 | TURBO CACHE — $3.99 | WEEKEND CIRCUIT — $6.99 |
| B1 | Standard | WEEKEND CIRCUIT — $6.99 | EXOTIC EDGE — $9.99 | HORIZON CACHE — $12.99 |
| B2 | Standard | EXOTIC EDGE — $9.99 | HORIZON CACHE — $12.99 | EXOTIC STORM — $19.99 |
| C1 | Legendary | LEGENDARY EDGE — $24.99 | LEGENDARY HAUL — $29.99 | LEGEND SURGE — $39.99 |
| C2 | Legendary | LEGEND SURGE — $39.99 | GRAND CIRCUIT — $69.99 | LEGENDARY VAULT — $89.99 |
| C3 | Legendary | EXOTIC STORM — $19.99 | GOLD FLOOD — $24.99 | LEGENDARY HAUL — $29.99 |
| D1 | Collections | MYTHIC TROVE — $79.99 | GARAGE GODS — $129.99 | GRAND HAUL — $149.99 |
| D2 | Collections | GARAGE GODS — $129.99 | GRAND HAUL — $149.99 | SOVEREIGN CACHE — $199.99 |
| D3 | Collections | GARAGE GODS — $129.99 | GRAND HAUL — $149.99 | CHAMPIONS VAULT — $199.99 |
| S1 | purchase | TURBO CACHE — $3.99 | FLASH CIRCUIT — $5.99 | WEEKEND CIRCUIT — $6.99 |
| S2 | mastery | GEM IGNITION — $1.99 | MASTERY SURGE — $2.99 | TURBO CACHE — $3.99 |
| S3 | mastery | EXOTIC EDGE — $9.99 | SPEED VAULT — $12.99 | EXOTIC STORM — $19.99 |
| S4 | mastery | MYTHIC TROVE — $79.99 | APEX VAULT — $99.99 | GRAND HAUL — $149.99 |
| S5 | win_streak | TURBO CACHE — $3.99 | EXOTIC SURGE — $5.99 | WEEKEND CIRCUIT — $6.99 |
| S6 | mythical_crate | LEGEND SURGE — $39.99 | FORTUNE VAULT — $44.99 | MYTHIC TROVE — $79.99 |
| S7 | weekend | TURBO CACHE — $3.99 | GARAGE CIRCUIT — $6.99 | EXOTIC EDGE — $9.99 |

FUEL SURGE is an unchanged existing product name; there is no fuel mechanic or eligibility rule. The prices above are catalog USD reference prices; Unity displays localized store prices.

## API and state

The automatic client calls `getDailyOffers({})`. Valid legacy `rangeId` and `specialSetId` requests cannot override automatic selection. Configurations with omitted `selectionMode` or explicit `manual` retain the earlier manual API for compatibility. The response and `/Players/{uid}/Offers/Active` contain exactly three `rotating` entries, an empty `special` list, and `rotation` metadata: version, revision, selectionMode, rangeId, setId, selectedSpecialSetId, nextRotationAt, availableRanges, availableSpecialSets and serverNow. All times are epoch milliseconds. Metadata lists do not create navigation controls.

`/Players/{uid}/Offers/Rotation` stores server-owned cursors, `automaticCursor`, selectionMode, current range/special, presentation revision, milestone eligibility, event timestamps and special windows. It is initialized during user bootstrap and lazily for existing accounts. The Unity client never grants eligibility or writes offer state. Migration from manual mode preserves the corresponding ordinary set and existing special deadlines/consumption state, while changing the presentation version/revision so old pending receipts cannot advance the new view.

Purchase requests preserve `shopPresentation: {version, revision, setId, rangeId, expiresAt}` from the card originally clicked. A valid paid receipt is fulfilled even when that presentation is stale, but it only changes the displayed set when all presentation fields still match. Receipt ledger writes, reward delivery and rotation changes share a transaction. Replays cannot rotate or grant twice. Sandbox purchases accepted with receipt verification disabled retain existing fulfillment behavior but do not advance curated sets or grant purchase-triggered eligibility.

## Specials

| Set | Featured offer | Server event | Window |
|---|---|---|---|
| S1 | FLASH CIRCUIT | Verified, applied IAP ledger entry | 15 minutes |
| S2 | MASTERY SURGE | Mastery ranks 5, 15, 25, ... | 24 hours |
| S3 | SPEED VAULT | Mastery ranks 10, 20, 30, ... | 24 hours |
| S4 | APEX VAULT | Mastery ranks 20, 30, 40, ... | 48 hours |
| S5 | EXOTIC SURGE | Each completed block of three consecutive first-place finishes | 1 hour |
| S6 | FORTUNE VAULT | Positive Mythical crate inventory grant or a newly received Mythical crate slot | 8 hours |
| S7 | GARAGE CIRCUIT | Saturday 00:00 UTC (05:30 IST) | 24 hours |

Mastery changes are observed on the authoritative profile document. Existing qualified players receive a one-time catch-up window on their first curated shop initialization. A win counter is updated atomically in race settlement and reset on a non-win. Inventory/slot crate metadata is resolved from the live SKU catalog; opening, rearranging or starting an unlock does not grant eligibility. There is no fuel condition. GOLD FLOOD uses ordinary set C3 and the daily deadline.

Version `curated-sandbox-auto-v3` adds `repeatEveryRanks: 10` to the three mastery sets. Each newly crossed scheduled rank opens a fresh original-duration window, including after an earlier occurrence was purchased or expired. An ordinary rank increase does not reopen it. A jump across several milestones processes only the latest crossed occurrence per offer, with no backlog. Initial catch-up similarly uses the latest reached occurrence. Existing initialized accounts wait for their next actual threshold crossing; rollout does not restart their current timers.

`milestoneRanks` stores the highest processed scheduled rank per mastery set. This prevents duplicate, delayed or downgraded events from reopening an older occurrence. Mastery events include the previous authoritative rank so a non-threshold update cannot create a retroactive grant. Late events use the original event timestamp and cannot create a countdown after their original deadline. A genuine later milestone may replace an earlier active window; normal refreshes cannot extend it. Legacy configs without `repeatEveryRanks` retain once-only behavior. No Unity or GUI changes are required for recurrence.

An eligible special automatically replaces the entire trio. The earliest expiry has priority. Specials tied at that earliest expiry alternate in stable configuration order on fixed 15-minute UTC slices (`specialTiePeriodMs: 900000`); their original deadlines do not change. `nextRotationAt` includes the next slice boundary or special expiry so the existing shop refreshes on time. Buying the featured special consumes that window and selects the next eligible special, or resumes the ordinary sequence when none remains. Buying a companion does not close or extend the window. The ordinary cursor continues its daily schedule while specials are displayed. A consumed window remains recorded until its original expiry, preventing its own purchase rewards from immediately reopening it. Event timestamps, rather than delivery times, define deadlines. Older or duplicate events cannot extend a window. A refresh cannot restart a countdown.

## Sandbox deployment and rollback

`npm run deploy:sandbox -- --shop-rotation` selects the seven shop targets below and accepts retry policies for the four new idempotent event handlers. The flag is restricted to this fixed sandbox target list; the script still requires its sandbox confirmation.

Run `npx tsx tools/checkShopRotationSandbox.ts` from the backend repository. This only reads the sandbox catalog, validates the complete rotation and compares product prices/rewards with the reviewed seed. The sandbox service-account key must identify `mystic-motors-sandbox`.

Use the authorized safe deployment script with only `functions:mm-sandbox:gameApi,functions:mm-sandbox:offerTransitionJob,functions:mm-sandbox:offerSafetyNetJob,functions:mm-sandbox:onShopRotationProfile,functions:mm-sandbox:onShopRotationCrateSlots,functions:mm-sandbox:onShopRotationInventory,functions:mm-sandbox:onShopRotationPurchase`. Enable after deploying the handlers by running `npx tsx tools/checkShopRotationSandbox.ts --enable`. This validates the sandbox credentials and existing catalog before writing only the rotation config. The seed defaults disabled so a general seed does not activate an experiment. No offer catalog seeding or production command is required.

Disabling this config stops curated handlers after the 60-second config cache. The next getDailyOffers request restores the three legacy categories and removes rotation metadata. Do not deploy legacy scheduled jobs against curated active documents while this config is enabled.

## Previous manual-version validation

The following records describe the earlier manual version, before the automatic/no-GUI revision. They are not evidence that the automatic revision has been deployed or live-tested. Deployment record, 20 October 2026 IST: the seven scoped sandbox functions deployed successfully, and the rotation configuration was enabled. The live preflight confirmed all 30 offers retained their original prices, product IDs, names and entitlements. No production deployment or offer-catalog write was performed.

The authenticated live smoke check passed all four ranges, exactly three cards, rejection of unavailable selections, real mastery/win-streak events (S2-S5), a real Mythical inventory grant (S6), and a refresh that preserved the special deadline. Its temporary account and player data were removed. The first attempt timed out waiting for S6 shortly after deployment; a repeat with a longer bounded event-delivery window passed without runtime changes. Live store checkout and the crate-slot acquisition path were not exercised by this smoke check; receipt and slot logic were checked in the scoped automated suites.

The Unity C# build completed with zero errors, and the open Editor reported no console errors. The shop layout was not visually tested because the Editor was running OpenWorldLobby without the shop/core objects. No APK or AAB was produced.

Emulator suites: `shop.curatedRotation`, `shop.rotationPurchase`, `shop.rotationEvents`, `shop.rotationRace`, `iap.fulfillment`, `race.crateCadence`. They exercise actual Firestore transactions, original seed entitlements, expiry, conditional eligibility, production isolation, concurrent receipt replay, failed grants, and stale presentation recovery. Store verification is mocked in receipt tests; they do not perform a real store purchase.

The focused `shop.rotationBootstrap` suite verifies creation and preservation of shop state during login. The seven scoped suites pass 57 tests. Older `initializeUser` and `auth.init` suites independently reproduce five failures on the unchanged backend baseline (starter spell, currency, key and tutorial expectations); this change does not alter those grants.

## Automatic-version validation

Recurring milestone rollout, 20 October 2026 IST: `curated-sandbox-auto-v3` deployed and enabled only in sandbox. All nine scoped emulator suites passed (76 tests), including 12 recurrence tests covering all three schedules, consumed/active windows, replay, out-of-order events, non-threshold ranks, migration, rank jumps and original expiry. The live authenticated check confirmed MASTERY SURGE reopened at rank 25, rank 26 did not reopen or extend it, and SPEED VAULT/APEX VAULT reopened at rank 30 with their original 24/48-hour durations. The ordinary cycle and other event checks also passed; the temporary account and its player data were removed. All 30 catalog offers still match their reviewed names, prices, product identifiers and rewards. This revision changes only backend event processing and adds no client work.

Earlier sandbox rollout, 20 October 2026 IST: all seven scoped functions deployed successfully and `curated-sandbox-auto-v2` was enabled before the v3 recurrence update. The live preflight reconfirmed unchanged prices, product IDs, names and rewards for all 30 offers. Production was not targeted.

The authenticated live check passed all 14 ordinary trios by advancing only the temporary test account's saved day, three cards per response, automatic special selection after real profile and Mythical inventory events, and unchanged special deadlines on refresh. Manual selection attempts did not override the automatic trio. The temporary account and player data were removed. The Unity changes compile with zero errors, and the Editor console reports zero errors. Original price/value rendering was restored; added navigation creation and layout adjustment code were removed. No prefab, scene, card-size or artwork changes were made for this revision. No APK/AAB or device checkout test was produced.

The new automatic suite covers all 14 ordinary sets, all seven eligible specials, 30-offer coverage, 15-minute equal-expiry rotation, earliest-expiry priority, preserved deadlines, special consumption, and migration. The receipt suite additionally checks automatic global advancement, concurrent replay, stale presentations and automatic upsell display through the real fulfillment transaction. Manual-mode regression fixtures explicitly select manual mode.

Local emulator validation on 20 October 2026 IST: all eight scoped suites passed, 64 tests total (`shop.automaticRotation`, `shop.curatedRotation`, `shop.rotationPurchase`, `shop.rotationEvents`, `shop.rotationRace`, `shop.rotationBootstrap`, `iap.fulfillment`, `race.crateCadence`). These tests do not perform real store checkout or deploy to any project.

After deployment, `npx tsx tools/smokeShopRotationSandbox.ts <sandbox-google-services.json>` creates a temporary sandbox account, authenticates with Auth and App Check, calls the deployed gateway, checks automatic ordinary and special selection, exercises the real profile and Mythical inventory triggers, then removes the temporary account and player documents. It never purchases a store product.

The client maintains at most three offer cards and adds no navigation controls. Deadline checks run once per second, not every frame. Configuration and offer catalog reads are cached for 60 seconds; views and reward events use Firestore transactions. Device performance and real Google Play/App Store checkout require device validation.
