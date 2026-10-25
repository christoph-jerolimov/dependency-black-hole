/**
 * Analyze all packages of a Backstage release: fetch the package list from
 * the backstage/versions repo (served at versions.backstage.io), resolve
 * each package's dependency tree (lockfile-only, no real install) and
 * report direct / direct+indirect dependency counts.
 *
 * Usage:
 *   node src/analyze-backstage.ts [options]
 *
 *   --release VERSION     Backstage release, e.g. 1.56.2 (default: latest)
 *   --sort name|direct|transitive   Sort column for the terminal table
 *   --asc / --desc / --limit N / --filter STR
 *   --concurrency N       Parallel npm resolutions (default: 8)
 *   --no-report           Skip writing results/backstage.{md,json}
 */

import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseSortFlags, renderPackagesTable, sortPackages } from "./lib/analyze.ts";
import { analyzePublishedPackage, mapLimit } from "./lib/npm.ts";
import { writeReport } from "./lib/report.ts";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface BackstageManifest {
  releaseVersion: string;
  packages: { name: string; version: string }[];
}

/**
 * The backstage/versions repo (github.com/backstage/versions) contains one
 * manifest per release under v1/releases/<version>/manifest.json. The repo
 * is served at https://versions.backstage.io, which additionally exposes
 * moving tags (v1/tags/{main,next}/manifest.json) pointing at the latest
 * release; raw.githubusercontent.com is used as fallback source.
 */
const RAW_BASE = "https://raw.githubusercontent.com/backstage/versions/master";

async function tryFetchJson(url: string, errors: string[]): Promise<any | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      errors.push(`${url} -> HTTP ${res.status}`);
      return undefined;
    }
    return await res.json();
  } catch (error) {
    errors.push(`${url} -> ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

/** Find the newest release in the repo by probing version numbers upward. */
async function probeLatestRelease(): Promise<string | undefined> {
  const exists = async (version: string): Promise<boolean> => {
    try {
      const res = await fetch(`${RAW_BASE}/v1/releases/${version}/manifest.json`, { method: "HEAD" });
      return res.ok;
    } catch {
      return false;
    }
  };
  if (!(await exists("1.41.0"))) return undefined; // known-good floor; network is probably down
  let minor = 41;
  while (await exists(`1.${minor + 1}.0`)) minor++;
  let patch = 0;
  while (await exists(`1.${minor}.${patch + 1}`)) patch++;
  return `1.${minor}.${patch}`;
}

async function fetchManifest(release?: string): Promise<BackstageManifest> {
  const errors: string[] = [];
  if (release) {
    const manifest =
      (await tryFetchJson(`https://versions.backstage.io/v1/releases/${release}/manifest.json`, errors)) ??
      (await tryFetchJson(`${RAW_BASE}/v1/releases/${release}/manifest.json`, errors));
    if (manifest) return manifest as BackstageManifest;
  } else {
    // Latest release: the moving "main" tag only exists on the website.
    const manifest = await tryFetchJson("https://versions.backstage.io/v1/tags/main/manifest.json", errors);
    if (manifest) return manifest as BackstageManifest;
    const latest = await probeLatestRelease();
    if (latest) {
      process.stderr.write(`versions.backstage.io unreachable; using latest release found on GitHub: ${latest}\n`);
      const fallback = await tryFetchJson(`${RAW_BASE}/v1/releases/${latest}/manifest.json`, errors);
      if (fallback) return fallback as BackstageManifest;
    }
  }
  throw new Error(`Could not fetch Backstage release manifest:\n  ${errors.join("\n  ")}`);
}

async function main(): Promise<void> {
  const { sortOptions, rest } = parseSortFlags(process.argv.slice(2));
  let concurrency = 8;
  let report = true;
  let release: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--no-report") report = false;
    else if (arg === "--release" || arg.startsWith("--release=")) {
      release = arg.includes("=") ? arg.split("=")[1] : rest[++i];
    } else if (arg === "--concurrency" || arg.startsWith("--concurrency=")) {
      concurrency = Number(arg.includes("=") ? arg.split("=")[1] : rest[++i]);
    } else {
      console.log("Usage: node src/analyze-backstage.ts [--release VERSION] [--sort name|direct|transitive] [--asc|--desc] [--limit N] [--filter STR] [--concurrency N] [--no-report]");
      if (arg !== "--help" && arg !== "-h") throw new Error(`Unknown option: ${arg}`);
      return;
    }
  }

  process.stderr.write("fetching Backstage release manifest...\n");
  const manifest = await fetchManifest(release);
  const specs = manifest.packages.map((p) => `${p.name}@${p.version}`);
  process.stderr.write(`release ${manifest.releaseVersion}: ${specs.length} packages\n`);

  const results = await mapLimit(specs, concurrency, analyzePublishedPackage, (done, total, spec) => {
    process.stderr.write(`\rresolving dependency trees... ${done}/${total} (${spec})\x1b[K`);
  });
  process.stderr.write("\r\x1b[K");

  console.log(renderPackagesTable(sortPackages(results.filter((r) => !r.error), sortOptions)));
  for (const failure of results.filter((r) => r.error)) {
    console.error(`error: could not analyze ${failure.spec}: ${failure.error}`);
  }

  if (report) {
    writeReport({
      title: `Dependency counts of all Backstage packages (release ${manifest.releaseVersion})`,
      intro: [
        `Dependency footprint of every package in Backstage release **${manifest.releaseVersion}**.`,
        "The package list comes from the [backstage/versions](https://github.com/backstage/versions) release manifests",
        "(fetched from https://versions.backstage.io).",
      ].join("\n"),
      markdownPath: join(projectRoot, "results", "backstage.md"),
      jsonPath: join(projectRoot, "results", "backstage.json"),
      results: [...results].sort((a, b) => b.transitive - a.transitive),
      generatedWith: "npm run analyze:backstage",
    });
    console.error("\nwrote results/backstage.md and results/backstage.json");
  }
}

await main();
