// Weekly MVP spend tracker
//
// 1. Pulls the current wallet address list from the msuban repo (raw GitHub content)
// 2. For each wallet, hits msuinsight's summary API with nowMs = the current run time
// 3. Extracts spendNeso, classifies it into a tier, and tracks everything over time
//
// Output:
//   data/latest.json       — this week's snapshot
//   data/history/<date>.json — same snapshot, dated (one per run)
//   data/manifest.json     — list of dates that have history, for the dashboard

import fs from "fs";
import path from "path";

const ADDRESSES_URL =
  "https://raw.githubusercontent.com/ArcaneVorki/msuban/main/data/addresses.json";
const API_BASE = "https://www.msuinsight.com/api/mvp";
const DELAY_MS = 1000; // 1 second between each API call
const MAX_RETRIES = 3;

// Tier thresholds in raw NESO (spendNeso is already in raw NESO units).
// Each tier's lower bound is inclusive; the upper bound is exclusive.
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

async function main() {
  console.log("Fetching wallet address list from msuban repo...");
  const addresses = await fetchJSON(ADDRESSES_URL);

  if (!Array.isArray(addresses) || addresses.length === 0) {
    console.error("No addresses found in msuban's data/addresses.json — aborting.");
    process.exit(1);
  }

  const nowMs = Date.now();
  console.log(`Checking ${addresses.length} wallets (nowMs=${nowMs})...`);

  const results = [];
  for (let i = 0; i < addresses.length; i++) {
    const original = addresses[i];
    const lower = original.toLowerCase();
    const url = `${API_BASE}/${lower}/summary?nowMs=${nowMs}`;

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

    if ((i + 1) % 100 === 0 || i === addresses.length - 1) {
      console.log(`  ...${i + 1}/${addresses.length} wallets checked`);
    }
    if (i < addresses.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  // Tally rank counts and total spend (BigInt to avoid precision loss on the sum)
  const rankCounts = { Inactive: 0, Bronze: 0, Silver: 0, Gold: 0, Diamond: 0, Black: 0 };
  let totalSpendNeso = 0n;
  let errorCount = 0;

  for (const r of results) {
    if (r.rank) rankCounts[r.rank] = (rankCounts[r.rank] || 0) + 1;
    if (r.spendNeso != null) {
      try {
        totalSpendNeso += BigInt(r.spendNeso);
      } catch {
        // malformed spendNeso value — skip from the sum
      }
    }
    if (r.error) errorCount++;
  }

  const today = new Date().toISOString().slice(0, 10);
  const record = {
    date: today,
    checkedAt: new Date().toISOString(),
    nowMs,
    totalWallets: addresses.length,
    totalSpendNeso: totalSpendNeso.toString(),
    rankCounts,
    errorCount,
    results,
  };

  const historyDir = path.join("data", "history");
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(
    path.join(historyDir, `${today}.json`),
    JSON.stringify(record, null, 2)
  );
  fs.writeFileSync(path.join("data", "latest.json"), JSON.stringify(record, null, 2));

  const manifestPath = path.join("data", "manifest.json");
  let manifest = [];
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  }
  if (!manifest.includes(today)) {
    manifest.push(today);
    manifest.sort();
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(
    `Done. Total spend: ${totalSpendNeso.toString()} NESO across ${addresses.length} wallets ` +
    `(${errorCount} error(s)).`
  );
  console.log("Rank counts:", rankCounts);
}

main();
