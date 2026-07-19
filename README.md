# MVP Spend Tracker (msumvp)

Weekly tracker for wallet spending, using the same wallet list as the
[msuban](https://github.com/ArcaneVorki/msuban) repo. Classifies each wallet
into an MVP spend tier and tracks tier distribution + total spend over time.

## How it works

Each wallet check is slow enough (the API itself, not just the 1-second delay) that
checking all ~5000 wallets sequentially takes around **40 hours** — far past GitHub
Actions' 6-hour per-job timeout. So the weekly check is split into **10 parallel chunks
of 500 wallets each**, using a matrix strategy:

1. A `prepare` job computes one shared timestamp (`nowMs`) used by every chunk, so the
   whole week's snapshot reflects the same instant rather than each chunk drifting as it
   starts at a slightly different time.
2. A `check` job runs **10 copies in parallel** (matrix `chunk: [0..9]`), each one:
   - Pulls the current wallet list from `msuban`'s `data/addresses.json`
   - Slices out its 500-wallet portion (`chunk * 500` to `chunk * 500 + 500`)
   - Calls `https://www.msuinsight.com/api/mvp/<address>/summary?nowMs=<shared timestamp>` for each wallet in its slice, waiting 1 second between each
   - Reads `current.spendNeso` from the response, classifies it into a tier
   - Uploads its results as a build artifact (not committed directly — see below)
3. A `merge` job waits for all 10 chunks, downloads their artifacts, combines them into
   one snapshot, and is the **only** job that commits to the repo — avoiding any race
   condition from multiple parallel jobs trying to push at once.

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

This repo reads two files from `msuban` at runtime — one from the Node scripts (server-side, during the Action), one from the browser (client-side, on page load):

- `scripts/fetch-mvp-chunk.js` fetches `msuban`'s `data/addresses.json` (each of the 10 parallel chunk jobs fetches the full list independently, then slices out its own portion)
- `index.html` fetches `msuban`'s `data/players.json` to show character names/images next to wallet addresses

Both are public raw-GitHub-content URLs, so no cross-repo auth or secrets are needed — but it does mean:
- If `msuban`'s repo name, owner, or file paths ever change, update the URLs in `scripts/fetch-mvp-chunk.js` and `index.html` here to match
- The wallet list `msumvp` checks is always whatever's currently in `msuban`'s `addresses.json` at the moment the weekly job runs — if you rebuild the top-5000 list in `msuban` right before a Thursday run, this tracker picks up the new list automatically

## Runtime

Each wallet check apparently takes long enough that the full ~5000-wallet list would take
around **40 hours** run sequentially — well past GitHub Actions' 6-hour per-job limit.
Split into 10 parallel chunks of 500, each chunk instead takes roughly **4 hours**,
comfortably inside that limit, and all 10 finish around the same time since they run
concurrently. The `merge` job that follows is fast (just combining JSON files).

If your GitHub plan or repo settings limit how many jobs can run concurrently, the chunks
may queue instead of all starting immediately — check the Actions tab if a run seems to be
taking longer than expected. If wallets keep timing out or the API pushes back under this
much parallel load, consider fewer concurrent chunks (e.g. lower `max-parallel` in the
workflow's `strategy` block) at the cost of a longer total run.

## Notes on the numbers

- `scripts/fetch-mvp.js` (the original single-run script) is no longer used by the
  workflow — it's kept only if you want to run a full check manually/locally against a
  small test list. The scheduled workflow uses `fetch-mvp-chunk.js` + `merge-mvp-chunks.js`.
- `spendNeso` is a large raw integer (not pre-divided into millions) — the dashboard formats it as "X.XXM NESO" for readability
- The total spend sum is computed with BigInt in the merge script to avoid floating-point precision loss across thousands of large values, then stored as a string
- If a wallet's API call fails after 3 retries, it's recorded with `spendNeso: null` and excluded from the tier counts and total — check `errorCount` in `latest.json` if the total looks off
