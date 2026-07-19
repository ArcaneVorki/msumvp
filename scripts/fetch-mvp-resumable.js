// Resumable weekly MVP spend check.
//
// The wallet list is too large to check sequentially within a single GitHub
// Actions job (6-hour limit) — a full pass takes roughly 40 hours. And the
// API gets slower under concurrent load, so parallel chunks (matrix jobs)
// make things WORSE, not better. Instead, this script processes wallets
// strictly one at a time, checkpointing its position to disk periodically.
// If the run's time budget runs out, it saves where it stopped and exits
// cleanly — the next scheduled run picks up exactly where it left off.
//
// State lives in three files (all under data/, all committed to the repo):
//   data/progress.json          - cycle metadata: nowMs, nextIndex, completed, etc.
//   data/progress-addresses.json - the wallet list snapshot for this cycle
//                                   (captured once at cycle start, so a
//                                   mid-cycle change to msuban's list can't
//                                   cause inconsistent results)
//   data/progress-results.json  - results accumulated so far this cycle
//
// A cycle starts fresh when: no progress.json exists, OR the last cycle
// completed at least MIN_DAYS_BETWEEN_CYCLES ago. Otherwise, if the last
// cycle is still in progress, this run resumes it. If the last cycle
// completed recently and isn't due yet, this run is a no-op.

import fs from "fs";
import path from "path";

const ADDRESSES_URL =
  "https://raw.githubusercontent.com/ArcaneVorki/msuban/main/data/addresses.json";
const API_BASE = "https://www.msuinsight.com/api/mvp";
const DELAY_MS = 1000; // 1 second between each API call
const MAX_RETRIES = 3;

// Stop grinding new wallets after this long into the run and checkpoint
// instead — comfortably inside GitHub Actions' 6-hour per-job limit, with
// buffer for checkout/setup/commit overhead on both ends.
const RUN_TIME_BUDGET_MS = 5.5 * 60 * 60 * 1000;

// Don't start a new weekly cycle sooner than this after the last one
// finished, so an extra scheduled trigger firing near cycle-end doesn't
// kick off a second cycle prematurely.
const MIN_DAYS_BETWEEN_CYCLES = 6;

const PROGRESS_PATH = path.join("data", "progress.json");
const PROGRESS_ADDRESSES_PATH = path.join("data", "progress-addresses.json");
const PROGRESS_RESULTS_PATH = path.join("data", "progress-results.json");

const TIERS = [
  { id: "Black", min: 700_000_000 },
  { id: "Diamond", min: 350_000_000 },
  { id: "Gold", min: 150_000_000 },
  { id: "Silver", min: 75_000_000 },
  { id: "Bronze", min: 3_000_000 },
  { id: "Inactive", min: 0 },
];

function classifyRank(spendNeso) {
  const n = Number(spendNeso);
  for (const tier of TIERS) {
    if (n >= tier.min) return tier.id;
  }
  return "Inactive";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJSON(url, attempt = 1) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(1000 * attempt);
      return fetchJSON(url, attempt + 1);
    }
    throw err;
  }
}

function loadJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function finalizeCycle(progress, results) {
  const rankCounts = { Inactive: 0, Bronze: 0, Silver: 0, Gold: 0, Diamond: 0, Black: 0 };
  let totalSpendNeso = 0n;
  let errorCount = 0;

  for (const r of results) {
    if (r.rank) rankCounts[r.rank] = (rankCounts[r.rank] || 0) + 1;
    if (r.spendNeso != null) {
      try {
        totalSpendNeso += BigInt(r.spendNeso);
      } catch {
        // malformed spendNeso — skip from the sum
      }
    }
    if (r.error) errorCount++;
  }

  const date = progress.cycleDate;
  const record = {
    date,
    checkedAt: new Date().toISOString(),
    nowMs: progress.nowMs,
    totalWallets: results.length,
    totalSpendNeso: totalSpendNeso.toString(),
    rankCounts,
    errorCount,
    results,
  };

  saveJSON(path.join("data", "history", `${date}.json`), record);
  saveJSON(path.join("data", "latest.json"), record);

  let manifest = loadJSON(path.join("data", "manifest.json"), []);
  if (!manifest.includes(date)) {
    manifest.push(date);
    manifest.sort();
  }
  saveJSON(path.join("data", "manifest.json"), manifest);

  console.log(
    `Cycle ${date} complete: ${results.length} wallets, total spend ` +
    `${totalSpendNeso.toString()} NESO, ${errorCount} error(s).`
  );

  // These are now redundant with data/latest.json + history — clean up
  // so they don't linger and confuse a future run.
  fs.rmSync(PROGRESS_RESULTS_PATH, { force: true });
  fs.rmSync(PROGRESS_ADDRESSES_PATH, { force: true });
}

async function main() {
  const runStart = Date.now();
  let progress = loadJSON(PROGRESS_PATH, null);

  const needNewCycle =
    !progress ||
    (progress.completed &&
      Date.now() - new Date(progress.completedAt).getTime() >=
        MIN_DAYS_BETWEEN_CYCLES * 24 * 60 * 60 * 1000);

  if (needNewCycle) {
    console.log("Starting a new weekly MVP cycle...");
    const addresses = await fetchJSON(ADDRESSES_URL);
    if (!Array.isArray(addresses) || addresses.length === 0) {
      console.error("No addresses found in msuban's data/addresses.json — aborting.");
      process.exit(1);
    }
    progress = {
      cycleDate: new Date().toISOString().slice(0, 10),
      nowMs: Date.now(),
      nextIndex: 0,
      totalWallets: addresses.length,
      startedAt: new Date().toISOString(),
      completed: false,
      completedAt: null,
    };
    saveJSON(PROGRESS_ADDRESSES_PATH, addresses);
    saveJSON(PROGRESS_RESULTS_PATH, []);
    saveJSON(PROGRESS_PATH, progress);
  } else if (progress.completed) {
    console.log(
      `Last cycle (${progress.cycleDate}) completed at ${progress.completedAt} — ` +
      `not due for a new one yet. Nothing to do this run.`
    );
    return;
  } else {
    console.log(
      `Resuming cycle ${progress.cycleDate} at wallet ${progress.nextIndex}/${progress.totalWallets}...`
    );
  }

  const addresses = loadJSON(PROGRESS_ADDRESSES_PATH, []);
  let results = loadJSON(PROGRESS_RESULTS_PATH, []);

  let i = progress.nextIndex;
  for (; i < addresses.length; i++) {
    if (Date.now() - runStart > RUN_TIME_BUDGET_MS) {
      console.log(
        `Time budget reached at wallet ${i}/${addresses.length} — ` +
        `checkpointing and stopping for this run. Next scheduled run will resume here.`
      );
      break;
    }

    const original = addresses[i];
    const lower = original.toLowerCase();
    const url = `${API_BASE}/${lower}/summary?nowMs=${progress.nowMs}`;

    try {
      const data = await fetchJSON(url);
      const spendNeso = data?.current?.spendNeso ?? "0";
      results.push({
        address: original,
        spendNeso,
        rank: classifyRank(spendNeso),
        windowLabel: data?.window?.label || null,
        error: null,
      });
    } catch (err) {
      console.error(`  ${lower} failed permanently: ${err.message}`);
      results.push({
        address: original,
        spendNeso: null,
        rank: null,
        error: err.message,
      });
    }

    if ((i + 1) % 100 === 0) {
      console.log(`  ...${i + 1}/${addresses.length} wallets checked so far this cycle`);
      // Periodic mid-run checkpoint, in case the job gets killed unexpectedly
      // (e.g. runner failure) rather than stopping cleanly on our own budget.
      saveJSON(PROGRESS_RESULTS_PATH, results);
      saveJSON(PROGRESS_PATH, { ...progress, nextIndex: i + 1 });
    }

    if (i < addresses.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  saveJSON(PROGRESS_RESULTS_PATH, results);

  if (i >= addresses.length) {
    progress.nextIndex = addresses.length;
    progress.completed = true;
    progress.completedAt = new Date().toISOString();
    saveJSON(PROGRESS_PATH, progress);
    finalizeCycle(progress, results);
  } else {
    progress.nextIndex = i;
    saveJSON(PROGRESS_PATH, progress);
    console.log(`Checkpoint saved at wallet ${i}/${addresses.length}.`);
  }
}

main();
