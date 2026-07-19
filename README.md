# MVP Spend Tracker (msumvp)

Weekly tracker for wallet spending, using the same wallet list as the
[msuban](https://github.com/ArcaneVorki/msuban) repo. Classifies each wallet
into an MVP spend tier and tracks tier distribution + total spend over time.

## How it works

Each wallet check is slow enough that checking all ~5000 wallets sequentially takes
around **40 hours** — far past GitHub Actions' 6-hour per-job timeout. Running chunks
**in parallel** was the first approach tried, but the API itself gets *slower* under
concurrent load, so that makes things worse rather than better. Instead, this stays
strictly **sequential** and spreads the work across multiple scheduled runs:

1. **Thursday 13:00 UTC** — if no cycle is currently in progress (and the last one
   finished at least ~6 days ago), a new weekly cycle starts: the wallet list is pulled
   fresh from `msuban`'s `data/addresses.json`, snapshotted, and one shared `nowMs`
   timestamp is fixed for the whole cycle.
2. **Every 6 hours after that** — a scheduled run checks whether a cycle is in progress.
   If so, it resumes exactly where the last run left off (tracked in `data/progress.json`),
   processing wallets one at a time (1 second between each, same as before) until either
   the wallet list is exhausted or the run's own time budget (5.5 hours) is up — whichever
   comes first. If it runs out of time, it checkpoints its position and stops cleanly; the
   next 6-hourly run picks up from there.
3. Once the full wallet list is processed, the run finalizes the cycle: merges everything
   into `data/latest.json` / `data/history/<date>.json` / `data/manifest.json`, and marks
   itself complete so subsequent 6-hourly runs no-op until the next Thursday's cycle is due.

A `concurrency` group in the workflow ensures only one run executes at a time — if a
6-hourly trigger fires while a previous run is still going, it queues instead of running
in parallel, which matters here since two runs touching the checkpoint at once would
corrupt it.

At roughly 5.5 usable hours per run and ~40 hours of total work, a full cycle takes about
7-8 of the 6-hourly runs to complete — call it 2 days from the Thursday start, comfortably
finishing well before the next week's cycle is due.

Results land in `data/latest.json`, `data/history/<date>.json`, and `data/manifest.json`.
`index.html` (served via GitHub Pages) reads that data, plus `msuban`'s `data/players.json`
(for character names/images), and renders three tabs:
  - **Rank Distribution** — how many wallets are in each tier, and how that's shifted week to week
  - **Spending Ranking** — every tracked wallet, sorted highest to lowest spend, filterable by tier
  - **Total Spending** — total NESO spent across all wallets, both as a headline number and a trend line over time

## Spend tier thresholds

Based on `spendNeso` (raw NESO, not millions) — lower bound inclusive, upper bound exclusive:

| Tier | Range |
|---|---|
| Inactive | < 3,000,000 |
| Bronze | 3,000,000 – < 75,000,000 |
| Silver | 75,000,000 – < 150,000,000 |
| Gold | 150,000,000 – < 350,000,000 |
| Diamond | 350,000,000 – < 700,000,000 |
| Black | ≥ 700,000,000 |

## Setup (one-time)

1. Create the repo at `https://github.com/ArcaneVorki/msumvp` (empty, no README/gitignore added by GitHub)
2. Push this folder to it, same as the msuban setup:
   ```powershell
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/ArcaneVorki/msumvp.git
   git push -u origin main
   ```
3. **Enable GitHub Pages**: Settings → Pages → Source: Deploy from a branch → `main` / root
4. **Enable Actions write permissions**: Settings → Actions → General → Workflow permissions → "Read and write permissions"
5. Test it manually before waiting on the schedule: Actions tab → "Weekly MVP Spend Check" → Run workflow

Your dashboard will be live at `https://arcanevorki.github.io/msumvp/`.

## Dependency on msuban

This repo reads two files from `msuban` at runtime — one from the Node script (server-side, during the Action), one from the browser (client-side, on page load):

- `scripts/fetch-mvp-resumable.js` fetches `msuban`'s `data/addresses.json` once, at the start of each new cycle (not on every resumed run — the list is snapshotted into `data/progress-addresses.json` for the rest of that cycle, so a mid-cycle change to `msuban`'s list can't cause inconsistent results partway through)
- `index.html` fetches `msuban`'s `data/players.json` to show character names/images next to wallet addresses

Both are public raw-GitHub-content URLs, so no cross-repo auth or secrets are needed — but it does mean:
- If `msuban`'s repo name, owner, or file paths ever change, update the URLs in `scripts/fetch-mvp-resumable.js` and `index.html` here to match
- The wallet list `msumvp` checks is whatever's in `msuban`'s `addresses.json` at the moment each new cycle *starts* (Thursday) — not updated mid-cycle even if `msuban` changes during those 2 days

## Runtime

A full cycle takes roughly **40 hours of actual API time**, spread across ~7-8 runs of
the 6-hourly schedule (each using its 5.5-hour budget), finishing in about 2 days from
the Thursday start. This is intentionally paced and sequential — don't try to speed it up
with parallel jobs, since the API gets slower under concurrent load rather than handling
it well.

You can watch progress mid-cycle by checking `data/progress.json` — `nextIndex` tells you
how far through the wallet list the current cycle has gotten.

If you ever need to check status or force things along, `workflow_dispatch` (the "Run
workflow" button in the Actions tab) works the same as a scheduled trigger — it'll either
resume an in-progress cycle or no-op if one just finished, same logic either way.

## Notes on the numbers

- `scripts/fetch-mvp.js` (the very first version of this tracker, before chunking) is no
  longer used by the workflow — harmless to delete, kept around only for reference.
- `spendNeso` is a large raw integer (not pre-divided into millions) — the dashboard formats it as "X.XXM NESO" for readability
- The total spend sum is computed with BigInt in the finalize step to avoid floating-point precision loss across thousands of large values, then stored as a string
- If a wallet's API call fails after 3 retries, it's recorded with `spendNeso: null` and excluded from the tier counts and total — check `errorCount` in `latest.json` if the total looks off
- `data/progress.json` persists even after a cycle completes (it's how the next Thursday's
  trigger knows whether a new cycle is actually due) — this is expected, not a leftover to clean up
