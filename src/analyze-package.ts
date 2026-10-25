/**
 * Analyze published npm packages without installing them: resolve the full
 * dependency tree via `npm install --package-lock-only` in a tmp dir and
 * report direct and direct+indirect dependency counts.
 *
 * Usage:
 *   node src/analyze-package.ts <package[@version]> [more packages...] [options]
 *
 *   --sort name|direct|transitive   Sort column (default: transitive)
 *   --asc / --desc        Sort direction
 *   --limit N / --filter STR
 *   --concurrency N       Parallel npm resolutions (default: 8)
 *   --json                Output JSON instead of a table
 *
 * Example:
 *   node src/analyze-package.ts express jest webpack is-odd
 */

import process from "node:process";
import { parseSortFlags, renderPackagesTable, sortPackages } from "./lib/analyze.ts";
import { analyzePublishedPackage, mapLimit } from "./lib/npm.ts";

async function main(): Promise<void> {
  const { sortOptions, rest } = parseSortFlags(process.argv.slice(2));
  let concurrency = 8;
  let json = false;
  const specs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") json = true;
    else if (arg === "--concurrency" || arg.startsWith("--concurrency=")) {
      concurrency = Number(arg.includes("=") ? arg.split("=")[1] : rest[++i]);
    } else if (arg === "--help" || arg === "-h" || arg.startsWith("--")) {
      console.log("Usage: node src/analyze-package.ts <package[@version]>... [--sort name|direct|transitive] [--asc|--desc] [--concurrency N] [--json]");
      if (arg.startsWith("--") && arg !== "--help" && arg !== "-h") throw new Error(`Unknown option: ${arg}`);
      return;
    } else specs.push(arg);
  }
  if (specs.length === 0) {
    console.error("No packages given. Example: node src/analyze-package.ts express react webpack");
    process.exitCode = 1;
    return;
  }

  const results = await mapLimit(specs, concurrency, analyzePublishedPackage, (done, total, spec) => {
    if (!json) process.stderr.write(`\rresolving dependency trees... ${done}/${total} (${spec})\x1b[K`);
  });
  if (!json) process.stderr.write("\r\x1b[K");

  const failed = results.filter((r) => r.error);
  const ok = results.filter((r) => !r.error);

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.log(renderPackagesTable(sortPackages(ok, sortOptions)));
  for (const failure of failed) {
    console.error(`\nerror: could not analyze ${failure.spec}: ${failure.error}`);
    process.exitCode = 1;
  }
}

await main();
