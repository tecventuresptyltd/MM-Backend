# archive/

One-off artifacts kept for reference. **Nothing here is imported, built, deployed, or tested** —
these files were sitting loose in the repo root and were moved here to keep the root readable.
Safe to delete if you never need them again (git history keeps them either way).

## patches/
Historical, already-applied edits. Do not re-apply.

- `duration.patch` — maintenance-duration change to `src/game-systems/adminMaintenance.ts`.
- `duration_ui.txt` — the matching admin-website JSX snippet for the maintenance duration form.
- `patch_purchaseOffer.ts` — a codemod script that rewrote `src/shop/purchaseOffer.ts` for the
  active-offer-slot refactor.
- `enable-app-check-remaining.sh` — the migration script that added `callableOptions()` to the
  callables that still used raw `{ region: REGION }`.

## scratch/
Throwaway debug scripts hard-coded to the sandbox project.

- `test-admin.ts`, `test-admin-enqueue.ts` — Cloud Tasks queue-name experiments for
  `completeUpgradeTask`.

## setup-notes/
The original hand-off docs from when this backend was delivered as `Atul-Final-Functions`.
Superseded by the root `README.md`, `CLAUDE.md`, and `docs/`.
