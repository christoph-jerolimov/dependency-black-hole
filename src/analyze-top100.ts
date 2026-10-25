/**
 * Analyze the ~100 most downloaded npm packages: fetch live weekly download
 * counts, resolve each package's full dependency tree (lockfile-only, no
 * real install) and report direct / direct+indirect dependency counts.
 *
 * Usage:
 *   node src/analyze-top100.ts [options]
 *
 *   --sort name|direct|transitive   Sort column for the terminal table
 *   --asc / --desc / --limit N / --filter STR
 *   --concurrency N       Parallel npm resolutions (default: 8)
 *   --no-report           Skip writing results/top-100.{md,json}
 *
 * The candidate list lives in data/top-100-packages.json; the actual
 * ranking is refreshed from api.npmjs.org download counts on every run.
 * When api.npmjs.org is unreachable, the candidate list order is kept.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseSortFlags, renderPackagesTable, sortPackages } from "./lib/analyze.ts";
import { analyzePublishedPackage, fetchWeeklyDownloads, mapLimit, type PackageAnalysis } from "./lib/npm.ts";
import { writeReport } from "./lib/report.ts";
import { formatCount } from "./lib/table.ts";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const { sortOptions, rest } = parseSortFlags(process.argv.slice(2));
  let concurrency = 8;
  let report = true;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--no-report") report = false;
    else if (arg === "--concurrency" || arg.startsWith("--concurrency=")) {
      concurrency = Number(arg.includes("=") ? arg.split("=")[1] : rest[++i]);
    } else {
      console.log("Usage: node src/analyze-top100.ts [--sort name|direct|transitive] [--asc|--desc] [--limit N] [--filter STR] [--concurrency N] [--no-report]");
      if (arg !== "--help" && arg !== "-h") throw new Error(`Unknown option: ${arg}`);
      return;
    }
  }

  const data = JSON.parse(readFileSync(join(projectRoot, "data", "top-100-packages.json"), "utf8"));
  const names: string[] = data.packages;

  process.stderr.write("fetching weekly download counts from api.npmjs.org...\n");
  const downloads = await fetchWeeklyDownloads(names);
  if (downloads.size === 0) {
    process.stderr.write("api.npmjs.org unreachable; keeping the order of data/top-100-packages.json\n");
  }

  const results = await mapLimit(names, concurrency, analyzePublishedPackage, (done, total, name) => {
    process.stderr.write(`\rresolving dependency trees... ${done}/${total} (${name})\x1b[K`);
  });
  process.stderr.write("\r\x1b[K");

  // Rank by live weekly downloads; without download data the (stable) sort
  // keeps the candidate list order.
  const ranked: PackageAnalysis[] = [...results].sort(
    (a, b) => (downloads.get(b.name) ?? -1) - (downloads.get(a.name) ?? -1)
  );
  const rankOf = new Map(ranked.map((r, i) => [r.spec, i + 1]));

  console.log(renderPackagesTable(sortPackages(ranked.filter((r) => !r.error), sortOptions)));
  for (const failure of results.filter((r) => r.error)) {
    console.error(`error: could not analyze ${failure.spec}: ${failure.error}`);
  }

  if (report) {
    writeReport({
      title: "Dependency counts of the ~100 most downloaded npm packages",
      intro: [
        "How many packages do the most popular npm packages drag into your `node_modules`?",
        "The candidate list comes from public npm download rankings (see `data/top-100-packages.json`);",
        "ranks and weekly download counts are refreshed live from `api.npmjs.org` when reachable.",
      ].join("\n"),
      markdownPath: join(projectRoot, "results", "top-100.md"),
      jsonPath: join(projectRoot, "results", "top-100.json"),
      results: ranked,
      extraColumns: [
        { column: { header: "rank", align: "right" }, value: (r) => String(rankOf.get(r.spec) ?? "-") },
        {
          column: { header: "downloads/week", align: "right" },
          value: (r) => formatCount(downloads.get(r.name)),
        },
      ],
      generatedWith: "npm run analyze:top100",
    });
    console.error("\nwrote results/top-100.md and results/top-100.json");
  }
}

await main();
