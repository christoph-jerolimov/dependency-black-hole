/**
 * Analyze a package-lock.json or yarn.lock: for every package in the
 * lockfile, show how many direct dependencies and how many total
 * (direct + indirect) dependencies it has.
 *
 * Usage:
 *   node src/analyze-lockfile.ts [path] [options]
 *
 *   path                  Lockfile or directory containing one (default: cwd)
 *   --sort name|direct|transitive   Sort column (default: transitive)
 *   --asc / --desc        Sort direction (default: desc, name defaults to asc)
 *   --limit N             Show only the first N rows
 *   --filter STR          Only show packages whose name contains STR
 *   --include-peers       Follow peerDependencies edges too
 *   --json                Output JSON instead of a table
 */

import process from "node:process";
import { analyzeLockfile, parseSortFlags, renderPackagesTable, sortPackages } from "./lib/analyze.ts";

function main(): void {
  const { sortOptions, rest } = parseSortFlags(process.argv.slice(2));
  let includePeers = false;
  let json = false;
  const paths: string[] = [];
  for (const arg of rest) {
    if (arg === "--include-peers") includePeers = true;
    else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node src/analyze-lockfile.ts [path] [--sort name|direct|transitive] [--asc|--desc] [--limit N] [--filter STR] [--include-peers] [--json]");
      return;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      paths.push(arg);
    }
  }

  const target = paths[0] ?? process.cwd();
  const analysis = analyzeLockfile(target, { includePeers });
  const packages = sortPackages(analysis.packages, sortOptions);

  if (json) {
    console.log(JSON.stringify({ lockfile: analysis.lockfilePath, kind: analysis.kind, packages }, null, 2));
    return;
  }

  console.log(`Lockfile: ${analysis.lockfilePath} (${analysis.kind})`);
  const uniqueNames = new Set(analysis.packages.filter((p) => !p.isRoot).map((p) => p.name));
  const instances = analysis.packages.filter((p) => !p.isRoot).length;
  console.log(`Packages: ${uniqueNames.size} unique names, ${instances} name@version instances\n`);
  console.log(renderPackagesTable(packages));
  if (sortOptions.limit !== undefined && analysis.packages.length > packages.length) {
    console.log(`\n(${analysis.packages.length - packages.length} more rows hidden; raise --limit to see them)`);
  }
  for (const warning of analysis.warnings) console.warn(`\nwarning: ${warning}`);
}

main();
