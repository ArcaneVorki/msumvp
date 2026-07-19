// Fetches MVP spend data for one chunk of the wallet list.
// Run in parallel across multiple GitHub Actions matrix jobs (see
// .github/workflows/weekly-mvp-check.yml) so a ~40 hour sequential job
// becomes ~10 jobs finishing in parallel, each well under the 6-hour
// GitHub Actions per-job timeout.
//
// Required env vars:
//   CHUNK_INDEX - which slice of the address list to process (0-based)
//   NOW_MS      - shared timestamp (ms) used for every wallet across all
//                 chunks, so the whole week's snapshot is "as of" the same
//                 instant rather than each chunk using its own start time
// Optional:
//   CHUNK_SIZE  - wallets per chunk (default 500)
//
// Output: data/chunks/chunk-<index>.json — this chunk's results only.
// A separate merge step (scripts/merge-mvp-chunks.js) combines all chunks
// into the final data/latest.json snapshot.

import fs from "fs";

const ADDRESSES_URL =
  "https://raw.githubusercontent.com/ArcaneVorki/msuban/main/data/addresses.json";
const API_BASE = "https://www.msuinsight.com/api/mvp";
const DELAY_MS = 1000; // 1 second between each API call
const MAX_RETRIES = 3;

const CHUNK_INDEX = parseInt(process.env.CHUNK_INDEX, 10);
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || "500", 10);
const NOW_MS = parseInt(process.env.NOW_MS, 10);

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

function writeChunk(results) {
  fs.mkdirSync("data/chunks", { recursive: true });
  fs.writeFileSync(
    `data/chunks/chunk-${CHUNK_INDEX}.json`,
    JSON.stringify({ chunkIndex: CHUNK_INDEX, results }, null, 2)
  );
}

async function main() {
  if (Number.isNaN(CHUNK_INDEX)) {
    console.error("CHUNK_INDEX env var is required.");
    process.exit(1);
  }
  if (Number.isNaN(NOW_MS)) {
    console.error("NOW_MS env var is required.");
    process.exit(1);
  }

  console.log(`Fetching full address list for chunk ${CHUNK_INDEX} (size ${CHUNK_SIZE})...`);
  const allAddresses = await fetchJSON(ADDRESSES_URL);

  if (!Array.isArray(allAddresses) || allAddresses.length === 0) {
    console.error("No addresses found in msuban's data/addresses.json — aborting.");
    process.exit(1);
  }

  const start = CHUNK_INDEX * CHUNK_SIZE;
  const chunkAddresses = allAddresses.slice(start, start + CHUNK_SIZE);

  if (chunkAddresses.length === 0) {
    console.log(
      `Chunk ${CHUNK_INDEX} is empty (start=${start}, total addresses=${allAddresses.length}) — ` +
      `nothing to do, writing an empty chunk file.`
    );
    writeChunk([]);
    return;
  }

  console.log(
    `Checking ${chunkAddresses.length} wallets in chunk ${CHUNK_INDEX} (nowMs=${NOW_MS})...`
  );

  const results = [];
  for (let i = 0; i < chunkAddresses.length; i++) {
    const original = chunkAddresses[i];
    const lower = original.toLowerCase();
    const url = `${API_BASE}/${lower}/summary?nowMs=${NOW_MS}`;

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

    if ((i + 1) % 50 === 0 || i === chunkAddresses.length - 1) {
      console.log(`  ...${i + 1}/${chunkAddresses.length} wallets checked in this chunk`);
    }
    if (i < chunkAddresses.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  writeChunk(results);
  console.log(`Chunk ${CHUNK_INDEX} done: ${results.length} wallets.`);
}

main();
