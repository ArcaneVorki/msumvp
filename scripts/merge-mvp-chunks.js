// Merges all data/chunks/chunk-*.json files (produced by the matrix of
// fetch-mvp-chunk.js runs) into the final weekly snapshot: data/latest.json,
// data/history/<date>.json, and data/manifest.json.

import fs from "fs";
import path from "path";

const NOW_MS = parseInt(process.env.NOW_MS, 10);

function main() {
  const chunksDir = path.join("data", "chunks");
  if (!fs.existsSync(chunksDir)) {
    console.error("No data/chunks directory found — nothing to merge.");
    process.exit(1);
  }

  const files = fs
    .readdirSync(chunksDir)
    .filter((f) => /^chunk-\d+\.json$/.test(f));

  if (files.length === 0) {
    console.error("No chunk files found in data/chunks — aborting.");
    process.exit(1);
  }

  // Sort by chunk index so the merged results stay in a stable, predictable order
  files.sort((a, b) => {
    const ai = parseInt(a.match(/chunk-(\d+)\.json/)[1], 10);
    const bi = parseInt(b.match(/chunk-(\d+)\.json/)[1], 10);
    return ai - bi;
  });

  console.log(`Merging ${files.length} chunk file(s): ${files.join(", ")}`);

  let allResults = [];
  for (const f of files) {
    const chunk = JSON.parse(fs.readFileSync(path.join(chunksDir, f), "utf-8"));
    allResults = allResults.concat(chunk.results || []);
  }

  const rankCounts = { Inactive: 0, Bronze: 0, Silver: 0, Gold: 0, Diamond: 0, Black: 0 };
  let totalSpendNeso = 0n;
  let errorCount = 0;

  for (const r of allResults) {
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

  const today = new Date().toISOString().slice(0, 10);
  const record = {
    date: today,
    checkedAt: new Date().toISOString(),
    nowMs: Number.isNaN(NOW_MS) ? null : NOW_MS,
    totalWallets: allResults.length,
    totalSpendNeso: totalSpendNeso.toString(),
    rankCounts,
    errorCount,
    results: allResults,
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
    `Merged into ${allResults.length} total wallets. Total spend: ${totalSpendNeso.toString()} NESO. ` +
    `${errorCount} error(s).`
  );
  console.log("Rank counts:", rankCounts);
}

main();
