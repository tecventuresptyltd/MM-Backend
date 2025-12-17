# Force Updated (manual maintenance scripts)

Local-only admin utilities. These are not deployed; they run only when you invoke them manually.

## XP Backfill
Recalculate `expProgress`, `expToNextLevel`, and `expProgressDisplay` from stored `exp` for every `/Players/{uid}/Profile/Profile`.

Example dry run (no writes):
```
npx tsx "Force Updated/run.ts" xp-backfill --project your-project-id --sa /abs/path/service-account.json --dry-run
```

Apply updates (writes enabled):
```
npx tsx "Force Updated/run.ts" xp-backfill --project your-project-id --sa /abs/path/service-account.json --batch 200 --limit 0
```

Flags:
- `--project` (required): Firestore project ID.
- `--sa`: Service-account JSON path. If omitted, uses application default credentials.
- `--batch`: Page size for pagination (default 200).
- `--limit`: Max writes (0 = no cap).
- `--dry-run`: Log intended writes without modifying Firestore.
- `--fix-levels`: Also rewrite `level` from XP (off by default).
- `--verbose`: Log every processed doc.

Add new jobs by creating a file under `Force Updated/jobs/` and importing it in `run.ts`.***
